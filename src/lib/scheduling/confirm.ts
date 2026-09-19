import "server-only";

import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { activities, jobs, outboundEmails, properties } from "@/lib/db/schema";
import { canTransition, type JobLifecycleStatus } from "@/lib/jobs/lifecycle";
import { bookingConfigFor } from "@/lib/booking/config";
import { productFor, isProductId } from "@/lib/booking/products";
import { checkHold, releaseHold } from "@/lib/booking/holds";
import {
  countBookingsByDate,
  isDayFullyBooked,
  isSlotStillAvailable,
  type Interval,
} from "@/lib/booking/slots";
import { fetchUnsyncedReservations } from "@/lib/booking/reservations";
import {
  acquireDailyBookingLock,
  releaseDailyBookingLock,
} from "@/lib/booking/daily-limit";
import { fetchBookingEvents, fetchBusyPeriods } from "@/lib/google/calendar";
import { isoDateInZone, parseIsoDate, zonedTimeToUtc } from "@/lib/booking/time";

/**
 * A tenant setting, or moving, an appointment.
 *
 * The tenant chooses **a time and nothing else**. The job, the property, the
 * service, the price and the organisation are all read from the row the
 * session names — none of them is a parameter here, so none can be submitted.
 *
 * There are two operations, deliberately distinguished:
 *
 * - **Initial scheduling** — the job has no appointment, and moving it to
 *   `scheduled` is an ordinary lifecycle transition.
 * - **Rescheduling** — the job is already `scheduled` and the tenant is
 *   choosing a different time. This is *not* a transition: `scheduled` is not
 *   a legal move to itself, and treating it as one would make a re-applied
 *   status indistinguishable from a double submission. It is its own operation
 *   with its own allowed states, its own concurrency guard and its own
 *   calendar sequence.
 *
 * The previous version called `assertTransition(scheduled, scheduled)` for the
 * second case, which threw `InvalidJobTransitionError` out of an unguarded
 * route and returned HTTP 500 to every tenant who changed their mind. Skipping
 * the lifecycle check would have been the wrong repair: what was missing was
 * the operation, not the permission.
 *
 * **Concurrency.** The write is guarded on the exact row that was read —
 * status *and* the appointment itself — so two changes to one job cannot both
 * succeed.
 * The loser is told the job moved underneath it (`conflict`), which is a
 * different fact from the slot having been taken by somebody else
 * (`slot_taken`), and the tenant is asked to reload rather than shown a
 * misleading message about availability.
 *
 * **The calendar write is deliberately outside the transaction, and this is
 * not a two-phase commit.** Postgres cannot make a Google API call atomic. The
 * appointment is committed as `scheduled` with `calendar_sync_state = pending`
 * and — on a reschedule — the superseded event id written to
 * `calendar_previous_event_id` *in the same statement*, so the intent and the
 * outstanding work are durable together. The calendar is then brought into
 * line by `syncJobToCalendar` and `cleanupSupersededEvent`, either in the same
 * request or later by reconciliation. A failure leaves a recorded, resumable
 * job, never a lost appointment.
 */

export type ConfirmInput = {
  /** From the signed session. Never from a form. */
  jobId: string;
  slotStart: string;
  holdToken: string;
};

/** Which of the two operations a confirmation turned out to be. */
export type ConfirmMode = "initial" | "reschedule";

export type ConfirmResult =
  | { status: "confirmed"; start: Date; end: Date; mode: ConfirmMode }
  /** Already scheduled at this time. A retry, not a second appointment. */
  | { status: "already"; start: Date; end: Date }
  | { status: "hold_expired" }
  | { status: "slot_taken" }
  | { status: "day_full" }
  | { status: "not_schedulable" }
  /**
   * The job changed while this request was deciding.
   *
   * Someone else moved it, or the same tenant submitted twice from two tabs.
   * Deliberately **not** `slot_taken`: the slot may be perfectly free, and
   * telling a tenant to choose another time would send them round a loop that
   * cannot succeed. The honest answer is "reload and look again".
   */
  | { status: "conflict" }
  | { status: "unavailable" }
  | { status: "not_found" };

