import "server-only";

import {
  getKvClient,
  KvUnavailableError,
  type KvClient,
} from "@/lib/kv/store";
import { isProductId } from "@/lib/booking/products";
import { persistWebsiteBooking, type PersistBookingInput } from "./persist-booking";

/**
 * A website booking that exists in the calendar but not in the database.
 *
 * The invariant this defends: **an appointment already created in Google must
 * never become a failed booking because our own bookkeeping failed.** The
 * public route is built around it — the calendar write is the point of no
 * return, and everything after it (both emails, the V2 record) is allowed to
 * fail without the customer being told.
 *
 * What was missing is the other half. A booking whose Postgres write failed
 * left no trace that could be acted on: the duplicate guard refused the retry,
 * so persistence was never attempted again, and the job existed only as an
 * event in a diary.
 *
 * **Where the note is kept matters more than what is in it.** The write failed
 * because the database was unreachable, so a recovery row in that database is
 * not a recovery mechanism — it is the same bet, placed twice. It goes to the
 * reservation store instead, which is a separate service on a separate
 * failure domain, and the calendar event is checked before anything is written
 * so recovery can never invent a job for an appointment that is not there.
 *
 * **Retention.** The payload is the booking as the server derived it: the
 * customer's name, contact details and address, exactly as they already sit in
 * the calendar event and in the two emails this booking sent. It is held for
 * seven days and deleted the moment the job is recorded. It is not a second
 * customer database and nothing reads it except this module — but it *is*
 * personal data in a store that previously held none, which is a change worth
 * stating rather than burying. See the handoff note.
 *
 * **When both stores were down.** If Postgres and Redis were unavailable at
 * the same moment, there is no note and no automatic recovery. The appointment
 * is still real — it is in the calendar, the customer has their confirmation
 * and BSCJ has the internal alert email — but re-creating the job from those
 * is a manual job. Reconstructing it from the event description is not
 * attempted here: the description holds a *formatted* address, not the parts a
 * property row is made of, and guessing where the street ends would put
 * invented data into the operational record.
 */

const PENDING_PREFIX = "booking-unpersisted:";

/** Long enough for a failure to be noticed and worked; short enough to matter. */
export const PENDING_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The most a single reconciliation pass will take on. */
export const RECOVERY_BATCH_LIMIT = 25;

function pendingKey(idempotencyKey: string): string {
  return `${PENDING_PREFIX}${idempotencyKey}`;
}

/**
 * The stored shape.
 *
 * Versioned, because a payload written by one deployment may be recovered by
 * the next and a silently changed shape would be read as corrupt — or worse,
 * read wrongly.
 */
type StoredBooking = {
  v: 1;
  booking: Omit<
    PersistBookingInput,
    "appointmentStart" | "appointmentEnd"
  > & {
    appointmentStart: string;
    appointmentEnd: string;
  };
};

export type RecordOutcome = "recorded" | "unavailable";

/**
 * Logs, with a reference and a category and nothing else.
 *
 * Never the customer, the address, the payload or the store's message. The
 * reference is an opaque label that grants nothing and is enough to find the
 * booking in the calendar — which, in the case this exists to announce, is the
 * only place it can be found.
 */
function report(reference: string, event: string): void {
  console.warn(`[booking-recovery] ${event} for reference ${reference}`);
}

/** Notes that a booking's operational record is missing. Never throws. */
export async function recordUnpersistedBooking(
  input: PersistBookingInput,
  client: KvClient | null = getKvClient(),
): Promise<RecordOutcome> {
  /*
    No reservation store either.

    Postgres would not take the booking and there is nowhere else to put the
    note, so this booking has **no automatic route back**. It is still a real
    appointment — the calendar event exists and the customer has been
    confirmed — but rebuilding the job is now a manual act, and the only thing
    that can make that possible is saying so loudly here. Silence was the
    original defect and it must not be reintroduced one layer down.
  */
  if (!client) {
    report(input.reference, "NOT RECORDED: no reservation store configured");
    return "unavailable";
  }

  const payload: StoredBooking = {
    v: 1,
    booking: {
      ...input,
      appointmentStart: input.appointmentStart.toISOString(),
      appointmentEnd: input.appointmentEnd.toISOString(),
    },
  };

  try {
    await client.set(
      pendingKey(input.idempotencyKey),
      JSON.stringify(payload),
      PENDING_TTL_SECONDS,
    );
    return "recorded";
  } catch {
    /*
      Both stores are down at once. A failure here cannot be allowed to reach
      the customer's response — the appointment is real and confirmed whatever
      happens to the note — so it is reported to the operator instead.
    */
    report(input.reference, "NOT RECORDED: the reservation store refused it");
    return "unavailable";
  }
}

/**
 * Turns a stored payload back into persistence input.
 *
 * Validates rather than casts. A malformed or foreign value in the store must
 * not become a job row, and the only safe reading of "this is not the shape we
 * wrote" is to refuse it.
 */
export function parseStoredBooking(raw: string): PersistBookingInput | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null) return null;
  const stored = value as Partial<StoredBooking>;
  if (stored.v !== 1 || typeof stored.booking !== "object" || !stored.booking) {
    return null;
  }

  const booking = stored.booking as StoredBooking["booking"];
  const start = new Date(booking.appointmentStart);
  const end = new Date(booking.appointmentEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (!booking.idempotencyKey || !booking.reference) return null;
  if (!booking.calendarEventId) return null;
  if (!isProductId(booking.productId)) return null;

  return { ...booking, appointmentStart: start, appointmentEnd: end };
}

