import "server-only";

import {
  fetchJobsAwaitingCalendarCleanup,
  fetchJobsAwaitingCalendarSync,
} from "@/lib/booking/reservations";
import {
  cleanupSupersededEvent,
  orphanedEventIdsForJob,
  syncJobToCalendar,
} from "@/lib/scheduling/confirm";
import {
  listUnpersistedBookings,
  recoverUnpersistedBookings,
  RECOVERY_BATCH_LIMIT,
  type SweepResult,
} from "@/lib/jobs/booking-recovery";

/**
 * Finishing what an external call could not.
 *
 * Three kinds of unfinished business, all of them recorded durably at the
 * moment they became unfinished, none of them able to resolve itself:
 *
 * 1. **Appointments Google has not been told about** — `calendar_sync_state`
 *    is `pending` or `failed`. The slot stays reserved meanwhile (see
 *    `reservations.ts`), so nobody is double-booked, but the engineer cannot
 *    see the job until this runs.
 * 2. **Events that outlived the appointment they belonged to** —
 *    `calendar_previous_event_id` is set. A reschedule whose cleanup did not
 *    happen leaves a phantom entry in the diary. The column holds one id, so
 *    two moves in a row while Google is unreachable would overwrite the first;
 *    the timeline is therefore swept as well, because an event id is a pure
 *    function of the job and the slot and every slot a job has left is
 *    recorded on its `appointment.rescheduled` entries.
 * 3. **Bookings the database never recorded** — a note in the reservation
 *    store from a website booking whose Postgres write failed.
 *
 * **Bounded on purpose.** Each pass takes a limited number of each kind. A
 * sweep that tried to drain everything would hold a request open for as long
 * as the backlog took and fail as a whole if one item did, which is how a
 * reconciliation job becomes the thing that needs reconciling.
 *
 * Nothing here creates a second calendar event, sends a customer anything, or
 * changes an appointment time. It writes what should already have been
 * written, and every step is idempotent — running it twice is a no-op.
 */

export type CalendarSyncReport = {
  considered: number;
  synced: number;
  failed: number;
  /** The job moved again while this ran; a newer attempt will finish it. */
  superseded: number;
  /** No longer needs an event at all — cancelled, completed, or moved. */
  skipped: number;
};

export type CalendarCleanupReport = {
  considered: number;
  cleaned: number;
  /** Left on the queue: Google could not be reached, or the replacement is
   * not confirmed present yet and removing the old one would leave nothing. */
  pending: number;
  /**
   * Events found from the timeline rather than from the column, and removed.
   *
   * These are the ones the single-id column could not hold. Normally zero.
   */
  orphansRemoved: number;
};

export type ReconcileReport = {
  calendarSync: CalendarSyncReport;
  calendarCleanup: CalendarCleanupReport;
  bookingRecovery: SweepResult;
};

/** How much of each queue one pass will take on. */
export const RECONCILE_BATCH_LIMIT = 25;

export async function runReconciliation(
  limit = RECONCILE_BATCH_LIMIT,
): Promise<ReconcileReport> {
  const sync: CalendarSyncReport = {
    considered: 0,
    synced: 0,
    failed: 0,
    superseded: 0,
    skipped: 0,
  };

  const awaitingSync = await fetchJobsAwaitingCalendarSync(limit);
  sync.considered = awaitingSync.length;

  for (const job of awaitingSync) {
    let outcome: Awaited<ReturnType<typeof syncJobToCalendar>>;
    try {
      outcome = await syncJobToCalendar(job.id);
    } catch {
      outcome = "failed";
    }

    if (outcome === "synced") sync.synced += 1;
    else if (outcome === "superseded") sync.superseded += 1;
    else if (outcome === "failed") sync.failed += 1;
    else sync.skipped += 1;
  }

  /*
    Cleanup runs after the sync pass, never before. A superseded event is only
    safe to remove once its replacement is confirmed present — until then it is
    the only appointment the engineer can see, and deleting it would turn a
    recoverable inconsistency into a visit nobody knows about.
    `cleanupSupersededEvent` enforces that itself; running in this order simply
    means a job that was repaired a moment ago is tidied in the same pass.
  */
  const cleanup: CalendarCleanupReport = {
    considered: 0,
    cleaned: 0,
    pending: 0,
    orphansRemoved: 0,
  };

  const awaitingCleanup = await fetchJobsAwaitingCalendarCleanup(limit);
  cleanup.considered = awaitingCleanup.length;

  for (const job of awaitingCleanup) {
    let outcome: Awaited<ReturnType<typeof cleanupSupersededEvent>>;
    try {
      outcome = await cleanupSupersededEvent(job.id);
    } catch {
      outcome = "failed";
    }
    if (outcome === "cleaned") cleanup.cleaned += 1;
    else cleanup.pending += 1;
  }

  /*
    The timeline sweep, over every job this pass touched.

    Costs one Google call per historical slot, which is fine on a background
    pass and is why the tenant's own request does not do it. It is what makes
    the guarantee "no event outlives the appointment it belonged to" true even
    when the single-id column was overwritten.
  */
  const touched = new Set([
    ...awaitingSync.map((job) => job.id),
    ...awaitingCleanup.map((job) => job.id),
  ]);

  for (const jobId of touched) {
    try {
      for (const eventId of await orphanedEventIdsForJob(jobId)) {
        const { deleteEvent } = await import("@/lib/google/calendar");
        if ((await deleteEvent(eventId)) === "deleted") {
          cleanup.orphansRemoved += 1;
        }
      }
    } catch {
      // The timeline is the queue; it will be read again next pass.
    }
  }

  const bookingRecovery = await recoverUnpersistedBookings(
    Math.min(limit, RECOVERY_BATCH_LIMIT),
  );

  return { calendarSync: sync, calendarCleanup: cleanup, bookingRecovery };
}

export type ReconcileQueue = {
  awaitingCalendarSync: { id: string; reference: string }[];
  awaitingCalendarCleanup: { id: string; reference: string }[];
  /** Idempotency keys, which are opaque. No customer data is listed. */
  unpersistedBookings: string[];
  /** False when the reservation store could not be enumerated. */
  unpersistedListed: boolean;
};

/** What is outstanding, without touching any of it. */
export async function readReconcileQueue(
  limit = RECONCILE_BATCH_LIMIT,
): Promise<ReconcileQueue> {
  const [awaitingCalendarSync, awaitingCalendarCleanup, pending] =
    await Promise.all([
      fetchJobsAwaitingCalendarSync(limit).catch(() => []),
      fetchJobsAwaitingCalendarCleanup(limit).catch(() => []),
      listUnpersistedBookings(limit).catch(
        () => ({ status: "unavailable" }) as const,
      ),
    ]);

  return {
    awaitingCalendarSync,
    awaitingCalendarCleanup: awaitingCalendarCleanup.map((job) => ({
      id: job.id,
      reference: job.reference,
    })),
    unpersistedBookings: pending.status === "ok" ? pending.keys : [],
    unpersistedListed: pending.status === "ok",
  };
}
