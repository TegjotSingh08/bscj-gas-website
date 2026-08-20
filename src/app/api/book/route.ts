import { NextResponse } from "next/server";

import { business } from "@/lib/business";
import { bookingConfig } from "@/lib/booking/config";
import { calculatePrice } from "@/lib/booking/pricing";
import {
  checkHold,
  findCompletedBooking,
  markBookingCompleted,
  releaseHold,
} from "@/lib/booking/holds";
import {
  clientKey,
  pruneRateLimits,
  rateLimit,
  rateLimits,
} from "@/lib/booking/rate-limit";
import { bookingSchema, customerTypeLabels } from "@/lib/booking/schema";
import { isSlotStillAvailable } from "@/lib/booking/slots";
import { formatLongDate, isoDateInZone, timeLabelInZone } from "@/lib/booking/time";
import {
  buildEventId,
  CalendarApiError,
  CalendarNotConfiguredError,
  createEvent,
  DuplicateBookingError,
  fetchBusyPeriods,
} from "@/lib/google/calendar";

export const dynamic = "force-dynamic";

/** Strips control characters so nothing odd lands in the calendar entry. */
function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

export async function POST(request: Request) {
  pruneRateLimits();
  const limited = await rateLimit(
    `book:${clientKey(request)}`,
    rateLimits.booking.limit,
    rateLimits.booking.windowSeconds,
  );
  if (!limited.ok) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many booking attempts. Please call us instead.",
      },
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

  const parsed = bookingSchema.safeParse(payload);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "form");
      if (!fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    return NextResponse.json(
      { error: "validation_failed", fieldErrors },
      { status: 400 },
    );
  }

  const data = parsed.data;

  // Honeypot: a filled hidden field means a bot.
  if (data.company) {
    return NextResponse.json({ error: "rejected" }, { status: 400 });
  }

  // A repeat submission of an attempt that already succeeded. Checked before
  // the hold, because a successful booking deletes its own hold — without this
  // a double click would be reported as an expired reservation.
  const alreadyBooked = await findCompletedBooking(data.idempotencyKey);
  if (alreadyBooked) {
    return NextResponse.json(
      { error: "duplicate", message: "That booking has already been made." },
      { status: 409 },
    );
  }

  // The reservation must still exist, belong to this attempt, and match this
  // slot. The browser only carries an opaque token; slot, ownership and expiry
  // are all decided here.
  const hold = await checkHold(data.slotStart, data.holdToken);
  if (hold.status === "expired" || hold.status === "mismatch") {
    return NextResponse.json(
      {
        error: "hold_expired",
        message:
          "Your reserved appointment has expired. Please choose another available time.",
      },
      { status: 409 },
    );
  }
  // hold.status === "unavailable" means the reservation store is unreachable,
  // not that the slot is free. Booking continues, and the Google Calendar
  // re-check below is what keeps it safe — first confirmed wins, exactly as
  // before holds existed. That check is never skipped.

  // Price is always derived here — never taken from the client.
  const price = calculatePrice(data.applianceCount);

  const start = new Date(data.slotStart);
  const end = new Date(start.getTime() + bookingConfig.appointmentMinutes * 60000);
  const now = new Date();

  try {
    // Re-check availability against Google immediately before writing.
    const windowStart = new Date(start.getTime() - 24 * 60 * 60000);
    const windowEnd = new Date(start.getTime() + 24 * 60 * 60000);
    const busy = await fetchBusyPeriods(windowStart, windowEnd);

    if (!isSlotStillAvailable(data.slotStart, busy, now)) {
      return NextResponse.json(
        {
          error: "slot_taken",
          message:
            "Sorry — that appointment has just been taken. Please choose another time.",
        },
        { status: 409 },
      );
    }

    const dateIso = isoDateInZone(start, bookingConfig.timeZone);
    const tenantLine =
      data.tenantName || data.tenantPhone
        ? `Tenant: ${clean(data.tenantName || "not given")} — ${clean(
            data.tenantPhone || "no number",
          )}`
        : "Tenant: not applicable";

    const description = [
      `Customer: ${clean(data.fullName)}`,
      `Phone: ${clean(data.phone)}`,
      `Email: ${clean(data.email)}`,
      `Customer type: ${customerTypeLabels[data.customerType]}`,
      "",
      `Property: ${clean(data.propertyAddress)}, ${clean(data.postcode)}`,
      tenantLine,
      `Access notes: ${clean(data.accessNotes || "none given")}`,
      "",
      `Appliances: ${price.applianceCount}`,
      `Price: £${price.total} total (£${price.basePrice} base${
        price.extraCharge
          ? ` + £${price.extraCharge} for ${price.extraAppliances} extra`
          : ""
      })`,
      "Payment: after completion",
      "",
      "Booking source: website",
    ].join("\n");

    const event = await createEvent({
      eventId: buildEventId(data.slotStart, data.idempotencyKey),
      summary: `CP12 — ${clean(data.propertyAddress)}, ${clean(data.postcode)}`,
      description,
      location: `${clean(data.propertyAddress)}, ${clean(data.postcode)}`,
      start,
      end,
    });

    // The slot is now a real calendar event: the reservation has done its job.
    await markBookingCompleted(data.idempotencyKey, event.id);
    if (typeof data.holdToken === "string") {
      await releaseHold(data.slotStart, data.holdToken);
    }

    return NextResponse.json({
      ok: true,
      booking: {
        eventId: event.id,
        dateLabel: formatLongDate(dateIso, bookingConfig.timeZone),
        startLabel: timeLabelInZone(start, bookingConfig.timeZone),
        endLabel: timeLabelInZone(end, bookingConfig.timeZone),
        propertyAddress: clean(data.propertyAddress),
        postcode: clean(data.postcode),
        priceTotal: price.total,
        priceDisplay: price.totalDisplay,
        contactPhone: business.phoneDisplay,
      },
    });
  } catch (error) {
    if (error instanceof DuplicateBookingError) {
      // A repeat submission of the same attempt. Nothing new was created.
      return NextResponse.json(
        { error: "duplicate", message: "That booking has already been made." },
        { status: 409 },
      );
    }
    if (error instanceof CalendarNotConfiguredError) {
      return NextResponse.json({ error: "not_configured" }, { status: 503 });
    }
    if (error instanceof CalendarApiError) {
      return NextResponse.json({ error: "calendar_unavailable" }, { status: 502 });
    }
    return NextResponse.json({ error: "unknown" }, { status: 500 });
  }
}
