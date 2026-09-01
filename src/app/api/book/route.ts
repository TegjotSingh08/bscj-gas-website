import { NextResponse } from "next/server";

import { business, serviceAreaCopy } from "@/lib/business";
import { bookingConfig, bookingConfigFor } from "@/lib/booking/config";
import { productFor } from "@/lib/booking/products";
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
import {
  countBookingsByDate,
  isDayFullyBooked,
  isSlotStillAvailable,
} from "@/lib/booking/slots";
import {
  acquireDailyBookingLock,
  releaseDailyBookingLock,
} from "@/lib/booking/daily-limit";
import { bookingReference } from "@/lib/booking/reference";
import {
  cancellationPeriodLastDate,
  checkTermsAcceptance,
  termsProblemMessage,
  TERMS_VERSION,
} from "@/lib/booking/terms";
import { buildPropertyAddress, formatAddressLines } from "@/lib/address/format";
import { PostcodesIoProvider } from "@/lib/address/postcodes-io";
import { checkServiceArea } from "@/lib/address/service-area";
import {
  formatLongDate,
  isoDateInZone,
  parseIsoDate,
  timeLabelInZone,
  zonedTimeToUtc,
} from "@/lib/booking/time";
import { renderBookingConfirmationEmail } from "@/lib/email/booking-confirmation";
import {
  isSameDay,
  renderBookingNotificationEmail,
} from "@/lib/email/booking-notification";
import {
  sendBookingConfirmation,
  sendBookingNotification,
} from "@/lib/email/send";
import {
  buildEventId,
  CalendarApiError,
  CalendarNotConfiguredError,
  createEvent,
  DuplicateBookingError,
  fetchBookingEvents,
  fetchBusyPeriods,
} from "@/lib/google/calendar";

export const dynamic = "force-dynamic";

const postcodes = new PostcodesIoProvider();

