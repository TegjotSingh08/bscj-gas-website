import "server-only";

import { and, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";

/**
 * Appointments that are real but that Google does not show yet.
 *
 * Availability has always been computed from Google alone, and that was
 * correct while Google was the only place an appointment could exist. It is
 * not correct any more. A tenant confirmation commits the appointment to
 * Postgres and writes the calendar event **afterwards**, because a Google call
 * cannot be part of a Postgres transaction — so between the commit and the
 * write, and for as long as a failed write stays unrepaired, the slot is:
 *
 * - no longer held in Redis (the hold was released; it was only ever a
 *   30-minute convenience with a TTL, not a durable reservation), and
 * - not yet in Google.
 *
 * Which meant it was offered to the next customer who asked. Keeping the hold
 * longer cannot fix that — a hold expires, and the gap it would have to cover
 * is however long a failed sync waits for someone to notice. The durable
 * record is the `job` row, so this reads it.
 *
 * **Only `pending` and `failed` are counted.** A `synced` job is already in
 * Google, and counting it here as well would block its own slot twice and
 * spend two of the day's ten places on one appointment.
 */

/** Deliberately times only. No customer, no address, no reference. */
export type ReservedAppointment = { start: Date; end: Date };

export type ReservationLookup =
  | {
      status: "ok";
      reservations: ReservedAppointment[];
      /**
       * Calendar events these jobs have moved *away* from and not yet removed.
       *
       * A reschedule leaves the old event in Google until cleanup runs, so for
       * that window one job appears twice to anything counting: once as a
       * Google booking at the old time, once as a Postgres reservation at the
       * new one. On the same date that spends two of the day's ten places on
       * one visit and can close a day a slot early.
       *
       * The old event's *times* still block their slot, which is right — the
       * entry is really there and the engineer can really see it. Only the
       * **count** is corrected, by excluding these ids from it.
       */
      supersededEventIds: string[];
    }
  /**
   * The database could not answer.
   *
   * **Not** the same as "there are none", and no caller may read it as such —
   * but nor does it fail the request. The public booking flow has never
   * depended on Postgres, and making it do so would turn a database outage
   * into a site that cannot take a booking. Callers fall back to Google alone,
   * which is exactly the protection that existed before this module; the
   * outage is returned rather than swallowed so it can be reported.
   */
  | { status: "unavailable" };

/**
 * The statuses whose appointment still occupies the diary.
 *
 * `cancelled` and `completed` are absent for opposite reasons: one no longer
 * needs the slot, the other has already used it. `draft`, `tenant_outreach`
 * and `awaiting_tenant` hold no appointment at all.
 */
const OCCUPYING_STATUSES = [
  "scheduled",
  "engineer_assigned",
  "in_progress",
  "remedial_required",
] as const;

/** The sync states that mean "Google does not know about this yet". */
const UNREFLECTED_SYNC_STATES = ["pending", "failed"] as const;

/**
 * Reservations inside a window.
 *
 * `exceptJobId` excludes one job's own appointment, so a tenant re-confirming
 * or moving their booking is not blocked by themselves — the same courtesy the
 * hold store already extends to a customer holding a slot in Redis.
 */
export async function fetchUnsyncedReservations(
  windowStart: Date,
  windowEnd: Date,
  exceptJobId?: string,
): Promise<ReservationLookup> {
  const db = getDb();
  if (!db) return { status: "unavailable" };

  try {
    const rows = await db
      .select({
        id: jobs.id,
        start: jobs.appointmentStart,
        end: jobs.appointmentEnd,
        previousEventId: jobs.calendarPreviousEventId,
      })
      .from(jobs)
      .where(
        and(
          inArray(jobs.lifecycleStatus, [...OCCUPYING_STATUSES]),
          inArray(jobs.calendarSyncState, [...UNREFLECTED_SYNC_STATES]),
          isNull(jobs.cancelledAt),
          gte(jobs.appointmentStart, windowStart),
          lt(jobs.appointmentStart, windowEnd),
        ),
      );

    const reservations: ReservedAppointment[] = [];
    const supersededEventIds: string[] = [];
    for (const row of rows) {
      if (exceptJobId && row.id === exceptJobId) continue;
      if (row.previousEventId) supersededEventIds.push(row.previousEventId);
      /*
        A row in an occupying status without times is a contradiction rather
        than a free slot. Skipping it cannot lose a reservation — there is no
        interval to block with — and it keeps a malformed row from throwing
        inside the availability path.
      */
      if (!row.start || !row.end) continue;
      reservations.push({ start: row.start, end: row.end });
    }
    return { status: "ok", reservations, supersededEventIds };
  } catch {
    // Never the driver's message: it can carry the connection string.
    return { status: "unavailable" };
  }
}

/** Jobs whose calendar write is outstanding, for the reconciliation queue. */
export async function fetchJobsAwaitingCalendarSync(
  limit: number,
): Promise<{ id: string; reference: string }[]> {
  const db = getDb();
  if (!db) return [];

  return db
    .select({ id: jobs.id, reference: jobs.reference })
    .from(jobs)
    .where(
      and(
        inArray(jobs.lifecycleStatus, [...OCCUPYING_STATUSES]),
        inArray(jobs.calendarSyncState, [...UNREFLECTED_SYNC_STATES]),
        isNull(jobs.cancelledAt),
      ),
    )
    .limit(limit);
}

/**
 * Jobs holding a superseded calendar event that still has to be removed.
 *
 * The other half of the queue. A reschedule writes the old event id onto the
 * job in the same statement that moves the appointment, so this finds exactly
 * the events that outlived the appointment they were created for — including
 * the ones left behind by a process that died mid-sequence.
 */
export async function fetchJobsAwaitingCalendarCleanup(
  limit: number,
): Promise<{ id: string; reference: string; previousEventId: string }[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db
    .select({
      id: jobs.id,
      reference: jobs.reference,
      previousEventId: jobs.calendarPreviousEventId,
    })
    .from(jobs)
    .where(isNotNull(jobs.calendarPreviousEventId))
    .limit(limit);

  return rows.flatMap((row) =>
    row.previousEventId
      ? [
          {
            id: row.id,
            reference: row.reference,
            previousEventId: row.previousEventId,
          },
        ]
      : [],
  );
}