/**
 * A deterministic calendar event id for a job at a time.
 *
 * Derived from the job and the slot, so a retry produces the same id and
 * Google refuses the duplicate rather than creating a second event. A *move*
 * produces a different id, which is why a reschedule has an old event to clean
 * up at all. Google requires characters in [a-v0-9]; hex satisfies that.
 */
export function calendarEventIdForJob(jobId: string, slotStartIso: string): string {
  const digest = createHash("sha256")
    .update(`job|${jobId}|${new Date(slotStartIso).toISOString()}`)
    .digest("hex");
  return `bscj${digest}`.slice(0, 60);
}

/** The statuses a tenant may set a time from, for the first time. */
const SCHEDULABLE_INITIAL: JobLifecycleStatus[] = [
  "tenant_outreach",
  "awaiting_tenant",
];

/**
 * The statuses a tenant may move an existing appointment from.
 *
 * Only `scheduled`. Once an engineer has been assigned or is on site, the time
 * is no longer the tenant's alone to change — that is a phone call, not a
 * self-service action — and once the job is completed or cancelled there is
 * nothing to move.
 */
const RESCHEDULABLE: JobLifecycleStatus[] = ["scheduled"];

/**
 * Busy periods with one appointment's own block removed.
 *
 * A job moving from 10:00 to 10:30 would otherwise be refused by its *own*
 * existing event, whose buffer covers the new time. Matched on the exact
 * window rather than on an id because free/busy returns times and nothing
 * else, by design.
 *
 * Google may merge a run of adjacent entries into one period, in which case
 * nothing matches and the move is refused as `slot_taken`. That is the safe
 * direction — it declines a change rather than permitting a clash — and the
 * tenant can still pick any time that does not touch their old one.
 */
