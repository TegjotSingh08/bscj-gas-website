import { NextResponse } from "next/server";

import { bookingConfig, bookingConfigFor } from "@/lib/booking/config";
import { isProductId, productFor, DEFAULT_PRODUCT_ID } from "@/lib/booking/products";
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
 *
 * Availability is product-aware, because the two products are different
 * lengths and so rule out different times. `?product=` names one; omitting it
 * asks for the CP12, which is what every caller written before products did.
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

  // An unrecognised product is refused rather than quietly answered with the
  // CP12's times, which would offer a bundle customer slots it cannot honour.
  const requestedProduct = new URL(request.url).searchParams.get("product");
  if (requestedProduct !== null && !isProductId(requestedProduct)) {
    return NextResponse.json({ error: "bad_product" }, { status: 400 });
  }
  const product = productFor(requestedProduct ?? DEFAULT_PRODUCT_ID);
  const config = bookingConfigFor(product.id);

  const ownSlot = request.headers.get("x-hold-slot");
  const ownToken = request.headers.get("x-hold-token");
  const own =
    ownSlot && isWellFormedToken(ownToken)
      ? { slotStart: ownSlot, token: ownToken }
      : undefined;

  const now = new Date();
  const dates = bookableDates(now, config);

  const first = parseIsoDate(dates[0]);
  const last = parseIsoDate(dates[dates.length - 1]);
  if (!first || !last) {
    return NextResponse.json({ error: "bad_range" }, { status: 500 });
  }

  const timeMin = zonedTimeToUtc({ ...first, hour: 0, minute: 0 }, bookingConfig.timeZone);
  const timeMax = zonedTimeToUtc({ ...last, hour: 23, minute: 59 }, bookingConfig.timeZone);

  try {
    const busy = await fetchBusyPeriods(timeMin, timeMax);
    const days = buildAvailability(dates, busy, now, config);

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
      {
        days: withoutHeld,
        productId: product.id,
        timeZone: bookingConfig.timeZone,
      },
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
