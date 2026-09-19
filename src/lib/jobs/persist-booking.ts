import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  activities,
  customers,
  jobs,
  properties,
  tenancies,
} from "@/lib/db/schema";
import { initialStatus } from "./lifecycle";
import { resolvePrice } from "@/lib/pricing/resolve";
import { buildPriceSnapshot } from "@/lib/pricing/snapshot";
import type { ProductId } from "@/lib/booking/products";
import type { customerTypes } from "@/lib/booking/schema";

/** Derived locally rather than exported from V1, which stays untouched. */
type CustomerType = (typeof customerTypes)[number];

/**
 * Recording a website booking in the V2 database.
 *
 * **This is the only place V2 touches the live consumer booking path**, and it
 * runs last: by the time it is called the Google Calendar event exists, the
 * hold has been released and both emails have been attempted. The appointment
 * is already real and already confirmed to the customer.
 *
 * So the single rule this module exists to honour is that **it cannot fail a
 * booking**. It never throws. Every failure — no database, a dropped
 * connection, a constraint nobody anticipated — comes back as a value the
 * caller may ignore, exactly as `sendBookingConfirmation` already does. A
 * booking that is not recorded is a reconciliation job; a booking that is
 * refused because a database was unreachable is a lost customer.
 *
 * It is also idempotent. A retried or double-submitted booking finds the
 * existing job by its idempotency key and **writes nothing at all** — not the
 * job, not the customer, not the property. The unique index on
 * `job.idempotency_key` is the backstop for the case where two requests race
 * past that check.
 *
 * **All of it, or none of it.** The customer, the property, the tenancy, the
 * job and its first timeline entry go in one `db.batch`, which the Neon HTTP
 * driver runs as a single transaction. They used to be five sequential
 * `await`s, so a failure after the second left a customer and a property with
 * no job attached to them — rows nothing would ever look at again and nothing
 * would clean up. The unique key covered duplicate *jobs* and never covered
 * that.
 *
 * The ids are generated here rather than by the database for the same reason:
 * a batch cannot feed one statement's `RETURNING` into the next, so the job
 * has to know its property's id before either row exists.
 *
 * The job insert deliberately does **not** say `onConflictDoNothing`. A
 * duplicate must abort the whole transaction, so the losing request of a race
 * leaves nothing behind at all; the violation is caught below and the loser
 * reads the winner.
 */

export type PersistBookingInput = {
  /** The V1 customer-facing reference, derived from the calendar event id. */
  reference: string;
  /** The submission's idempotency key. The uniqueness this relies on. */
  idempotencyKey: string;
  /** The event that already exists in Google Calendar. */
  calendarEventId: string;

  customerType: CustomerType;
  fullName: string;
  company?: string | null;
  email: string;
  phone: string;

  houseOrName: string;
  street: string;
  town?: string | null;
  postcode: string;
  accessNotes?: string | null;

  tenantName?: string | null;
  tenantPhone?: string | null;

  productId: ProductId;
  /** From `calculatePrice`. Null where the service does not price by appliance. */
  applianceCount: number | null;
  /** Chargeable appliances beyond those included. */
  extraAppliances: number;
  /** The per-appliance rate, in pounds, from the registry. */
  extraAppliancePrice: number;
  /** The server-derived total, in pounds. Never the figure the browser showed. */
  priceTotal: number;

  appointmentStart: Date;
  appointmentEnd: Date;
  durationMinutes: number;
};

export type PersistBookingResult =
  | { status: "created"; jobId: string }
  /** A retry. The job was already recorded and nothing was written. */
  | { status: "exists"; jobId: string }
  | { status: "not_configured" }
  | { status: "failed"; reason: string };

/**
 * Logs a failure.
 *
 * The reference and a category, and nothing else — never the customer, the
 * address, the connection string or the driver's message, any of which can
 * carry more than a log should hold. The reference is an opaque label that
 * grants nothing and is enough to find the booking in the calendar.
 */
function report(reference: string, reason: string): void {
  console.warn(`[persist-booking] failed (${reason}) for reference ${reference}`);
}

/** The booking form's hyphenated type, as the database enum spells it. */
function customerTypeColumn(
  type: CustomerType,
): (typeof customers.$inferInsert)["type"] {
  return type.replace("-", "_") as (typeof customers.$inferInsert)["type"];
}