export function withoutOwnAppointment(
  busy: readonly Interval[],
  own: { start: Date; end: Date } | null,
): Interval[] {
  if (!own) return [...busy];
  return busy.filter(
    (period) =>
      !(
        period.start.getTime() === own.start.getTime() &&
        period.end.getTime() === own.end.getTime()
      ),
  );
}

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
      calendarEventId: jobs.calendarEventId,
      calendarPreviousEventId: jobs.calendarPreviousEventId,
    })
    .from(jobs)
    .where(eq(jobs.id, input.jobId))
    .limit(1);

  if (!job) return { status: "not_found" };

  const status = job.lifecycleStatus as JobLifecycleStatus;

  /*
    Which operation this is. Decided from the row, never from the request —
    there is no field a caller could set to claim one or the other.
  */
  let mode: ConfirmMode;
  if (RESCHEDULABLE.includes(status)) {
    mode = "reschedule";
  } else if (
    SCHEDULABLE_INITIAL.includes(status) &&
    canTransition(status, "scheduled")
  ) {
    mode = "initial";
  } else {
    // Refused as a value, not as a throw. A lifecycle rule is a business
    // answer to a tenant's request, and a business answer is not a 500.
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
    mode === "reschedule" &&
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
  // free. The re-checks below are what keep that safe, and they are never
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

    const [busy, bookings, reserved] = await Promise.all([
      fetchBusyPeriods(windowStart, windowEnd),
      fetchBookingEvents(dayStart, dayEnd),
      /*
        Committed appointments Google has not been told about yet. Excluding
        this job keeps a tenant from being blocked by their own reservation
        when they move; including everyone else's is what stops a public
        booking and a tenant reschedule landing on one slot.
      */
      fetchUnsyncedReservations(dayStart, dayEnd, job.id),
    ]);

    const reservations = reserved.status === "ok" ? reserved.reservations : [];
    /*
      Another job mid-reschedule is in Google at its old time and in Postgres
      at its new one. Counting both would close a day one booking early.
    */
    const superseded = new Set(
      reserved.status === "ok" ? reserved.supersededEventIds : [],
    );

    const ownBlock =
      mode === "reschedule" && job.appointmentStart && job.appointmentEnd
        ? { start: job.appointmentStart, end: job.appointmentEnd }
        : null;

    const effectiveBusy = [
      ...withoutOwnAppointment(busy, ownBlock),
      ...reservations,
    ];

    const bookingCounts = countBookingsByDate(
      [
        ...bookings.filter((booking) => !superseded.has(booking.id)),
        ...reservations.map((slot) => ({ start: slot.start })),
      ],
      config,
    );

    /*
      A reschedule inside the same day does not consume a new place: the job
      already holds one. Only a first booking, or a move onto a different date,
      has to pass the cap.
    */
    const alreadyCountedToday =
      mode === "reschedule" &&
      job.appointmentStart !== null &&
      isoDateInZone(job.appointmentStart, config.timeZone) === bookingDate;

    if (
      !alreadyCountedToday &&
      isDayFullyBooked(bookingCounts, bookingDate, config)
    ) {
      return { status: "day_full" };
    }
    if (
      !isSlotStillAvailable(
        input.slotStart,
        effectiveBusy,
        new Date(),
        config,
        alreadyCountedToday ? new Map() : bookingCounts,
      )
    ) {
      return { status: "slot_taken" };
    }

    /*
      Any cleanup still outstanding from an earlier move, resolved before this
      one takes the column. Nothing is dropped silently: if Google cannot be
      reached the old id is written to the timeline, where the reconciliation
      sweep and a human can both still find it.
    */
    const carriedOver = job.calendarPreviousEventId;
    if (carriedOver) {
      const cleared = (await tryDeleteEvent(carriedOver)) !== "failed";
      if (!cleared) {
        try {
          await db.insert(activities).values({
            jobId: job.id,
            propertyId: job.propertyId,
            agentOrganisationId: job.agentOrganisationId,
            kind: "calendar.cleanup_outstanding",
            actor: "system",
            // An opaque calendar id. No customer data, no secret.
            detail: { eventId: carriedOver, reason: "superseded_again" },
          });
        } catch {
          // The timeline is commentary; the move below is the record.
        }
      }
    }

    /*
      The event this move supersedes, remembered *in the row*. Written by the
      same UPDATE that changes the appointment, so the obsolete event and the
      fact that it is obsolete become true at the same instant. A process that
      dies on the next line leaves work that can be found, not a phantom
      appointment in the engineer's diary.
    */
    const supersededEventId =
      mode === "reschedule" && job.calendarEventId ? job.calendarEventId : null;

    /*
      Optimistic concurrency, on the exact row this request read.

      The **appointment itself is the version**, alongside the status. Two
      reschedules racing both read `scheduled`, so the status alone would have
      let both through; both also read the same `appointment_start`, and the
      first to land changes it, so the second matches nothing and is told the
      job moved.

      `updated_at` would have been the obvious version column and is the wrong
      one: Postgres stores a `timestamptz` to the microsecond and a JavaScript
      `Date` carries milliseconds, so a value read out and sent back never
      compares equal and *every* confirmation would lose its own race. The
      appointment does round-trip exactly, because this application is what
      wrote it.
    */
    const updated = await db
      .update(jobs)
      .set({
        appointmentStart: start,
        appointmentEnd: end,
        durationMinutes: product.durationMinutes,
        lifecycleStatus: "scheduled",
        schedulingMethod: "tenant_selected",
        // The old event is no longer this job's event; the new one does not
        // exist yet. Intent recorded, outcome written by the sync below.
        calendarEventId: null,
        calendarPreviousEventId: supersededEventId,
        calendarSyncState: "pending",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.lifecycleStatus, status),
          job.appointmentStart
            ? eq(jobs.appointmentStart, job.appointmentStart)
            : isNull(jobs.appointmentStart),
        ),
      )
      .returning({ id: jobs.id });

    if (updated.length === 0) {
      /*
        Somebody else got there first. Report what the row now says rather than
        inventing an outcome — and distinguish "you already have this
        appointment" from "the job moved", because they need different words.
      */
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
      return { status: "conflict" };
    }

    /*
      The timeline entry and the intent to tell people.

      Reached **only** after the guarded UPDATE returned a row, so a
      confirmation that lost the race writes neither — an activity claiming an
      appointment that was never made, and a queued email announcing it, were
      both possible before. Batched together because they describe one event:
      recording that it happened and intending to say so belong in one
      transaction.

      Sending is the drain's job in a later phase, so a mail outage cannot
      reach this path at all, and the unique key means a retry re-sends nothing
      that already went.
    */
    try {
      await db.batch([
        db.insert(activities).values({
          jobId: job.id,
          propertyId: job.propertyId,
          agentOrganisationId: job.agentOrganisationId,
          kind:
            mode === "reschedule"
              ? "appointment.rescheduled"
              : "appointment.scheduled",
          actor: "tenant",
          detail: {
            start: start.toISOString(),
            end: end.toISOString(),
            ...(mode === "reschedule" && job.appointmentStart
              ? { previousStart: job.appointmentStart.toISOString() }
              : {}),
          },
        }),
        db
          .insert(outboundEmails)
          .values({
            jobId: job.id,
            kind: "tenant-appointment-confirmation",
            recipient: "tenant",
            idempotencyKey: `appointment:${job.id}:${start.toISOString()}`,
          })
          .onConflictDoNothing(),
      ]);
    } catch {
      // The appointment is the record. A missing timeline entry is a smaller
      // problem than a refused booking, and the row above is already committed.
    }

    // The reservation has done its job: the appointment is now a real row, and
    // `reservations.ts` keeps the slot blocked until Google agrees.
    try {
      await releaseHold(input.slotStart, input.holdToken, product.id);
    } catch {
      // A hold that cannot be given back simply expires on its TTL.
    }

    return { status: "confirmed", start, end, mode };
  } finally {
    if (dayLock.status === "acquired") {
      await releaseDailyBookingLock(bookingDate, dayLock.token);
    }
  }
}