/** "Thursday 20 August" for the email subject, in the booking timezone. */
function formatSubjectDate(isoDate: string, timeZone: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(Date.UTC(year, month - 1, day, 12));
}

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

  // The service being booked. The schema has already refused any id outside
  // the registry, so from here the name, the price and the appointment length
  // are the server's own — a request states none of them.
  const product = productFor(data.productId);
  const config = bookingConfigFor(product.id);

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

  // ---------------------------------------------------------------
  // The contractual gate.
  //
  // Whether the appointment falls inside the statutory cancellation period is
  // recomputed here from the slot and the current time. The browser sends
  // whether the customer *ticked* the request, never whether one was needed —
  // so editing client state cannot make the requirement disappear.
  // ---------------------------------------------------------------
  const contractMadeAt = new Date();
  const terms = checkTermsAcceptance({
    termsVersion: data.termsVersion,
    termsAccepted: data.termsAccepted,
    earlyPerformanceRequested: data.earlyPerformanceRequested,
    slotStart: new Date(data.slotStart),
    contractMadeAt,
    timeZone: bookingConfig.timeZone,
  });

  if (!terms.ok) {
    return NextResponse.json(
      {
        error: "terms_required",
        problem: terms.problem,
        message: termsProblemMessage(terms.problem),
      },
      { status: 400 },
    );
  }

  // ---------------------------------------------------------------
  // The address is re-established here from the postcode provider and the
  // server's own verification record. Nothing about the address is taken on
  // the browser's word — a request claiming a verified address proves nothing.
  // ---------------------------------------------------------------
  const postcodeLookup = await postcodes.lookup(data.postcode);
  if (postcodeLookup.status === "not_found" || postcodeLookup.status === "malformed") {
    return NextResponse.json(
      {
        error: "validation_failed",
        fieldErrors: { postcode: "We couldn't find that postcode. Check it and try again." },
      },
      { status: 400 },
    );
  }
  if (postcodeLookup.status === "provider_unavailable") {
    return NextResponse.json(
      {
        error: "postcode_unavailable",
        message:
          "We couldn't verify the postcode right now. Please try again, or call or WhatsApp us to book.",
      },
      { status: 503 },
    );
  }
  // Coverage is decided from the coordinates the postcode provider returned,
  // never from a town name the browser sent.
  if (!checkServiceArea(postcodeLookup.postcode).covered) {
    return NextResponse.json(
      { error: "outside_area", message: serviceAreaCopy.outsideArea },
      { status: 400 },
    );
  }

  // The schema already requires addressConfirmedByCustomer to be literally
  // true, so a submission without it never reaches this point.
  const property = buildPropertyAddress({
    houseOrName: data.houseOrName,
    street: data.street,
    postcode: postcodeLookup.postcode,
    confirmedByCustomer: data.addressConfirmedByCustomer,
  });

  // Price is always derived here — never taken from the client.
  const price = calculatePrice(data.applianceCount, product.id);

  const start = new Date(data.slotStart);
  // The appointment length comes from the product, so a request cannot make a
  // 60-minute job occupy a 45-minute space in the diary, or the reverse.
  const end = new Date(start.getTime() + product.durationMinutes * 60000);
  const now = new Date();

  const bookingDate = isoDateInZone(start, bookingConfig.timeZone);

  /*
    The daily cap is decided from Google, but counting and then writing is two
    steps. Without this, two customers confirming for the same day at the same
    moment could both count nine and both write a tenth. The lock serialises
    them for that date, so the second one counts after the first has landed.

    "unavailable" means there is no reservation store, not that the day is
    free: the booking goes ahead on the Google count alone, which is the
    protection that existed before the cap was enforced at all. Failing real
    bookings because Redis is down would be the worse outcome.
  */
  const dayLock = await acquireDailyBookingLock(bookingDate);
  if (dayLock.status === "busy") {
    return NextResponse.json(
      {
        error: "day_busy",
        message:
          "Someone else is confirming a booking for that day. Please try again in a moment.",
      },
      { status: 409 },
    );
  }

  try {
    // Re-check availability against Google immediately before writing.
    const windowStart = new Date(start.getTime() - 24 * 60 * 60000);
    const windowEnd = new Date(start.getTime() + 24 * 60 * 60000);
    const busy = await fetchBusyPeriods(windowStart, windowEnd);

    if (!isSlotStillAvailable(data.slotStart, busy, now, config)) {
      return NextResponse.json(
        {
          error: "slot_taken",
          message:
            "Sorry — that appointment has just been taken. Please choose another time.",
        },
        { status: 409 },
      );
    }

    /*
      The cap, re-derived here rather than trusted from whatever the browser
      was shown. Counted in customer bookings, so the engineer's own diary
      entries block times without consuming the day's capacity.
    */
    const dayStart = zonedTimeToUtc(
      { ...parseIsoDate(bookingDate)!, hour: 0, minute: 0 },
      bookingConfig.timeZone,
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60000);
    const bookingCounts = countBookingsByDate(
      await fetchBookingEvents(dayStart, dayEnd),
      config,
    );

    if (isDayFullyBooked(bookingCounts, bookingDate, config)) {
      return NextResponse.json(
        {
          error: "day_full",
          message:
            "Sorry — that day is now fully booked. Please choose another date.",
        },
        { status: 409 },
      );
    }

    const dateIso = bookingDate;
    const tenantLine =
      data.tenantName || data.tenantPhone
        ? `Tenant: ${clean(data.tenantName || "not given")} — ${clean(
            data.tenantPhone || "no number",
          )}`
        : "Tenant: not applicable";

    // The calendar event is the only record this version keeps, so it carries
    // a short contractual footer: what was accepted, and whether the customer
    // asked for the work inside their cancellation period. Non-sensitive by
    // design — no hold token, no idempotency key, no credential.
    const cancellationLastDate = cancellationPeriodLastDate(
      contractMadeAt,
      bookingConfig.timeZone,
    );

    const description = [
      `Service: ${product.name}`,
      `Appointment: ${product.durationMinutes} minutes`,
      "",
      `Customer: ${clean(data.fullName)}`,
      `Phone: ${clean(data.phone)}`,
      `Email: ${clean(data.email)}`,
      `Customer type: ${customerTypeLabels[data.customerType]}`,
      "",
      `Property: ${property.formattedAddress}`,
      tenantLine,
      `Access notes: ${clean(data.accessNotes || "none given")}`,
      "Address: confirmed by customer at booking",
      "",
      // Omitted where it means nothing: a standalone boiler service is one
      // boiler at a fixed price, so an appliance count on the job sheet would
      // describe work that is not being done.
      ...(price.appliancePricing
        ? [`Appliances: ${price.applianceCount}`]
        : []),
      `Price: £${price.total} total (£${price.basePrice} base${
        price.extraCharge
          ? ` + £${price.extraCharge} for ${price.extraAppliances} extra`
          : ""
      })`,
      "Payment: after completion",
      "",
      `Terms accepted: v${TERMS_VERSION}`,
      `Cancellation period ends: ${formatLongDate(cancellationLastDate, bookingConfig.timeZone)}`,
      terms.earlyPerformanceRequired
        ? "Early-start requested: yes — appointment is inside the cancellation period"
        : "Early-start requested: not needed — appointment is outside the cancellation period",
      "",
      "Booking source: website",
    ].join("\n");

    const event = await createEvent({
      eventId: buildEventId(data.slotStart, data.idempotencyKey),
      summary: `${product.calendarName} — ${property.formattedAddress}`,
      description,
      location: property.formattedAddress,
      start,
      end,
    });

    // ---------------------------------------------------------------
    // From this point the appointment EXISTS. Nothing below may fail the
    // booking: the calendar event is the source of truth and it is written.
    // ---------------------------------------------------------------

    // The slot is now a real calendar event: the reservation has done its job.
    await markBookingCompleted(data.idempotencyKey, event.id);
    if (typeof data.holdToken === "string") {
      // Releases every start the booking reserved, not just the one clicked.
      await releaseHold(data.slotStart, data.holdToken, product.id);
    }

    const reference = bookingReference(event.id);
    const dateLabel = formatLongDate(dateIso, bookingConfig.timeZone);
    const startLabel = timeLabelInZone(start, bookingConfig.timeZone);
    const endLabel = timeLabelInZone(end, bookingConfig.timeZone);

    const confirmationEmail = renderBookingConfirmationEmail({
      reference,
      customerName: clean(data.fullName),
      dateLabel,
      startLabel,
      endLabel,
      subjectDateLabel: formatSubjectDate(dateIso, bookingConfig.timeZone),
      addressLines: formatAddressLines(property),
      productName: product.name,
      productSubjectName: product.subjectName,
      workDescription: product.workDescription,
      appointmentMinutes: product.durationMinutes,
      applianceCount: price.appliancePricing ? price.applianceCount : null,
      // Server-derived total, never the figure the browser displayed.
      priceTotal: price.total,
      // Regulation 16 confirmation: the cancellation information travels in
      // the email body itself, because an email is a durable medium but a
      // link inside one is not.
      termsVersion: TERMS_VERSION,
      cancellationLastDateLabel: formatLongDate(
        cancellationLastDate,
        bookingConfig.timeZone,
      ),
      earlyPerformanceRequested: terms.earlyPerformanceRequired,
    });

    // sendBookingConfirmation never throws, so this cannot turn a confirmed
    // appointment into a failed one. A failure becomes a warning on screen.
    const emailResult = await sendBookingConfirmation({
      to: data.email,
      email: confirmationEmail,
      reference,
    });

    // ---------------------------------------------------------------
    // Internal alert.
    //
    // A booking otherwise only appears quietly in the calendar, which is not
    // good enough when someone can book a slot for later the same day. Sent
    // after the customer's own confirmation, and — like it — unable to fail
    // the booking: the transport returns every failure as a value.
    //
    // The customer is never told whether this succeeded. It is not their
    // problem, and a warning about our own alerting would only worry them.
    // ---------------------------------------------------------------
    const sameDay = isSameDay(start, now, bookingConfig.timeZone);

    await sendBookingNotification({
      reference,
      customerEmail: data.email,
      email: renderBookingNotificationEmail({
        reference,
        dateLabel,
        subjectDateLabel: formatSubjectDate(dateIso, bookingConfig.timeZone),
        startLabel,
        endLabel,
        addressLines: formatAddressLines(property),
        postcode: property.postcode,
        productName: product.name,
        productSubjectName: product.subjectName,
        customerName: clean(data.fullName),
        customerPhone: clean(data.phone),
        customerEmail: data.email,
        customerType: customerTypeLabels[data.customerType],
        applianceCount: price.appliancePricing ? price.applianceCount : null,
        priceTotal: price.total,
        sameDay,
        accessNotes: clean(data.accessNotes || ""),
        tenantName: clean(data.tenantName || ""),
        tenantPhone: clean(data.tenantPhone || ""),
      }),
    });

    return NextResponse.json({
      ok: true,
      booking: {
        reference,
        productId: product.id,
        productName: product.name,
        dateLabel,
        startLabel,
        endLabel,
        propertyAddress: property.formattedAddress,
        postcode: property.postcode,
        priceTotal: price.total,
        priceDisplay: price.totalDisplay,
        contactPhone: business.phoneDisplay,
        customerEmail: data.email,
        emailSent: emailResult.status === "sent",
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
  } finally {
    // Every path, including the early returns above and a thrown error. The
    // 15-second TTL is only the backstop for a request that dies outright.
    if (dayLock.status === "acquired") {
      await releaseDailyBookingLock(bookingDate, dayLock.token);
    }
  }
}
