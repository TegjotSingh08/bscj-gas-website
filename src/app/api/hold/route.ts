import { NextResponse } from "next/server";
import { z } from "zod";

import { bookingConfig, bookingConfigFor } from "@/lib/booking/config";
import {
  acquireHold,
  HOLD_DURATION_SECONDS,
  isWellFormedToken,
  releaseHold,
} from "@/lib/booking/holds";
import { PRODUCT_IDS, DEFAULT_PRODUCT_ID, productFor } from "@/lib/booking/products";
import {
  clientKey,
  pruneRateLimits,
  rateLimit,
  rateLimits,
} from "@/lib/booking/rate-limit";
import { isSlotStillAvailable } from "@/lib/booking/slots";
import {
  CalendarApiError,
  CalendarNotConfiguredError,
  fetchBusyPeriods,
} from "@/lib/google/calendar";

export const dynamic = "force-dynamic";

/** The appointment end, derived from the product — never from the request. */
function slotEndFor(slotStartIso: string, durationMinutes: number): string {
  return new Date(
    new Date(slotStartIso).getTime() + durationMinutes * 60000,
  ).toISOString();
}

/**
 * The browser names a product; it never states a duration. Anything outside
 * the registry is refused outright, and an absent id is the CP12 — so a
 * request written before products existed still reserves a 45-minute slot.
 */
const productId = z.enum(PRODUCT_IDS).default(DEFAULT_PRODUCT_ID);

const acquireSchema = z.object({
  slotStart: z.string().datetime(),
  productId,
  previous: z
    .object({
      slotStart: z.string().datetime(),
      token: z.string().regex(/^[0-9a-f]{64}$/),
      productId,
    })
    .optional(),
});

const releaseSchema = z.object({
  slotStart: z.string().datetime(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  productId,
});

/** Reserves a slot for this customer while they finish the booking. */
export async function POST(request: Request) {
  pruneRateLimits();
  const limited = await rateLimit(
    `hold:${clientKey(request)}`,
    rateLimits.hold.limit,
    rateLimits.hold.windowSeconds,
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

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const parsed = acquireSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { slotStart, previous } = parsed.data;
  const product = productFor(parsed.data.productId);
  // Every availability decision below is made with THIS product's length.
  const config = bookingConfigFor(product.id);
  const now = new Date();

  // The slot must be a real configured slot and still free in Google before
  // anything is reserved — a hold must never outrank the calendar.
  try {
    const windowStart = new Date(new Date(slotStart).getTime() - 24 * 60 * 60000);
    const windowEnd = new Date(new Date(slotStart).getTime() + 24 * 60 * 60000);
    const busy = await fetchBusyPeriods(windowStart, windowEnd);

    if (!isSlotStillAvailable(slotStart, busy, now, config)) {
      return NextResponse.json(
        {
          error: "slot_taken",
          message:
            "Sorry — that appointment has just been taken. Please choose another time.",
        },
        { status: 409 },
      );
    }
  } catch (error) {
    if (error instanceof CalendarNotConfiguredError) {
      return NextResponse.json({ error: "not_configured" }, { status: 503 });
    }
    if (error instanceof CalendarApiError) {
      return NextResponse.json({ error: "calendar_unavailable" }, { status: 502 });
    }
    return NextResponse.json({ error: "unknown" }, { status: 500 });
  }

  const outcome = await acquireHold(slotStart, product.id, previous);

  if (outcome.status === "taken") {
    return NextResponse.json(
      {
        error: "slot_taken",
        message:
          "Sorry — someone else is booking that appointment. Please choose another time.",
      },
      { status: 409 },
    );
  }

  if (outcome.status === "unavailable") {
    // No reservation store. Booking still works: the customer proceeds and
    // Google Calendar decides at confirmation, first confirmed wins.
    return NextResponse.json({
      held: false,
      degraded: true,
      slotStart,
      slotEnd: slotEndFor(slotStart, product.durationMinutes),
      productId: product.id,
      timeZone: bookingConfig.timeZone,
    });
  }

  return NextResponse.json({
    held: true,
    degraded: false,
    token: outcome.token,
    slotStart: outcome.slotStart,
    // Server-derived: the browser is told when the appointment ends, it never
    // says so itself.
    slotEnd: slotEndFor(outcome.slotStart, product.durationMinutes),
    productId: product.id,
    expiresAt: outcome.expiresAt,
    durationSeconds: HOLD_DURATION_SECONDS,
    timeZone: bookingConfig.timeZone,
  });
}

/** Releases a hold the customer no longer needs. */
export async function DELETE(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const parsed = releaseSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!isWellFormedToken(parsed.data.token)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const released = await releaseHold(
    parsed.data.slotStart,
    parsed.data.token,
    parsed.data.productId,
  );
  return NextResponse.json({ released });
}