// ---------------------------------------------------------------------------
// Bringing Google into line
// ---------------------------------------------------------------------------

export type SyncOutcome =
  | "synced"
  | "failed"
  | "not_required"
  | "not_found"
  /** The row moved again while this was running. A newer sync will follow. */
  | "superseded";

/**
 * Best effort, and never allowed to throw into a caller's happy path.
 *
 * "Already gone" is reported separately from "removed", because a caller
 * clearing a queue wants to treat them the same and a caller *counting* work
 * done does not. Both mean the event is not there, which is the goal.
 */
async function tryDeleteEvent(
  eventId: string,
): Promise<"deleted" | "absent" | "failed"> {
  try {
    const { deleteEvent } = await import("@/lib/google/calendar");
    return await deleteEvent(eventId);
  } catch {
    return "failed";
  }
}

/**
 * Writes the appointment to Google Calendar.
 *
 * Runs **after** the job is committed, and never fails the tenant's booking.
 *
 * Three things make it safe to retry:
 *
 * 1. **The event id is derived from the row as it is now**, not from whatever
 *    the caller had in mind. A retry that arrives after the appointment moved
 *    again computes the newer id, so a stale attempt cannot restore an
 *    obsolete appointment.
 * 2. **A 409 is verified, not assumed.** Google keeps cancelled events under
 *    their ids, and the id here is reused whenever a job returns to a time it
 *    once held — so "the id is taken" and "the appointment is already there"
 *    are different facts. The existing event is fetched and compared against
 *    the expected window, identity and status before anything is called
 *    synced; when it does not match, it is overwritten.
 * 3. **The row is only marked synced if it has not moved.** The final UPDATE
 *    is guarded on the appointment it was computed for.
 */
