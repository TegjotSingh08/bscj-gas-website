import { NextResponse } from "next/server";

import { isProductId, DEFAULT_PRODUCT_ID } from "@/lib/booking/products";
import { isWellFormedToken } from "@/lib/booking/holds";
import { loadAvailability } from "@/lib/booking/availability";
import {
  clientKey,
  pruneRateLimits,
  rateLimit,
  rateLimits,
} from "@/lib/booking/rate-limit";

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
 *
 * The three sources it is computed from — Google free/busy, Google events and
 * committed-but-unsynced jobs in Postgres — live in `lib/booking/availability`
 * so this route, the tenant's page and the pre-write re-check cannot drift
 * apart. `reservationsChecked` is deliberately not in the response: it is an
 * internal degradation signal, and a customer has no use for it.
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

  const ownSlot = request.headers.get("x-hold-slot");
  const ownToken = request.headers.get("x-hold-token");
  const own =
    ownSlot && isWellFormedToken(ownToken)
      ? { slotStart: ownSlot, token: ownToken }
      : undefined;

  try {
    const result = await loadAvailability({
      productId: requestedProduct ?? DEFAULT_PRODUCT_ID,
      own,
    });

    if (result.status === "not_configured") {
      return NextResponse.json({ error: "not_configured" }, { status: 503 });
    }
    if (result.status === "calendar_unavailable") {
      return NextResponse.json({ error: "calendar_unavailable" }, { status: 502 });
    }

    return NextResponse.json(
      {
        days: result.days,
        productId: result.productId,
        timeZone: result.timeZone,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "unknown" }, { status: 500 });
  }
}
