import { NextResponse } from "next/server";

import { bookingConfig } from "@/lib/booking/config";
import { rateLimit, clientKey, pruneRateLimits } from "@/lib/booking/rate-limit";
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
 * engineer's calendar cross this boundary.
 */
export async function GET(request: Request) {
  pruneRateLimits();
  const limited = rateLimit(`availability:${clientKey(request)}`, 60, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }

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
    return NextResponse.json(
      { days, timeZone: bookingConfig.timeZone },
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
