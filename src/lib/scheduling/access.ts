import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  agentOrganisations,
  jobs,
  properties,
  schedulingTokens,
} from "@/lib/db/schema";
import { hashToken, isWellFormedToken } from "./token";
import { normaliseJobReference } from "@/lib/jobs/reference";
import { normalisePostcode } from "@/lib/address/format";
import { rateLimit } from "@/lib/booking/rate-limit";
import type { ProductId } from "@/lib/booking/products";

/**
 * Letting a tenant in.
 *
 * Two doors, one rule: **every failure looks the same.** Wrong token, expired
 * token, unknown reference, wrong postcode, job already scheduled — all return
 * `null`. Distinguishing them would turn either door into an oracle: a
 * reference is short enough to read down the phone, which is exactly why it is
 * not a secret and why a distinguishable "that reference exists but the
 * postcode is wrong" would be a way to enumerate BSCJ's customers.
 *
 * Neither door reveals anything until it has fully succeeded, and what it then
 * reveals is one job — see `TenantJobView`, which is deliberately narrow.
 *
 * **Open question, deliberately not answered here: tenancy replacement.** A
 * job holds `tenancy_id` and a frozen `property_snapshot.tenant` from the
 * moment it was created. If the agency later replaces the tenancy — the
 * household moved out — the job keeps pointing at the old one, and an
 * invitation link issued to the previous tenant keeps working until it
 * expires. Whether a replaced tenancy should revoke outstanding links, and
 * whether the new household should inherit the appointment or be invited
 * afresh, is a policy decision with a real cost either way: revoking strands a
 * tenant mid-booking, and not revoking leaves a former occupant able to see an
 * address they have left. It is recorded rather than decided — inventing an
 * answer in an access-control function is how a policy nobody agreed to ends
 * up being enforced.
 */

/** What a tenant may see. Everything absent from this is absent on purpose. */
export type TenantJobView = {
  jobId: string;
  reference: string;
  productId: ProductId;
  /** The property, as the tenant would recognise it. */
  address: string;
  postcode: string;
  /** Who asked for the work, where naming them helps the tenant trust it. */
  requestedBy: string | null;
  lifecycleStatus: string;
  appointmentStart: Date | null;
  appointmentEnd: Date | null;
};

/**
 * Deliberately not on the view: **price**, the landlord's identity and
 * contact, the agency's other properties, other tenants, other jobs, internal
 * notes, the access notes, and the scheduling token itself.
 */
function toView(row: {
  job: typeof jobs.$inferSelect;
  property: typeof properties.$inferSelect;
  organisationName: string | null;
}): TenantJobView {
  return {
    jobId: row.job.id,
    reference: row.job.reference,
    productId: row.job.productId as ProductId,
    address: [row.property.houseOrName, row.property.street, row.property.town]
      .filter(Boolean)
      .join(", "),
    postcode: row.property.postcode,
    requestedBy: row.organisationName,
    lifecycleStatus: row.job.lifecycleStatus,
    appointmentStart: row.job.appointmentStart,
    appointmentEnd: row.job.appointmentEnd,
  };
}

const SELECT = {
  job: jobs,
  property: properties,
  organisationName: agentOrganisations.name,
  /**
   * Whether the agency that commissioned the work is still an account.
   *
   * Read on **every** request rather than once at the door, for the same
   * reason `lib/auth/session.ts` re-reads a user's role from the database: a
   * session issued while an account was live must stop working when it is
   * suspended, not eight hours later when a cookie happens to expire.
   */
  organisationIsActive: agentOrganisations.isActive,
};

/** The statuses a tenant may act on. Anything else is not theirs to change. */
const SCHEDULABLE = ["tenant_outreach", "awaiting_tenant", "scheduled"];

/**
 * Whether this job is one a tenant may still act on.
 *
 * Two checks, and the second is the one that was missing. A suspended agency
 * must not be able to keep booking BSCJ's engineer through its tenants — the
 * account is the commercial relationship, and scheduling is the thing it buys.
 *
 * **Suspension refuses new scheduling. It does not cancel anything.** An
 * appointment a tenant has already been given stays in the diary and stays in
 * the calendar: a tenant is not a party to the agency's account, has no way to
 * know it was suspended, and would otherwise find an engineer simply not
 * arriving. Withdrawing existing work is a commercial decision for BSCJ to
 * take deliberately, job by job, not a side effect of a flag.
 *
 * Consumer work has no organisation and is unaffected.
 */
function tenantMayAct(row: {
  job: typeof jobs.$inferSelect;
  organisationIsActive: boolean | null;
}): boolean {
  if (!SCHEDULABLE.includes(row.job.lifecycleStatus)) return false;
  if (row.job.agentOrganisationId && row.organisationIsActive === false) {
    return false;
  }
  return true;
}

/**
 * Loads a job for a tenant who has already been let in.
 *
 * Takes the job id from the **session**, never from a URL. The session is
 * signed and names one job, so there is no id here an attacker chose.
 */
