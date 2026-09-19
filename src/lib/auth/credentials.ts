import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { accountCredentials, agentOrganisations, appUsers } from "@/lib/db/schema";
import {
  createCredentialToken,
  hashCredentialToken,
  isWellFormedCredentialToken,
  type CredentialPurpose,
} from "./credential-token";

/**
 * Issuing, reading and spending account credentials.
 *
 * Four rules, and each is enforced here rather than trusted to a caller:
 *
 * - **Purpose-bound.** The purpose is inside the hash *and* in the `WHERE`.
 *   A reset token presented at the invitation door matches nothing twice over.
 * - **Expiring.** Checked in the same statement that spends the credential,
 *   not in a branch above it that a second caller could race past.
 * - **Single-use, atomically.** `redeemCredential` is one SQL statement. Two
 *   browsers submitting the same link at the same moment produce exactly one
 *   winner and one refusal — no read-then-write, no advisory lock.
 * - **Opening a link spends nothing.** `peekCredential` only reads. A link
 *   prefetched by a mail client, a scanner or a browser must still work when
 *   the person actually clicks it.
 *
 * A suspended user or a suspended organisation is refused at both doors. The
 * check lives in one `EXISTS` used by both, so "peek says yes, redeem says no"
 * cannot drift apart.
 *
 * **Nothing here logs a token.** The plain value is a parameter and a local;
 * it is never returned except by `issueCredential`, to exactly one caller.
 */

/** Anything that is not a UUID is not an id; Postgres would throw on it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether the account behind a credential may still be let in.
 *
 * A suspended user, or an agency user whose organisation has been suspended,
 * is refused — the same rule `currentIdentity` applies to a session, applied
 * to the door that creates one. Staff have no organisation, so the second
 * branch is skipped for them rather than failing them.
 */
const ACCOUNT_IS_LIVE = sql`EXISTS (
  SELECT 1 FROM ${appUsers} u
  LEFT JOIN ${agentOrganisations} o ON o.id = u.agent_organisation_id
  WHERE u.id = ${accountCredentials.userId}
    AND u.is_active
    AND (u.agent_organisation_id IS NULL OR o.is_active)
)`;

export type IssuedCredential = {
  credentialId: string;
  /** The plain token, for the one email it belongs in. Never stored. */
  token: string;
  expiresAt: Date;
};

/**
 * Mints a credential and records its hash.
 *
 * Deliberately **does not revoke earlier credentials of the same purpose.**
 * The outbox mints one per delivery attempt, and a first attempt that reported
 * a timeout may well have arrived — invalidating its link would break an
 * invitation somebody is already holding. They all expire on their own, and
 * redeeming any one of them revokes the rest in the same statement.
 *
 * Returns null rather than throwing on a database fault, because every caller
 * is already in a path that must not fail loudly: an outbox attempt records
 * the failure and retries, and a reset request answers generically either way.
 */
