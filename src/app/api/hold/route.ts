import { NextResponse } from "next/server";
import { z } from "zod";

import { bookingConfig } from "@/lib/booking/config";
import {
  acquireHold,
  HOLD_DURATION_SECONDS,
  isWellFormedToken,
  releaseHold,
} from "@/lib/booking/holds";
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

const acquireSchema = z.object({
  slotStart: z.string().datetime(),
  previous: z
    .object({
      slotStart: z.string().datetime(),
      token: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
});

const releaseSchema = z.object({
  slotStart: z.string().datetime(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
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
  const now = new Date();

  // The slot must be a real configured slot and still free in Google before
  // anything is reserved — a hold must never outrank the calendar.
  try {
    const windowStart = new Date(new Date(slotStart).getTime() - 24 * 60 * 60000);
    const windowEnd = new Date(new Date(slotStart).getTime() + 24 * 60 * 60000);
    const busy = await fetchBusyPeriods(windowStart, windowEnd);

    if (!isSlotStillAvailable(slotStart, busy, now)) {
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

  const outcome = await acquireHold(slotStart, previous);

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
      timeZone: bookingConfig.timeZone,
    });
  }

  return NextResponse.json({
    held: true,
    degraded: false,
    token: outcome.token,
    slotStart: outcome.slotStart,
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

  const released = await releaseHold(parsed.data.slotStart, parsed.data.token);
  return NextResponse.json({ released });
}