export type RecoveryOutcome =
  /** The job is now recorded. Either this call wrote it, or it already was. */
  | { status: "recovered"; jobId: string }
  /** Nothing outstanding for this key. */
  | { status: "nothing_to_do" }
  /** The appointment is not in the calendar, so there is no job to record. */
  | { status: "event_missing" }
  /** Could not be completed this time. The note is left in place. */
  | { status: "failed"; reason: string };

/**
 * Re-attempts the database record for one booking.
 *
 * **Creates no calendar event and sends no email.** It writes the row that is
 * missing and nothing else — `persistWebsiteBooking` is already idempotent on
 * the idempotency key, so a booking that turns out to have been recorded after
 * all is recognised rather than duplicated, and repeated calls are no-ops.
 *
 * The calendar event is verified first. A note whose appointment has since
 * been cancelled or deleted describes a booking that no longer exists, and
 * writing a `scheduled` job for it would put a visit in the operational record
 * that nobody is going to make.
 */
export async function recoverUnpersistedBooking(
  idempotencyKey: string,
  client: KvClient | null = getKvClient(),
): Promise<RecoveryOutcome> {
  if (!client) return { status: "nothing_to_do" };

  let raw: string | null;
  try {
    raw = await client.get(pendingKey(idempotencyKey));
  } catch (error) {
    /*
      Every failure is a value, including one the store did not label.

      This is called from `/api/book` on a duplicate submission, outside any
      try/catch, so a throw here would turn a repeat click into HTTP 500 — a
      new failure mode in the public booking flow, introduced by the machinery
      meant to protect it. `KvUnavailableError` is distinguished only because
      it is the expected case and worth naming.
    */
    return {
      status: "failed",
      reason:
        error instanceof KvUnavailableError ? "store_unavailable" : "store_error",
    };
  }

  if (!raw) return { status: "nothing_to_do" };

  const input = parseStoredBooking(raw);
  if (!input) {
    // Unreadable. Left in place deliberately: deleting it would destroy the
    // only pointer to a booking a person could still reconcile by hand.
    return { status: "failed", reason: "unreadable_payload" };
  }

  // Does the appointment still exist, and is it still live?
  try {
    const { fetchEvent } = await import("@/lib/google/calendar");
    const event = await fetchEvent(input.calendarEventId);
    if (!event || event.status === "cancelled") {
      await discard(client, idempotencyKey);
      return { status: "event_missing" };
    }
  } catch {
    // Could not ask. The note stays; a later pass will try again.
    return { status: "failed", reason: "calendar_unavailable" };
  }

  const result = await persistWebsiteBooking(input);
  if (result.status === "created" || result.status === "exists") {
    await discard(client, idempotencyKey);
    return { status: "recovered", jobId: result.jobId };
  }

  return { status: "failed", reason: result.status };
}

async function discard(
  client: KvClient,
  idempotencyKey: string,
): Promise<void> {
  const key = pendingKey(idempotencyKey);
  try {
    /*
      Compare-and-delete against the value that is actually there. The
      interface has no unguarded delete — deliberately, because holds must only
      ever be released by their owner — and reading first is enough: a note
      rewritten between the read and the delete is a newer note, and leaving it
      is the safe direction.

      Overwriting with a one-second TTL would have been simpler and wrong: the
      key stays listable while it expires, so the queue would keep reporting
      work that is already done.
    */
    const current = await client.get(key);
    if (current !== null) await client.deleteIfEqual(key, current);
  } catch {
    // It expires on its own TTL either way, and a second recovery is a no-op.
  }
}

export type PendingListing =
  | { status: "ok"; keys: string[] }
  /** The store cannot enumerate, so "none found" would be a lie. */
  | { status: "unsupported" }
  | { status: "unavailable" };

/** The idempotency keys with an outstanding operational record. */
export async function listUnpersistedBookings(
  limit = RECOVERY_BATCH_LIMIT,
  client: KvClient | null = getKvClient(),
): Promise<PendingListing> {
  if (!client) return { status: "unavailable" };
  if (!client.scanKeys) return { status: "unsupported" };

  try {
    const keys = await client.scanKeys(`${PENDING_PREFIX}*`, limit);
    return {
      status: "ok",
      keys: keys.map((key) => key.slice(PENDING_PREFIX.length)),
    };
  } catch (error) {
    if (error instanceof KvUnavailableError) return { status: "unavailable" };
    throw error;
  }
}

export type SweepResult = {
  /** False when the store could not be enumerated at all. */
  listed: boolean;
  considered: number;
  recovered: number;
  eventMissing: number;
  failed: number;
};

/** One bounded pass over everything outstanding. Never throws. */
export async function recoverUnpersistedBookings(
  limit = RECOVERY_BATCH_LIMIT,
  client: KvClient | null = getKvClient(),
): Promise<SweepResult> {
  const listing = await listUnpersistedBookings(limit, client);
  const keys = listing.status === "ok" ? listing.keys : [];
  const result: SweepResult = {
    listed: listing.status === "ok",
    considered: keys.length,
    recovered: 0,
    eventMissing: 0,
    failed: 0,
  };

  for (const key of keys) {
    let outcome: RecoveryOutcome;
    try {
      outcome = await recoverUnpersistedBooking(key, client);
    } catch {
      outcome = { status: "failed", reason: "unexpected" };
    }

    if (outcome.status === "recovered") result.recovered += 1;
    else if (outcome.status === "event_missing") result.eventMissing += 1;
    else if (outcome.status === "failed") result.failed += 1;
  }

  return result;
}