export async function syncJobToCalendar(jobId: string): Promise<SyncOutcome> {
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
  if (!isProductId(job.productId)) return "failed";

  const appointmentStart = job.appointmentStart;
  const appointmentEnd = job.appointmentEnd;
  const eventId = calendarEventIdForJob(job.id, appointmentStart.toISOString());

  // Already done, and done for *this* appointment. An event id left over from
  // an earlier time is not a reason to skip the write.
  if (job.calendarSyncState === "synced" && job.calendarEventId === eventId) {
    return "synced";
  }

  const product = productFor(job.productId);
  const address = [property.houseOrName, property.street, property.town]
    .filter(Boolean)
    .join(", ");

  // Imported here rather than at the top so the module that decides state does
  // not drag the Google client into every caller that only reads it.
  const {
    createEvent,
    DuplicateBookingError,
    eventMatchesAppointment,
    fetchEvent,
    replaceEvent,
  } = await import("@/lib/google/calendar");

  const event = {
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
    start: appointmentStart,
    end: appointmentEnd,
  };

  async function markFailed(): Promise<"failed"> {
    try {
      await db!
        .update(jobs)
        .set({ calendarSyncState: "failed", updatedAt: new Date() })
        .where(
          and(eq(jobs.id, job.id), eq(jobs.appointmentStart, appointmentStart)),
        );
    } catch {
      // Recorded state is best effort; the row is already `pending`, which is
      // also on the reconciliation queue.
    }
    return "failed";
  }

  try {
    await createEvent(event);
  } catch (error) {
    if (!(error instanceof DuplicateBookingError)) {
      /*
        Includes the ambiguous case: a timeout or a dropped connection where
        the event may or may not have been created. `failed` is the honest
        state for "we do not know", and the retry resolves it — either the id
        is free and the create succeeds, or it is taken and the 409 path below
        verifies what is actually there.
      */
      return markFailed();
    }

    /*
      The id is taken. By what is the question the old code never asked: it
      wrote `synced` against whatever was there, including a cancelled event
      nobody would attend.
    */
    let existing: Awaited<ReturnType<typeof fetchEvent>>;
    try {
      existing = await fetchEvent(eventId);
    } catch {
      return markFailed();
    }

    if (!existing) {
      // Google refused the insert and then reported no such event. Racing
      // creations, or a deletion in between. One retry, then give up to the
      // queue rather than looping.
      try {
        await createEvent(event);
      } catch {
        return markFailed();
      }
    } else if (
      !eventMatchesAppointment(existing, {
        start: appointmentStart,
        end: appointmentEnd,
      })
    ) {
      /*
        Same id, different appointment — cancelled, or left over from a visit
        that has since moved. Overwriting is the only way to end with one
        correct live event under an id Google will not let go of.
      */
      try {
        const outcome = await replaceEvent(event);
        if (outcome === "absent") await createEvent(event);
      } catch {
        return markFailed();
      }
    }
  }

  /*
    Guarded on the appointment this write was computed for. A slower sync
    finishing after the tenant moved again must not stamp `synced` and an
    obsolete event id onto the newer appointment — it reports `superseded` and
    leaves the newer sync to finish the job.
  */
  let marked: { id: string }[];
  try {
    marked = await db
      .update(jobs)
      .set({
        calendarEventId: eventId,
        calendarSyncState: "synced",
        updatedAt: new Date(),
      })
      .where(
        and(eq(jobs.id, job.id), eq(jobs.appointmentStart, appointmentStart)),
      )
      .returning({ id: jobs.id });
  } catch {
    /*
      The event is in Google and Postgres will not say so — the one ordering
      this design cannot make atomic, arriving at the only point where it is
      harmless. The row stays `pending`, which keeps the slot reserved *and*
      keeps the job on the reconciliation queue; the retry meets its own event,
      verifies it against the appointment, and settles. Nothing is created
      twice and nothing is lost.
    */
    return "failed";
  }

  if (marked.length === 0) {
    // The event we just wrote belongs to an appointment that no longer exists.
    // Remove it rather than leaving it in the diary; if that fails, the newer
    // reschedule's own cleanup record is what finds it.
    await tryDeleteEvent(eventId);
    return "superseded";
  }

  return "synced";
}

export type CleanupOutcome =
  | "cleaned"
  | "nothing_to_do"
  | "failed"
  | "not_found";

/**
 * Removes the event a reschedule superseded.
 *
 * Runs **after** the replacement exists, never before: losing the original
 * booking because the new one could not be created is the failure this whole
 * sequence is arranged to prevent. Until it succeeds the old id stays on the
 * row, so the work is visible to the reconciliation queue and survives a
 * process that dies mid-move.
 *
 * The column is cleared only if it still holds the id that was deleted, so a
 * newer reschedule's cleanup record cannot be wiped by an older one finishing
 * late.
 */
