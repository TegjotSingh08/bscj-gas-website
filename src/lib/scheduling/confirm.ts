import "server-only";

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { activities, jobs, outboundEmails, properties } from "@/lib/db/schema";
import { assertTransition, type JobLifecycleStatus } from "@/lib/jobs/lifecycle";
import { bookingConfigFor } from "@/lib/booking/config";
import { productFor, isProductId } from "@/lib/booking/products";
import { checkHold, releaseHold } from "@/lib/booking/holds";
import {
  countBookingsByDate,
  isDayFullyBooked,
  isSlotStillAvailable,
} from "@/lib/booking/slots";
import {
  acquireDailyBookingLock,
  releaseDailyBookingLock,
} from "@/lib/booking/daily-limit";
import { fetchBookingEvents, fetchBusyPeriods } from "@/lib/google/calendar";
import { isoDateInZone, parseIsoDate, zonedTimeToUtc } from "@/lib/booking/time";

/**
 * A tenant confirming an appointment.
 *
 * The tenant chooses **a time and nothing else**. The job, the property, the
 * service, the price and the organisation are all read from the row the
 * session names — none of them is a parameter here, so none can be submitted.
 *
 * Availability is revalidated from Google immediately before the write, the
 * hold is rechecked against the caller's own token, and the daily cap is
 * counted under the same short lock the public booking route uses. A hold that
 * looks valid is never taken as permission on its own: the recheck is what
 * makes first-confirmed-wins true.
 *
 * **The calendar write is deliberately outside the transaction.** Postgres
 * cannot make a Google API call atomic, so the job is committed as `scheduled`
 * with `calendar_sync_state = 'pending'` and the event is written after. A
 * failure leaves a retryable row, not a lost appointment — and never a tenant
 * told their booking failed after it succeeded.
 */

export type ConfirmInput = {
  /** From the signed session. Never from a form. */
  jobId: string;
  slotStart: string;
  holdToken: string;
};

export type ConfirmResult =
  | { status: "confirmed"; start: Date; end: Date }
  /** Already scheduled at this time. A retry, not a second appointment. */
  | { status: "already"; start: Date; end: Date }
  | { status: "hold_expired" }
  | { status: "slot_taken" }
  | { status: "day_full" }
  | { status: "not_schedulable" }
  | { status: "unavailable" }
  | { status: "not_found" };

/**
 * A deterministic calendar event id for a job.
 *
 * Derived from the job and the slot, so a retry produces the same id and
 * Google refuses the duplicate rather than creating a second event. Google
 * requires characters in [a-v0-9]; hex satisfies that.
 */
export function calendarEventIdForJob(jobId: string, slotStartIso: string): string {
  const digest = createHash("sha256")
    .update(`job|${jobId}|${new Date(slotStartIso).toISOString()}`)
    .digest("hex");
  return `bscj${digest}`.slice(0, 60);
}

/** The statuses from which a tenant may set a time. */
const SCHEDULABLE: JobLifecycleStatus[] = [
  "tenant_outreach",
  "awaiting_tenant",
  "scheduled",
];

