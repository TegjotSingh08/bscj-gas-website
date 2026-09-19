import "server-only";

import { bookingConfig, bookingConfigFor } from "./config";
import { productFor, type ProductId } from "./products";
import { findHeldSlots } from "./holds";
import {
  bookableDates,
  buildAvailability,
  countBookingsByDate,
  type DayAvailability,
  type Interval,
} from "./slots";
import { parseIsoDate, zonedTimeToUtc } from "./time";
import { fetchUnsyncedReservations } from "./reservations";
import {
  CalendarNotConfiguredError,
  fetchBookingEvents,
  fetchBusyPeriods,
  type BookingEvent,
} from "@/lib/google/calendar";

/**
 * What is bookable, in one place.
 *
 * Extracted so the public API route, the tenant's page and the pre-write
 * re-check all ask the same question of the same three sources instead of each
 * assembling their own version of it. The engine itself is still pure and
 * still lives in `slots.ts`; this is the I/O around it.
 *
 * Three sources, and each answers something the others cannot:
 *
 * - **Google free/busy** — which times are occupied, by anything at all,
 *   including the engineer's own diary.
 * - **Google events** — how many of those are customers, which is what the
 *   daily cap counts.
 * - **Postgres** — appointments that are committed but whose calendar write is
 *   `pending` or `failed`, and which Google therefore cannot report. See
 *   `reservations.ts`.
 */

export type AvailabilityOutcome =
  | {
      status: "ok";
      days: DayAvailability[];
      productId: ProductId;
      timeZone: string;
      /**
       * Whether the Postgres reservation check actually ran.
       *
       * False means the database could not be reached and availability fell
       * back to Google alone — the behaviour that existed before reservations
       * were counted at all. It is surfaced rather than hidden because a
       * caller reporting "checked" when it did not would be the worse failure.
       */
      reservationsChecked: boolean;
    }
  | { status: "not_configured" }
  | { status: "calendar_unavailable" };

/** Bookable days and their free slots, from every source that knows. */
export async function loadAvailability(input: {
  productId: ProductId;
  /** The caller's own hold, so their reserved slot stays visible to them. */
  own?: { slotStart: string; token: string };
  /** The caller's own job, so their own unsynced appointment does not hide it. */
  ownJobId?: string;
  now?: Date;
}): Promise<AvailabilityOutcome> {
  const product = productFor(input.productId);
  const config = bookingConfigFor(product.id);
  const now = input.now ?? new Date();

  const dates = bookableDates(now, config);
  const first = parseIsoDate(dates[0]);
  const last = parseIsoDate(dates[dates.length - 1]);
  if (!first || !last) return { status: "calendar_unavailable" };

  const timeMin = zonedTimeToUtc(
    { ...first, hour: 0, minute: 0 },
    bookingConfig.timeZone,
  );
  const timeMax = zonedTimeToUtc(
    { ...last, hour: 23, minute: 59 },
    bookingConfig.timeZone,
  );

  let busy: Interval[];
  let bookings: BookingEvent[];
  try {
    [busy, bookings] = await Promise.all([
      fetchBusyPeriods(timeMin, timeMax),
      fetchBookingEvents(timeMin, timeMax),
    ]);
  } catch (error) {
    if (error instanceof CalendarNotConfiguredError) {
      return { status: "not_configured" };
    }
    /*
      Everything else is `calendar_unavailable` too, deliberately.

      This is now called during a server render, where an escaping throw is a
      500 rather than a failed fetch the picker can report. The calendar client
      signs its own JWT before it reaches the network, so a malformed key is a
      crypto error rather than a `CalendarApiError` — and a tenant meeting a
      blank error page is a worse answer than one being told, truthfully, that
      times cannot be loaded right now.
    */
    return { status: "calendar_unavailable" };
  }

  /*
    Postgres is asked last and is allowed to fail. A database outage must not
    take the public booking flow down with it — but when it answers, what it
    says is added to Google's picture rather than compared with it, because
    the two describe different appointments by construction: anything Postgres
    reports here is `pending` or `failed`, which is exactly the set Google has
    not been told about.
  */
  const reserved = await fetchUnsyncedReservations(timeMin, timeMax, input.ownJobId);
  const reservations = reserved.status === "ok" ? reserved.reservations : [];

  /*
    A job mid-reschedule is in Google at its old time and in Postgres at its
    new one, until cleanup removes the old event. Counting both would spend two
    of the day's ten places on one visit — so the superseded event is dropped
    from the count. Its *times* still block their slot, which is right: the
    entry really is in the diary until it is deleted.
  */
  const superseded = new Set(
    reserved.status === "ok" ? reserved.supersededEventIds : [],
  );

  const bookingCounts = countBookingsByDate(
    [
      ...bookings.filter((booking) => !superseded.has(booking.id)),
      ...reservations.map((slot) => ({ start: slot.start })),
    ],
    config,
  );

  const days = buildAvailability(
    dates,
    [...busy, ...reservations],
    now,
    config,
    bookingCounts,
  );

  // Slots reserved by another customer in Redis. An unreachable store returns
  // nothing held, and availability falls back to the two checks above.
  const candidateSlots = days.flatMap((day) =>
    day.slots.map((slot) => slot.startIso),
  );
  // Guarded for the same reason: an unexpected store error during a server
  // render is a blank page, and an unknown hold is not a reason to hide a slot.
  let held: Set<string>;
  try {
    held = await findHeldSlots(candidateSlots, input.own);
  } catch {
    held = new Set();
  }

  return {
    status: "ok",
    days: days.map((day) => ({
      date: day.date,
      slots: day.slots.filter((slot) => !held.has(slot.startIso)),
    })),
    productId: product.id,
    timeZone: bookingConfig.timeZone,
    reservationsChecked: reserved.status === "ok",
  };
}
