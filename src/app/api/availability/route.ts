import { NextResponse } from "next/server";

import { bookingConfig } from "@/lib/booking/config";
import { findHeldSlots, isWellFormedToken } from "@/lib/booking/holds";
import {
  clientKey,
  pruneRateLimits,
  rateLimit,
  rateLimits,
} from "@/lib/booking/rate-limit";
import { bookableDates, buildAvailability } from "@/lib/booking/slots";
import { parseIsoDate, zonedTimeToUtc } from "@/lib/booking/time";
import {
  CalendarApiError,
  CalendarNotConfiguredError,
  fetchBusyPeriods,
} from "@/lib/google/calendar";

export const dynamic = "force-dynamic";

/**
 * Returns bookable dates and their free slots.
 *
 * Only times are ever returned — no event titles, guests or details from the
 * engineer's calendar, and no other customer's hold id. A slot reserved by
 * someone else simply does not appear.
 *
 * The caller may present their own hold in headers (not the query string, so
 * the token stays out of logs and history) to keep their reserved slot visible
 * to them.
 */
export async function GET(request: Request) {
  pruneRateLimits();
  const limited = await rateLimit(
    `availability:${clientKey(request)}`,
    rateLimits.availability.limit,
    rateLimits.availability.windowSeconds,
  );
  if (!limited.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(limited.retryAfterSeconds) },
      },
    );
  }

  const ownSlot = request.headers.get("x-hold-slot");
  const ownToken = request.headers.get("x-hold-token");
  const own =
    ownSlot && isWellFormedToken(ownToken)
      ? { slotStart: ownSlot, token: ownToken }
      : undefined;

  const now = new Date();
  const dates = bookableDates(now);

  const first = parseIsoDate(dates[0]);
  const last = parseIsoDate(dates[dates.length - 1]);
  if (!first || !last) {
    return NextResponse.json({ error: "bad_range" }, { status: 500 });
  }

  const timeMin = zonedTimeToUtc({ ...first, hour: 0, minute: 0 }, bookingConfig.timeZone);
  const timeMax = zonedTimeToUtc({ ...last, hour: 23, minute: 59 }, bookingConfig.timeZone);

  try {
    const busy = await fetchBusyPeriods(timeMin, timeMax);
    const days = buildAvailability(dates, busy, now);

    // Remove slots reserved by other customers. If the store is unreachable
    // this returns nothing held, and availability falls back to Google alone —
    // the behaviour that existed before holds, where first confirmed wins.
    const candidateSlots = days.flatMap((day) =>
      day.slots.map((slot) => slot.startIso),
    );
    const held = await findHeldSlots(candidateSlots, own);

    const withoutHeld = days.map((day) => ({
      date: day.date,
      slots: day.slots.filter((slot) => !held.has(slot.startIso)),
    }));

    return NextResponse.json(
      { days: withoutHeld, timeZone: bookingConfig.timeZone },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof CalendarNotConfiguredError) {
      return NextResponse.json({ error: "not_configured" }, { status: 503 });
    }
    if (error instanceof CalendarApiError) {
      return NextResponse.json({ error: "calendar_unavailable" }, { status: 502 });
    }
    return NextResponse.json({ error: "unknown" }, { status: 500 });
  }
}