export async function persistWebsiteBooking(
  input: PersistBookingInput,
): Promise<PersistBookingResult> {
  const db = getDb();
  if (!db) return { status: "not_configured" };

  try {
    /*
      A retry writes nothing.

      Checking here rather than relying on the unique index alone is what keeps
      a second submission from leaving a duplicate customer and property behind
      before the job insert is refused. The index still guards the race; this
      guards the ordinary case.
    */
    const [existing] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.idempotencyKey, input.idempotencyKey))
      .limit(1);

    if (existing) return { status: "exists", jobId: existing.id };

    const email = input.email.trim().toLowerCase();

    /*
      Find or create the customer.

      Matched on email among consumer records only — `agent_organisation_id IS
      NULL`. A landlord who also appears in a letting agent's portfolio is a
      different record with different ownership, and merging the two on a
      shared email address would put an agency's customer into the consumer
      pool.
    */
    const [foundCustomer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(eq(customers.email, email), isNull(customers.agentOrganisationId)),
      )
      .limit(1);

    const customerId = foundCustomer?.id ?? randomUUID();

    // Find or create the property. Same customer, same postcode, same address
    // line is the same property; anything else is a new one. A customer who
    // did not exist a moment ago cannot own one, so the lookup is skipped.
    const postcode = input.postcode.trim().toUpperCase();
    const [foundProperty] = foundCustomer
      ? await db
          .select({ id: properties.id })
          .from(properties)
          .where(
            and(
              eq(properties.customerId, customerId),
              eq(properties.postcode, postcode),
              eq(properties.houseOrName, input.houseOrName),
              eq(properties.street, input.street),
            ),
          )
          .limit(1)
      : [];

    const propertyId = foundProperty?.id ?? randomUUID();

    /*
      A tenancy only when the customer actually gave tenant details. An empty
      tenancy row would assert that somebody lives there and we know who, which
      is a different claim from "not applicable".
    */
    const tenancyId =
      input.tenantName || input.tenantPhone ? randomUUID() : null;

    /*
      The price snapshot.

      Resolved through the ordinary pricing path with no agreement, which is
      what a consumer booking is: the published list price. Building it the
      same way an agent job will be built means an invoice can explain a
      website booking with exactly the same code.
    */
    const resolved = resolvePrice({ productId: input.productId });
    const priceSnapshot = buildPriceSnapshot({
      resolved,
      applianceCount: input.applianceCount,
      extraAppliances: input.extraAppliances,
      extraAppliancePence: Math.round(input.extraAppliancePrice * 100),
    });

    const priceTotalPence = Math.round(input.priceTotal * 100);
    const jobId = randomUUID();

    // Order matters: a foreign key is checked as each statement runs, so the
    // customer must be written before the property that references it.
    const writes = [
      ...(foundCustomer
        ? []
        : [
            db.insert(customers).values({
              id: customerId,
              type: customerTypeColumn(input.customerType),
              name: input.fullName,
              company: input.company || null,
              email,
              phone: input.phone,
            }),
          ]),
      ...(foundProperty
        ? []
        : [
            db.insert(properties).values({
              id: propertyId,
              customerId,
              houseOrName: input.houseOrName,
              street: input.street,
              town: input.town || null,
              postcode,
              accessNotes: input.accessNotes || null,
            }),
          ]),
      ...(tenancyId
        ? [
            db.insert(tenancies).values({
              id: tenancyId,
              propertyId,
              name: input.tenantName || null,
              phone: input.tenantPhone || null,
            }),
          ]
        : []),
      db.insert(jobs).values({
        id: jobId,
        reference: input.reference,
        customerId,
        // The person who booked is the person who pays, for a website booking.
        billingCustomerId: customerId,
        propertyId,
        tenancyId,
        productId: input.productId,
        applianceCount: input.applianceCount,
        priceTotalPence,
        customerSnapshot: {
          type: input.customerType,
          name: input.fullName,
          company: input.company || null,
          email,
          phone: input.phone,
        },
        propertySnapshot: {
          houseOrName: input.houseOrName,
          street: input.street,
          town: input.town || null,
          postcode,
          accessNotes: input.accessNotes || null,
        },
        priceSnapshot,
        appointmentStart: input.appointmentStart,
        appointmentEnd: input.appointmentEnd,
        durationMinutes: input.durationMinutes,
        schedulingMethod: "self_booked",
        lifecycleStatus: initialStatus({ tenantWillSchedule: false }),
        calendarEventId: input.calendarEventId,
        // The event already exists — this runs after it was written. There is
        // nothing pending and nothing to retry.
        calendarSyncState: "synced",
        source: "website_self",
        idempotencyKey: input.idempotencyKey,
      }),
      db.insert(activities).values({
        jobId,
        propertyId,
        kind: "job.created",
        actor: "system",
        detail: { source: "website_self", reference: input.reference },
      }),
    ] as const;

    await db.batch(writes as unknown as Parameters<typeof db.batch>[0]);

    return { status: "created", jobId };
  } catch (error) {
    /*
      Two submissions racing past the check above. The unique index decides,
      the whole transaction is rolled back — so the loser leaves no customer
      and no property behind — and the loser reads the winner rather than
      reporting a failure.
    */
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "23505"
    ) {
      try {
        const [winner] = await db
          .select({ id: jobs.id })
          .from(jobs)
          .where(eq(jobs.idempotencyKey, input.idempotencyKey))
          .limit(1);
        if (winner) return { status: "exists", jobId: winner.id };
      } catch {
        // Fall through to the ordinary failure report.
      }
      report(input.reference, "duplicate_without_row");
      return { status: "failed", reason: "conflict_without_row" };
    }

    report(
      input.reference,
      error instanceof Error ? error.name : "unknown_error",
    );
    return { status: "failed", reason: "write_failed" };
  }
}
