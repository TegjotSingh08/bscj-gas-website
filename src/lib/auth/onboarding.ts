import "server-only";

import { createHash } from "node:crypto";

import { and, desc, eq, gt } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { agentOrganisations, appUsers, outboundEmails } from "@/lib/db/schema";
import { accountAccessRow, OUTBOX_KINDS } from "@/lib/notifications/kinds";
import { rateLimit } from "@/lib/booking/rate-limit";
import { normaliseEmail } from "./app-user";

/**
 * Raising an invitation or a reset.
 *
 * **Nothing here sends anything.** Each function writes one row to the durable
 * outbox and returns; the worker mints the credential and delivers it. That is
 * the same discipline as every other external call in V2, and it is what makes
 * "the account was opened but the email provider was down for a minute" a row
 * to retry rather than an administrator staring at a failed form.
 *
 * It is also why **no raw token exists in this module**. The credential is
 * minted at send time, inside the worker, and travels straight into the
 * message. Nothing here could log one if it tried.
 *
 * Two controls sit on top:
 *
 * - **A resend interval**, so an administrator leaning on the button does not
 *   queue five messages; and
 * - **Rate limits**, per account and per caller, so neither door becomes a way
 *   to post mail to somebody repeatedly.
 */

/** Anything that is not a UUID is not an id; Postgres would throw on it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How long to wait before another message of the same kind may be queued.
 *
 * Two minutes is the point at which "it has not arrived" stops being impatience
 * and starts being a real question — it is above the worker's own lease, so a
 * resend cannot be queued while the first is still mid-flight.
 */
export const RESEND_INTERVAL_SECONDS = 120;

/** What the callers can be told, and it is deliberately little. */
export type InviteResult =
  | { status: "queued" }
  /** One was queued recently. Not an error: the first one is on its way. */
  | { status: "too_soon"; retryAfterSeconds: number }
  | { status: "not_found" }
  | { status: "not_configured" }
  | { status: "failed" };

type AccountKind =
  | typeof OUTBOX_KINDS.accountInvitation
  | typeof OUTBOX_KINDS.passwordReset;

/**
 * When the last message of this kind was queued for this account.
 *
 * Read from the outbox rather than kept in a counter, because the outbox is
 * the durable record and a counter in Redis would forget across a restart —
 * which is precisely when somebody is pressing the button repeatedly.
 */
async function lastQueuedAt(
  db: NonNullable<ReturnType<typeof getDb>>,
  userId: string,
  kind: AccountKind,
  since: Date,
): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: outboundEmails.createdAt })
    .from(outboundEmails)
    .where(
      and(
        eq(outboundEmails.appUserId, userId),
        eq(outboundEmails.kind, kind),
        gt(outboundEmails.createdAt, since),
      ),
    )
    .orderBy(desc(outboundEmails.createdAt))
    .limit(1);

  return row?.createdAt ?? null;
}

/**
 * Queues one account-access message, if the interval allows it.
 *
 * Shared by both doors so the interval, the key and the row shape cannot drift
 * apart between an invitation and a reset.
 */
async function queueAccountAccess(
  userId: string,
  kind: AccountKind,
  now: Date,
): Promise<InviteResult> {
  const db = getDb();
  if (!db) return { status: "not_configured" };

  try {
    const since = new Date(now.getTime() - RESEND_INTERVAL_SECONDS * 1000);
    const recent = await lastQueuedAt(db, userId, kind, since);
    if (recent) {
      const elapsed = Math.floor((now.getTime() - recent.getTime()) / 1000);
      return {
        status: "too_soon",
        retryAfterSeconds: Math.max(1, RESEND_INTERVAL_SECONDS - elapsed),
      };
    }

    const row = accountAccessRow({ userId, kind, issuedAt: now });
    await db
      .insert(outboundEmails)
      .values({
        jobId: null,
        appUserId: row.appUserId,
        kind: row.kind,
        recipient: row.recipient,
        idempotencyKey: row.idempotencyKey,
      })
      /*
        The key carries the instant, so a genuine collision means two requests
        landed in the same millisecond. Doing nothing is right: one message was
        queued, which is what was asked for.
      */
      .onConflictDoNothing({ target: outboundEmails.idempotencyKey });

    return { status: "queued" };
  } catch {
    return { status: "failed" };
  }
}

/**
 * Invites a user to set their first password. Administrator-only.
 *
 * Refuses an account that already has a password: what that person wants is a
 * reset, and issuing an invitation instead would be a second live credential
 * for an account already in use.
 *
 * The caller has already been checked by `requireAdmin()`. This does not
 * re-check it — a guard buried in a query is a guard nobody can see.
 */
