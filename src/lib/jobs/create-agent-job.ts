import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  activities,
  customers,
  jobs,
  properties,
  schedulingTokens,
  tenancies,
} from "@/lib/db/schema";
import { generateJobReference } from "./reference";
import { initialStatus } from "./lifecycle";
import { createSchedulingToken } from "@/lib/scheduling/token";
import { loadAgreement } from "@/lib/pricing/agreement";
import { resolvePrice } from "@/lib/pricing/resolve";
import { buildPriceSnapshot } from "@/lib/pricing/snapshot";
import { calculatePrice } from "@/lib/booking/pricing";
import { productFor, type ProductId } from "@/lib/booking/products";

/**
 * An agency booking work against one of its own properties.
 *
 * **Everything that decides money, ownership or state is derived here.** The
 * caller passes an organisation that came from `requireAgent()`, a property id
 * and a service id; nothing else about the job is taken on the browser's word.
 * A submitted price, status, reference, organisation or snapshot is not read
 * at all — there is no parameter for one.
 *
 * The property is re-read under the organisation before anything is written,
 * so an id belonging to another agency matches nothing and the job is refused
 * without revealing whether it exists.
 *
 * **This creates a job, not an appointment.** The agent is asking for work;
 * choosing the time is the tenant's, through a link, in V2.3. So no slot is
 * held, no calendar event is written and no email is sent — the job lands in
 * `tenant_outreach`, which is the queue those things will be driven from.
 */

export type CreateAgentJobInput = {
  propertyId: string;
  productId: ProductId;
  applianceCount: number;
  /** The agency asked for this as soon as possible rather than naming a date. */
  requestedAsap: boolean;
  /** `YYYY-MM-DD`. Ignored when `requestedAsap`. */
  completeByDate: string | null;
  notes: string | null;
  /**
   * The submission's own key, from a hidden field that is stable for the life
   * of one rendered form. It only ever affects de-duplication, and it is
   * namespaced by organisation before it is stored so one agency's key can
   * never collide with — or probe for — another's.
   */
  submissionKey: string;
};

export type CreateAgentJobResult =
  | { status: "created"; jobId: string; reference: string }
  /** A retry of a submission that already succeeded. Nothing was written. */
  | { status: "exists"; jobId: string; reference: string }
  | { status: "not_found" }
  | { status: "not_configured" }
  | { status: "failed" };

/** Today in the booking timezone, which is what a deadline is measured in. */
function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * The stored idempotency key.
 *
 * Namespaced, because `job.idempotency_key` is unique across the whole table:
 * an unscoped key from one agency could otherwise collide with another's and
 * hand back a job they may not see.
 */
export function submissionIdempotencyKey(
  organisationId: string,
  submissionKey: string,
): string {
  return `portal:${organisationId}:${submissionKey}`;
}