export async function issueCredential(input: {
  userId: string;
  purpose: CredentialPurpose;
  /** The administrator who caused it. Null for a self-service reset. */
  createdByUserId?: string | null;
  now?: Date;
}): Promise<IssuedCredential | null> {
  const db = getDb();
  if (!db || !UUID.test(input.userId)) return null;

  const minted = createCredentialToken(input.purpose, input.now);

  try {
    const [row] = await db
      .insert(accountCredentials)
      .values({
        userId: input.userId,
        purpose: input.purpose,
        tokenHash: minted.tokenHash,
        expiresAt: minted.expiresAt,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning({ id: accountCredentials.id });

    if (!row) return null;
    return {
      credentialId: row.id,
      token: minted.token,
      expiresAt: minted.expiresAt,
    };
  } catch {
    return null;
  }
}

/** Enough about a live credential to render the form behind it. */
export type CredentialView = {
  credentialId: string;
  userId: string;
  /** Shown so the person can see which account they are setting up. */
  email: string;
  name: string;
  purpose: CredentialPurpose;
  expiresAt: Date;
  /** Null for BSCJ staff. */
  organisationName: string | null;
};

/**
 * Reads a credential without spending it.
 *
 * **Null for every kind of failure** — malformed, unknown, expired, already
 * redeemed, revoked, wrong purpose, suspended account, no database. A caller
 * cannot tell them apart and neither can anyone probing, which is what stops
 * this becoming a way to find out whether an address has an account.
 */
export async function peekCredential(
  token: string,
  purpose: CredentialPurpose,
  now = new Date(),
): Promise<CredentialView | null> {
  const db = getDb();
  if (!db) return null;
  // Shape-checked before any store lookup, so a long or exotic value never
  // reaches the database at all.
  if (!isWellFormedCredentialToken(token)) return null;

  let tokenHash: string;
  try {
    tokenHash = hashCredentialToken(token, purpose);
  } catch {
    // No secret configured. Refusing is the only safe answer.
    return null;
  }

  try {
    const [row] = await db
      .select({
        credentialId: accountCredentials.id,
        userId: accountCredentials.userId,
        purpose: accountCredentials.purpose,
        expiresAt: accountCredentials.expiresAt,
        email: appUsers.email,
        name: appUsers.name,
        organisationName: agentOrganisations.name,
      })
      .from(accountCredentials)
      .innerJoin(appUsers, eq(appUsers.id, accountCredentials.userId))
      .leftJoin(
        agentOrganisations,
        eq(agentOrganisations.id, appUsers.agentOrganisationId),
      )
      .where(
        and(
          // The hash already carries the purpose; matching the column too
          // means the separation survives a future change to either one.
          eq(accountCredentials.tokenHash, tokenHash),
          eq(accountCredentials.purpose, purpose),
          isNull(accountCredentials.consumedAt),
          isNull(accountCredentials.revokedAt),
          sql`${accountCredentials.expiresAt} > ${now}`,
          ACCOUNT_IS_LIVE,
        ),
      )
      .limit(1);

    if (!row) return null;

    return {
      credentialId: row.credentialId,
      userId: row.userId,
      email: row.email,
      name: row.name,
      purpose: row.purpose,
      expiresAt: row.expiresAt,
      organisationName: row.organisationName,
    };
  } catch {
    return null;
  }
}

export type RedeemResult =
  | { status: "ok"; userId: string }
  /** Unknown, expired, already spent, revoked, wrong purpose, or suspended. */
  | { status: "refused" }
  | { status: "not_configured" };

/**
 * Spends a credential and sets the password, in one statement.
 *
 * **This is the only place a password is set from a link, and it is one
 * `UPDATE ... WITH`.** The alternatives were both wrong:
 *
 * - Check the credential, then write the password: two browsers submitting
 *   together both pass the check and both write, and the second one's
 *   password silently wins. A password set by a link somebody else redeemed
 *   is the failure this whole design exists to prevent.
 * - A batch: Drizzle's `batch` runs every statement, so a conditional consume
 *   matching no row would still be followed by a password write. The password
 *   has to be conditional on the consume, which means one statement.
 *
 * The CTE does four things and they succeed or fail together:
 *
 * 1. `claimed` spends the credential — but only if it is unspent, unrevoked,
 *    unexpired, of this purpose, and the account behind it is still live.
 * 2. `updated` writes the hash **only for the user `claimed` named**. An empty
 *    `claimed` makes the subquery NULL, which matches no row, so a refused
 *    redemption writes nothing.
 * 3. `session_version` is incremented in the same write, so every token issued
 *    before this moment stops working on its next request. A password change
 *    that leaves old sessions alive is not a password change.
 * 4. `revoked` stands down every other outstanding credential for that user,
 *    of either purpose. Once a password is set, an older invitation and a
 *    parallel reset request are both spare keys.
 */
export async function redeemCredential(input: {
  token: string;
  purpose: CredentialPurpose;
  /** Already hashed by `lib/auth/password.ts`. Never a plain password. */
  passwordHash: string;
  now?: Date;
}): Promise<RedeemResult> {
  const db = getDb();
  if (!db) return { status: "not_configured" };
  if (!isWellFormedCredentialToken(input.token)) return { status: "refused" };

  let tokenHash: string;
  try {
    tokenHash = hashCredentialToken(input.token, input.purpose);
  } catch {
    return { status: "refused" };
  }

  const now = input.now ?? new Date();

  try {
    const result = await db.execute<{ user_id: string | null }>(sql`
      WITH claimed AS (
        UPDATE account_credential AS c
        SET consumed_at = ${now}
        WHERE c.token_hash = ${tokenHash}
          AND c.purpose = ${input.purpose}
          AND c.consumed_at IS NULL
          AND c.revoked_at IS NULL
          AND c.expires_at > ${now}
          AND EXISTS (
            SELECT 1 FROM app_user u
            LEFT JOIN agent_organisation o ON o.id = u.agent_organisation_id
            WHERE u.id = c.user_id
              AND u.is_active
              AND (u.agent_organisation_id IS NULL OR o.is_active)
          )
        RETURNING c.id, c.user_id
      ),
      updated AS (
        UPDATE app_user
        SET password_hash = ${input.passwordHash},
            password_set_at = ${now},
            session_version = session_version + 1,
            updated_at = ${now}
        WHERE id = (SELECT user_id FROM claimed)
        RETURNING id
      ),
      revoked AS (
        UPDATE account_credential
        SET revoked_at = ${now}
        WHERE user_id = (SELECT user_id FROM claimed)
          AND id <> (SELECT id FROM claimed)
          AND consumed_at IS NULL
          AND revoked_at IS NULL
        RETURNING id
      )
      SELECT (SELECT id FROM updated) AS user_id
    `);

    const userId = result.rows[0]?.user_id ?? null;
    return userId ? { status: "ok", userId } : { status: "refused" };
  } catch {
    return { status: "refused" };
  }
}

/**
 * Stands down every outstanding credential for a user.
 *
 * Used when an administrator suspends an account, and when they deliberately
 * cancel an invitation. Rows are revoked rather than deleted: that an
 * invitation was issued and withdrawn is exactly the kind of thing the
 * security log has to be able to answer later.
 */
export async function revokeCredentials(
  userId: string,
  purpose?: CredentialPurpose,
  now = new Date(),
): Promise<number> {
  const db = getDb();
  if (!db || !UUID.test(userId)) return 0;

  try {
    const revoked = await db
      .update(accountCredentials)
      .set({ revokedAt: now })
      .where(
        and(
          eq(accountCredentials.userId, userId),
          purpose ? eq(accountCredentials.purpose, purpose) : undefined,
          isNull(accountCredentials.consumedAt),
          isNull(accountCredentials.revokedAt),
        ),
      )
      .returning({ id: accountCredentials.id });

    return revoked.length;
  } catch {
    return 0;
  }
}

/** Whether a user has an invitation outstanding. For the admin screen only. */
export async function countLiveCredentials(
  userId: string,
  purpose: CredentialPurpose,
  now = new Date(),
): Promise<number> {
  const db = getDb();
  if (!db || !UUID.test(userId)) return 0;

  try {
    const rows = await db
      .select({ id: accountCredentials.id })
      .from(accountCredentials)
      .where(
        and(
          eq(accountCredentials.userId, userId),
          eq(accountCredentials.purpose, purpose),
          isNull(accountCredentials.consumedAt),
          isNull(accountCredentials.revokedAt),
          sql`${accountCredentials.expiresAt} > ${now}`,
        ),
      );
    return rows.length;
  } catch {
    return 0;
  }
}