export async function cleanupSupersededEvent(
  jobId: string,
): Promise<CleanupOutcome> {
  const db = getDb();
  if (!db) return "failed";

  const [job] = await db
    .select({
      id: jobs.id,
      previousEventId: jobs.calendarPreviousEventId,
      calendarEventId: jobs.calendarEventId,
      calendarSyncState: jobs.calendarSyncState,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!job) return "not_found";

  const previous = job.previousEventId;
  if (!previous) return "nothing_to_do";

  /*
    Nothing is removed until the replacement is confirmed present. A reschedule
    whose new event failed to write still has the old one, and the old one is
    the only appointment the engineer can currently see — deleting it here
    would turn a recoverable inconsistency into a visit nobody knows about.
  */
  if (job.calendarSyncState !== "synced" || !job.calendarEventId) {
    return "nothing_to_do";
  }

  // The same id under both columns would mean deleting the live appointment.
  if (job.calendarEventId === previous) {
    await db
      .update(jobs)
      .set({ calendarPreviousEventId: null, updatedAt: new Date() })
      .where(
        and(eq(jobs.id, job.id), eq(jobs.calendarPreviousEventId, previous)),
      );
    return "cleaned";
  }

  if ((await tryDeleteEvent(previous)) === "failed") return "failed";

  await db
    .update(jobs)
    .set({ calendarPreviousEventId: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, job.id), eq(jobs.calendarPreviousEventId, previous)));

  return "cleaned";
}

/**
 * Every calendar event this job has ever been given, bar its current one.
 *
 * `calendar_previous_event_id` holds **one** id, which is enough for the
 * ordinary case and not enough for two moves in a row while Google is
 * unreachable: the second move would overwrite the first id and the event it
 * named would be orphaned in the engineer's diary forever.
 *
 * It does not have to be stored, because an event id is a pure function of
 * the job and the slot — and every slot this job has left is recorded in its
 * own timeline, as `previousStart` on each `appointment.rescheduled` entry.
 * So the history *is* the queue, and the column is only a fast path.
 *
 * Bounded, and deliberately excludes the id of the appointment as it stands
 * now: deleting that would remove the live booking.
 */
export async function orphanedEventIdsForJob(
  jobId: string,
  limit = 10,
): Promise<string[]> {
  const db = getDb();
  if (!db) return [];

  const [job] = await db
    .select({
      appointmentStart: jobs.appointmentStart,
      calendarEventId: jobs.calendarEventId,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job) return [];

  const keep = new Set<string>();
  if (job.calendarEventId) keep.add(job.calendarEventId);
  if (job.appointmentStart) {
    keep.add(calendarEventIdForJob(jobId, job.appointmentStart.toISOString()));
  }

  const history = await db
    .select({ detail: activities.detail })
    .from(activities)
    .where(
      and(
        eq(activities.jobId, jobId),
        eq(activities.kind, "appointment.rescheduled"),
      ),
    )
    .limit(limit);

  const orphans = new Set<string>();
  for (const row of history) {
    const previousStart = (row.detail as { previousStart?: unknown } | null)
      ?.previousStart;
    if (typeof previousStart !== "string") continue;

    const when = new Date(previousStart);
    if (Number.isNaN(when.getTime())) continue;

    const id = calendarEventIdForJob(jobId, when.toISOString());
    if (!keep.has(id)) orphans.add(id);
  }

  return [...orphans];
}

/**
 * The whole calendar sequence for one job: write the replacement, then remove
 * what it replaced. Never throws — every failure is a recorded state and a
 * queued piece of work.
 */
export async function reconcileJobCalendar(
  jobId: string,
  options: { sweepHistory?: boolean } = {},
): Promise<{
  sync: SyncOutcome;
  cleanup: CleanupOutcome;
  /** Orphans found from the timeline and removed. Only when asked. */
  orphansRemoved: number;
}> {
  let sync: SyncOutcome;
  try {
    sync = await syncJobToCalendar(jobId);
  } catch {
    sync = "failed";
  }

  let cleanup: CleanupOutcome;
  try {
    cleanup = await cleanupSupersededEvent(jobId);
  } catch {
    cleanup = "failed";
  }

  /*
    Only the reconciliation sweep asks for this. It costs one Google call per
    historical slot, which is nothing on a background pass and is not something
    to put in front of a tenant waiting for a confirmation.
  */
  let orphansRemoved = 0;
  if (options.sweepHistory) {
    try {
      for (const id of await orphanedEventIdsForJob(jobId)) {
        // "Already gone" is the ordinary answer and is not work done.
        if ((await tryDeleteEvent(id)) === "deleted") orphansRemoved += 1;
      }
    } catch {
      // The queue is the timeline; it will be read again next pass.
    }
  }

  return { sync, cleanup, orphansRemoved };
}