export async function confirmTenantAppointment(
  input: ConfirmInput,
): Promise<ConfirmResult> {
  const db = getDb();
  if (!db) return { status: "unavailable" };

  const [job] = await db
    .select({
      id: jobs.id,
      productId: jobs.productId,
      lifecycleStatus: jobs.lifecycleStatus,
      appointmentStart: jobs.appointmentStart,
      appointmentEnd: jobs.appointmentEnd,
      agentOrganisationId: jobs.agentOrganisationId,
      propertyId: jobs.propertyId,
    })
    .from(jobs)
    .where(eq(jobs.id, input.jobId))
    .limit(1);

  if (!job) return { status: "not_found" };
  if (!SCHEDULABLE.includes(job.lifecycleStatus as JobLifecycleStatus)) {
    return { status: "not_schedulable" };
  }
  if (!isProductId(job.productId)) return { status: "unavailable" };

  const product = productFor(job.productId);
  const config = bookingConfigFor(product.id);

  const start = new Date(input.slotStart);
  if (Number.isNaN(start.getTime())) return { status: "slot_taken" };
  const end = new Date(start.getTime() + product.durationMinutes * 60000);

  /*
    A retry that arrives after the job was already scheduled at this very time
    is not a second appointment. Checked before the hold, because confirming
    releases the hold — without this the second click would be reported as an
    expired reservation.
  */
  if (
    job.lifecycleStatus === "scheduled" &&
    job.appointmentStart &&
    job.appointmentStart.getTime() === start.getTime()
  ) {
    return {
      status: "already",
      start: job.appointmentStart,
      end: job.appointmentEnd ?? end,
    };
  }

  // The reservation must still exist, belong to this attempt, and match this
  // slot. The browser carries an opaque token; ownership is decided here.
  const hold = await checkHold(input.slotStart, input.holdToken);
  if (hold.status === "expired" || hold.status === "mismatch") {
    return { status: "hold_expired" };
  }
  // `unavailable` means the store could not be reached, not that the slot is
  // free. The Google recheck below is what keeps that safe, and it is never
  // skipped.

  const bookingDate = isoDateInZone(start, config.timeZone);
  const dayLock = await acquireDailyBookingLock(bookingDate);

  try {
    const windowStart = new Date(start.getTime() - 24 * 60 * 60000);
    const windowEnd = new Date(start.getTime() + 24 * 60 * 60000);

    const day = parseIsoDate(bookingDate);
    if (!day) return { status: "unavailable" };
    const dayStart = zonedTimeToUtc({ ...day, hour: 0, minute: 0 }, config.timeZone);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60000);

    const [busy, bookings] = await Promise.all([
      fetchBusyPeriods(windowStart, windowEnd),
      fetchBookingEvents(dayStart, dayEnd),
    ]);
    const bookingCounts = countBookingsByDate(bookings, config);

    if (isDayFullyBooked(bookingCounts, bookingDate, config)) {
      return { status: "day_full" };
    }
    if (
      !isSlotStillAvailable(input.slotStart, busy, new Date(), config, bookingCounts)
    ) {
      return { status: "slot_taken" };
    }

    // The lifecycle rule decides whether this move is legal, not this function.
    assertTransition(job.lifecycleStatus as JobLifecycleStatus, "scheduled");

    /*
      Guarded by the status it expects to find. Two confirmations racing past
      the checks above both reach here; the first moves the row out of
      `tenant_outreach` and the second updates nothing.
    */
    const updated = await db
      .update(jobs)
      .set({
        appointmentStart: start,
        appointmentEnd: end,
        durationMinutes: product.durationMinutes,
        lifecycleStatus: "scheduled",
        schedulingMethod: "tenant_selected",
        // Intent recorded; the outcome is written by the sync below.
        calendarSyncState: "pending",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.id, job.id),
          eq(
            jobs.lifecycleStatus,
            job.lifecycleStatus as "tenant_outreach",
          ),
        ),
      )
      .returning({ id: jobs.id });

    if (updated.length === 0) {
      // Somebody else confirmed first. Report what the row now says rather
      // than inventing an outcome.
      const [current] = await db
        .select({
          appointmentStart: jobs.appointmentStart,
          appointmentEnd: jobs.appointmentEnd,
        })
        .from(jobs)
        .where(eq(jobs.id, job.id))
        .limit(1);

      if (
        current?.appointmentStart &&
        current.appointmentStart.getTime() === start.getTime()
      ) {
        return {
          status: "already",
          start: current.appointmentStart,
          end: current.appointmentEnd ?? end,
        };
      }
      return { status: "slot_taken" };
    }

    await db.insert(activities).values({
      jobId: job.id,
      propertyId: job.propertyId,
      agentOrganisationId: job.agentOrganisationId,
      kind: "appointment.scheduled",
      actor: "tenant",
      detail: { start: start.toISOString(), end: end.toISOString() },
    });

    /*
      The intent to tell people, recorded durably. Sending is the drain's job
      in V2.6 — so a mail outage cannot reach this transaction at all, and a
      unique key means a retry re-sends nothing that already went.
    */
    try {
      await db.insert(outboundEmails).values({
        jobId: job.id,
        kind: "tenant-appointment-confirmation",
        recipient: "tenant",
        idempotencyKey: `appointment:${job.id}:${start.toISOString()}`,
      }).onConflictDoNothing();
    } catch {
      // A queued message is not the appointment.
    }

    // The reservation has done its job: the appointment is now a real row.
    try {
      await releaseHold(input.slotStart, input.holdToken, product.id);
    } catch {
      // A hold that cannot be given back simply expires on its TTL.
    }

    return { status: "confirmed", start, end };
  } finally {
    if (dayLock.status === "acquired") {
      await releaseDailyBookingLock(bookingDate, dayLock.token);
    }
  }
}

/**
 * Writes the appointment to Google Calendar.
 *
 * Runs **after** the job is committed, and never fails the tenant's booking.
 * Idempotent by construction: the event id is derived from the job and the
 * slot, so a retry collides with the event it already created and Google
 * refuses the duplicate — which is recorded as success, because it is.
 *
 * Reuses `lib/google/calendar.ts` unchanged. There is no second calendar
 * client.
 */
export async function syncJobToCalendar(jobId: string): Promise<
  "synced" | "failed" | "not_required" | "not_found"
> {
  const db = getDb();
  if (!db) return "failed";

  const [row] = await db
    .select({ job: jobs, property: properties })
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!row) return "not_found";

  const { job, property } = row;
  if (
    job.lifecycleStatus !== "scheduled" ||
    !job.appointmentStart ||
    !job.appointmentEnd
  ) {
    return "not_required";
  }
  if (job.calendarSyncState === "synced" && job.calendarEventId) return "synced";
  if (!isProductId(job.productId)) return "failed";

  const product = productFor(job.productId);
  const address = [property.houseOrName, property.street, property.town]
    .filter(Boolean)
    .join(", ");
  const eventId = calendarEventIdForJob(
    job.id,
    job.appointmentStart.toISOString(),
  );

  // Imported here rather than at the top so the module that decides state does
  // not drag the Google client into every caller that only reads it.
  const { createEvent, DuplicateBookingError } = await import(
    "@/lib/google/calendar"
  );

  try {
    await createEvent({
      eventId,
      summary: `${product.calendarName} — ${address}`,
      description: [
        `Service: ${product.name}`,
        `Reference: ${job.reference}`,
        `Property: ${address}, ${property.postcode}`,
        `Access notes: ${property.accessNotes ?? "none given"}`,
        "",
        "Booked by the tenant through the BSCJ portal.",
      ].join("\n"),
      location: `${address}, ${property.postcode}`,
      start: job.appointmentStart,
      end: job.appointmentEnd,
    });
  } catch (error) {
    // The event already exists — this is a retry of a write that worked.
    if (!(error instanceof DuplicateBookingError)) {
      await db
        .update(jobs)
        .set({ calendarSyncState: "failed", updatedAt: new Date() })
        .where(eq(jobs.id, job.id));
      return "failed";
    }
  }

  await db
    .update(jobs)
    .set({
      calendarEventId: eventId,
      calendarSyncState: "synced",
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));

  return "synced";
}