export async function loadTenantJob(
  jobId: string,
): Promise<TenantJobView | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select(SELECT)
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .leftJoin(
      agentOrganisations,
      eq(agentOrganisations.id, jobs.agentOrganisationId),
    )
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!row) return null;
  if (!tenantMayAct(row)) return null;

  return toView(row);
}

/**
 * Door one: a token from an invitation link.
 *
 * The token is compared **by hash**, so the value in the link is never in a
 * query and the row alone is not a working link. A token that has been
 * revoked, has expired, or belongs to a job that is no longer schedulable
 * fails exactly like one that never existed.
 *
 * `usedAt` is recorded but is deliberately **not** a refusal: a tenant who
 * opens the link, gets distracted, and comes back an hour later should not be
 * locked out of rescheduling. Single use would move the failure from "someone
 * stole the link" to "the tenant clicked twice", which is the common case.
 */
export async function accessByToken(
  token: string,
  now = new Date(),
): Promise<TenantJobView | null> {
  const db = getDb();
  if (!db) return null;
  // Cheap shape check before any store lookup.
  if (!isWellFormedToken(token)) return null;

  const [record] = await db
    .select({
      id: schedulingTokens.id,
      jobId: schedulingTokens.jobId,
      expiresAt: schedulingTokens.expiresAt,
      revokedAt: schedulingTokens.revokedAt,
    })
    .from(schedulingTokens)
    .where(eq(schedulingTokens.tokenHash, hashToken(token)))
    .limit(1);

  if (!record) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt <= now) return null;

  const view = await loadTenantJob(record.jobId);
  if (!view) return null;

  // Best effort. A missed timestamp is not a reason to refuse a tenant entry.
  try {
    await db
      .update(schedulingTokens)
      .set({ usedAt: now })
      .where(eq(schedulingTokens.id, record.id));
  } catch {
    // The link worked; the bookkeeping did not.
  }

  return view;
}

export type ReferenceAccessResult =
  | { status: "ok"; job: TenantJobView }
  /** Everything else. The caller shows one message for all of them. */
  | { status: "denied" }
  | { status: "rate_limited"; retryAfterSeconds: number };

/**
 * Door two: the reference from a letter, plus the property's postcode.
 *
 * The reference identifies; the postcode authorises. Neither alone is enough,
 * which is what keeps a reference — designed to be read aloud — from becoming
 * a credential.
 *
 * Rate limited twice over: **per caller** and **per reference**. The first
 * stops one machine sweeping many references; the second stops many machines
 * sweeping one, which a per-IP limit alone would miss entirely.
 */
export async function accessByReference(
  referenceInput: string,
  postcodeInput: string,
  clientKey: string,
): Promise<ReferenceAccessResult> {
  const reference = normaliseJobReference(referenceInput);
  const postcode = normalisePostcode(postcodeInput);

  /*
    Limits are taken before the shape is judged, so a malformed guess costs an
    attempt too. Otherwise the cheap rejection would be free to repeat.
  */
  const perClient = await rateLimit(
    `schedule-lookup:${clientKey}`,
    LOOKUP_LIMITS.perClient.limit,
    LOOKUP_LIMITS.perClient.windowSeconds,
  );
  if (!perClient.ok) {
    return {
      status: "rate_limited",
      retryAfterSeconds: perClient.retryAfterSeconds,
    };
  }

  if (reference) {
    const perReference = await rateLimit(
      `schedule-reference:${reference}`,
      LOOKUP_LIMITS.perReference.limit,
      LOOKUP_LIMITS.perReference.windowSeconds,
    );
    if (!perReference.ok) {
      return {
        status: "rate_limited",
        retryAfterSeconds: perReference.retryAfterSeconds,
      };
    }
  }

  if (!reference || !postcode) return { status: "denied" };

  const db = getDb();
  if (!db) return { status: "denied" };

  /*
    Both values in one `WHERE`. Looking the reference up first and then
    comparing the postcode would answer in measurably different times for a
    real reference and a fake one.
  */
  const [row] = await db
    .select(SELECT)
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .leftJoin(
      agentOrganisations,
      eq(agentOrganisations.id, jobs.agentOrganisationId),
    )
    .where(
      and(
        eq(jobs.reference, reference),
        eq(properties.postcode, postcode),
        // A consumer booking is not scheduled through this door. It already
        // has an appointment the customer chose themselves.
        isNull(jobs.cancelledAt),
      ),
    )
    .limit(1);

  if (!row) return { status: "denied" };
  if (!tenantMayAct(row)) return { status: "denied" };

  return { status: "ok", job: toView(row) };
}

/**
 * The limits.
 *
 * Deliberately tight. A tenant types this once from a letter; nobody legitimate
 * needs twenty attempts, and every extra attempt allowed is an extra guess.
 */
export const LOOKUP_LIMITS = {
  perClient: { limit: 10, windowSeconds: 600 },
  perReference: { limit: 5, windowSeconds: 600 },
} as const;