export async function inviteUser(input: {
  userId: string;
  now?: Date;
}): Promise<InviteResult> {
  const db = getDb();
  if (!db) return { status: "not_configured" };
  if (!UUID.test(input.userId)) return { status: "not_found" };

  const now = input.now ?? new Date();

  try {
    const [user] = await db
      .select({
        id: appUsers.id,
        isActive: appUsers.isActive,
        passwordSetAt: appUsers.passwordSetAt,
        organisationId: appUsers.agentOrganisationId,
        organisationIsActive: agentOrganisations.isActive,
      })
      .from(appUsers)
      .leftJoin(
        agentOrganisations,
        eq(agentOrganisations.id, appUsers.agentOrganisationId),
      )
      .where(eq(appUsers.id, input.userId))
      .limit(1);

    if (!user || !user.isActive) return { status: "not_found" };
    if (user.organisationId && !user.organisationIsActive) {
      // Inviting somebody into a suspended agency would send a link to a door
      // that is locked. Reported as not_found: the administrator can see the
      // suspension on the same screen.
      return { status: "not_found" };
    }
    if (user.passwordSetAt) return { status: "not_found" };

    /*
      A per-account limit above the interval, so a script driving the action
      cannot post a hundred messages over an afternoon by waiting two minutes
      between each. Ten invitations to one account in a day is already far more
      than any real onboarding needs.
    */
    const limited = await rateLimit(
      `invite:${input.userId}`,
      10,
      24 * 60 * 60,
    );
    if (!limited.ok) {
      return { status: "too_soon", retryAfterSeconds: limited.retryAfterSeconds };
    }

    return queueAccountAccess(input.userId, OUTBOX_KINDS.accountInvitation, now);
  } catch {
    return { status: "failed" };
  }
}

/**
 * Asks for a password reset, from the public form.
 *
 * **Always returns the same thing.** Unknown address, suspended account,
 * suspended agency, an account that has never set a password, a rate limit, a
 * database fault — every one of them answers `{ status: "accepted" }`, and the
 * page says the same sentence either way. Anything else turns this form into a
 * way to find out who has an account.
 *
 * The rate limit is applied to the *address* as well as to the caller, so
 * somebody rotating through proxies still cannot post mail to one person
 * repeatedly. The address is hashed into the key rather than used raw, because
 * a rate-limit key ends up in a store somebody may one day read.
 */
export async function requestPasswordReset(input: {
  email: string;
  /** For the per-caller limit. Usually the forwarded IP. */
  callerKey: string;
  now?: Date;
}): Promise<{ status: "accepted" }> {
  const now = input.now ?? new Date();
  const email = normaliseEmail(input.email);

  const accepted = { status: "accepted" } as const;

  const db = getDb();
  if (!db) return accepted;

  try {
    /*
      Per caller first, because it is the cheaper of the two and the one that
      stops a sweep through a list of addresses.
    */
    const perCaller = await rateLimit(`reset-ip:${input.callerKey}`, 10, 60 * 60);
    if (!perCaller.ok) return accepted;

    const perAddress = await rateLimit(`reset-address:${keyFor(email)}`, 5, 60 * 60);
    if (!perAddress.ok) return accepted;

    const [user] = await db
      .select({
        id: appUsers.id,
        isActive: appUsers.isActive,
        passwordSetAt: appUsers.passwordSetAt,
        organisationId: appUsers.agentOrganisationId,
        organisationIsActive: agentOrganisations.isActive,
      })
      .from(appUsers)
      .leftJoin(
        agentOrganisations,
        eq(agentOrganisations.id, appUsers.agentOrganisationId),
      )
      .where(eq(appUsers.email, email))
      .limit(1);

    if (!user || !user.isActive) return accepted;
    if (user.organisationId && !user.organisationIsActive) return accepted;
    /*
      An account that has never set a password has an *invitation* outstanding,
      not a password to reset. Silently doing nothing is right: telling the
      caller would distinguish "invited" from "unknown", and quietly sending an
      invitation instead would let a stranger trigger one.
    */
    if (!user.passwordSetAt) return accepted;

    await queueAccountAccess(user.id, OUTBOX_KINDS.passwordReset, now);
    return accepted;
  } catch {
    return accepted;
  }
}

/**
 * A stable, non-reversible key for an address.
 *
 * A rate-limit key ends up in a store somebody may one day read, and a list of
 * the addresses that have asked for a reset is exactly the kind of thing that
 * should not be sitting in Redis in the clear. Truncated because 128 bits is
 * ample for a bucket name and the full digest buys nothing.
 */
function keyFor(email: string): string {
  return createHash("sha256").update(email).digest("hex").slice(0, 32);
}