export async function createAgentJob(
  organisationId: string,
  input: CreateAgentJobInput,
  actorUserId: string,
): Promise<CreateAgentJobResult> {
  const db = getDb();
  if (!db) return { status: "not_configured" };

  const idempotencyKey = submissionIdempotencyKey(
    organisationId,
    input.submissionKey,
  );

  try {
    /*
      A retry writes nothing. Checked before any insert rather than relying on
      the unique index alone, so a double click does not mint a second
      reference and a second scheduling token before being refused.
    */
    const [existing] = await db
      .select({ id: jobs.id, reference: jobs.reference })
      .from(jobs)
      .where(eq(jobs.idempotencyKey, idempotencyKey))
      .limit(1);

    if (existing) {
      return {
        status: "exists",
        jobId: existing.id,
        reference: existing.reference,
      };
    }

    // The property, its landlord and its current tenancy — all under this
    // organisation. Another agency's property id matches nothing.
    const [row] = await db
      .select({ property: properties, landlord: customers })
      .from(properties)
      .innerJoin(customers, eq(customers.id, properties.customerId))
      .where(
        and(
          eq(properties.id, input.propertyId),
          eq(properties.agentOrganisationId, organisationId),
          eq(properties.isActive, true),
        ),
      )
      .limit(1);

    if (!row) return { status: "not_found" };

    const [tenancy] = await db
      .select()
      .from(tenancies)
      .where(
        and(
          eq(tenancies.propertyId, input.propertyId),
          isNull(tenancies.endedOn),
        ),
      )
      .limit(1);

    // -- Price, entirely server-side ---------------------------------------
    const product = productFor(input.productId);
    const today = todayIso();

    const agreement = await loadAgreement(organisationId, today);
    const resolved = resolvePrice({
      productId: product.id,
      agreementId: agreement.agreementId,
      lines: agreement.lines,
      committedJobs: agreement.committedJobs,
    });

    // The appliance rule comes from the registry, not from the request: a
    // service that does not price by appliance cannot be made to.
    const breakdown = calculatePrice(input.applianceCount, product.id);
    const priceSnapshot = buildPriceSnapshot({
      resolved,
      applianceCount: product.appliancePricing
        ? breakdown.applianceCount
        : null,
      extraAppliances: breakdown.extraAppliances,
      extraAppliancePence: Math.round(product.extraAppliancePrice * 100),
    });

    // -- The job -----------------------------------------------------------
    const jobId = randomUUID();
    const reference = generateJobReference();
    const token = createSchedulingToken();

    /*
      A tenant chooses the time when there is one to ask. With no tenant on
      file the agency is providing access itself, so BSCJ arranges it directly
      — a different scheduling method, recorded rather than assumed.
    */
    const tenantWillSchedule = Boolean(tenancy && (tenancy.phone || tenancy.email));

    const writes = [
      db.insert(jobs).values({
        id: jobId,
        reference,
        agentOrganisationId: organisationId,
        customerId: row.landlord.id,
        // The landlord is billed for an agency job today. The columns are
        // separate so central agency billing is a feature, not a migration.
        billingCustomerId: row.landlord.id,
        propertyId: row.property.id,
        tenancyId: tenancy?.id ?? null,
        productId: product.id,
        applianceCount: product.appliancePricing
          ? breakdown.applianceCount
          : null,
        priceTotalPence: priceSnapshot.totalPence,
        customerSnapshot: {
          type: row.landlord.type,
          name: row.landlord.name,
          company: row.landlord.company,
          email: row.landlord.email,
          phone: row.landlord.phone,
        },
        propertySnapshot: {
          houseOrName: row.property.houseOrName,
          street: row.property.street,
          town: row.property.town,
          postcode: row.property.postcode,
          accessNotes: row.property.accessNotes,
          // The tenant as they were when the work was asked for. The live
          // tenancy row may be closed and replaced before the engineer attends.
          tenant: tenancy
            ? { name: tenancy.name, email: tenancy.email, phone: tenancy.phone }
            : null,
        },
        priceSnapshot,
        requestedAsap: input.requestedAsap,
        completeByDate: input.requestedAsap ? null : input.completeByDate,
        durationMinutes: product.durationMinutes,
        schedulingMethod: tenantWillSchedule ? "tenant_selected" : "admin_selected",
        // No appointment yet, so nothing to write to the calendar.
        lifecycleStatus: initialStatus({ tenantWillSchedule: true }),
        calendarSyncState: "not_required",
        source: "portal",
        idempotencyKey,
        createdBy: actorUserId,
      }),
      /*
        The token is minted with the job, in the same transaction, so a job can
        never exist without a way to invite its tenant. Only the hash is
        stored; the plain value is not returned to this caller either, because
        nothing in V2.2 sends anything — V2.3 will mint the invitation.
      */
      db.insert(schedulingTokens).values({
        jobId,
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt,
      }),
      db.insert(activities).values({
        jobId,
        propertyId: row.property.id,
        agentOrganisationId: organisationId,
        kind: "job.created",
        actor: `user:${actorUserId}`,
        detail: {
          source: "portal",
          reference,
          productId: product.id,
          requestedAsap: input.requestedAsap,
          // Business context, never the token and never a price the client sent.
          priceSource: priceSnapshot.source,
        },
      }),
    ] as const;

    // One transaction. A job without its token, or a token without its job,
    // is a state nothing downstream could make sense of.
    await db.batch(writes as unknown as Parameters<typeof db.batch>[0]);

    if (input.notes) {
      // Not part of the atomic core: a lost note is a smaller problem than a
      // refused job, and the note is commentary on a job that now exists.
      try {
        await db.insert(activities).values({
          jobId,
          agentOrganisationId: organisationId,
          kind: "job.note",
          actor: `user:${actorUserId}`,
          detail: { note: input.notes },
        });
      } catch {
        // The job is the record.
      }
    }

    return { status: "created", jobId, reference };
  } catch (error) {
    // Two submissions racing past the check above. The index decides, and the
    // loser reads the winner rather than reporting a failure.
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "23505"
    ) {
      const [winner] = await db
        .select({ id: jobs.id, reference: jobs.reference })
        .from(jobs)
        .where(eq(jobs.idempotencyKey, idempotencyKey))
        .limit(1);
      if (winner) {
        return {
          status: "exists",
          jobId: winner.id,
          reference: winner.reference,
        };
      }
    }
    return { status: "failed" };
  }
}

/**
 * What a job would cost, without creating one.
 *
 * The review step shows a price, and it has to be the same figure the job will
 * actually be written with — so it comes from the same resolution, not from
 * arithmetic repeated in the browser.
 */
export async function quoteAgentJob(
  organisationId: string,
  productId: ProductId,
  applianceCount: number,
): Promise<{ totalPence: number; source: string; listPricePence: number }> {
  const product = productFor(productId);
  const agreement = await loadAgreement(organisationId, todayIso());
  const resolved = resolvePrice({
    productId: product.id,
    agreementId: agreement.agreementId,
    lines: agreement.lines,
    committedJobs: agreement.committedJobs,
  });
  const breakdown = calculatePrice(applianceCount, product.id);
  const snapshot = buildPriceSnapshot({
    resolved,
    applianceCount: product.appliancePricing ? breakdown.applianceCount : null,
    extraAppliances: breakdown.extraAppliances,
    extraAppliancePence: Math.round(product.extraAppliancePrice * 100),
  });

  return {
    totalPence: snapshot.totalPence,
    source: snapshot.source,
    listPricePence: snapshot.listPricePence,
  };
}
