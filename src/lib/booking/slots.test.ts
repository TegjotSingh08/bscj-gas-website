import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { blockMinutesFor, bookingConfig, bookingConfigFor } from "./config";
import {
  bookableDates,
  buildAvailability,
  candidateSlotsForDate,
  countBookingsByDate,
  isDayFullyBooked,
  filterAvailableSlots,
  isSlotStillAvailable,
  type Interval,
} from "./slots";
import { calculatePrice } from "./pricing";
import { bookingSchema } from "./schema";
import { TERMS_VERSION } from "./terms";
import { formatLongDate, isoDateInZone, timeLabelInZone, zonedTimeToUtc } from "./time";

/** A Wednesday in British Summer Time. */
const BST_WEDNESDAY = "2026-08-19";
/** A Wednesday in Greenwich Mean Time. */
const GMT_WEDNESDAY = "2026-01-21";
/** A Saturday — the one non-working weekday. */
const SATURDAY = "2026-08-22";

function at(iso: string, hour: number, minute = 0): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return zonedTimeToUtc({ year, month, day, hour, minute }, bookingConfig.timeZone);
}

describe("working hours generation", () => {
  test("slots run from 10:00 and stop when the appointment would overrun", () => {
    const slots = candidateSlotsForDate(BST_WEDNESDAY);
    const labels = slots.map((s) => timeLabelInZone(s.start, bookingConfig.timeZone));

    assert.equal(labels[0], "10:00");
    // 21:00 + 45min = 21:45, inside hours. 22:00 + 45min would overrun, so
    // 21:00 is the last start.
    assert.equal(labels.at(-1), "21:00");
    assert.equal(labels.length, 12);
  });

  test("appointment length and buffer come from the shared config", () => {
    assert.equal(bookingConfig.appointmentMinutes, 45);
    assert.equal(bookingConfig.bufferMinutes, 15);
    assert.equal(blockMinutesFor(bookingConfig), 60);
  });

  test("no slots are offered on a Saturday", () => {
    assert.deepEqual(candidateSlotsForDate(SATURDAY), []);
  });

  test("Sunday is a working day", () => {
    // 2026-08-23 is a Sunday.
    assert.ok(candidateSlotsForDate("2026-08-23").length > 0);
  });

  test("a malformed date yields no slots rather than throwing", () => {
    assert.deepEqual(candidateSlotsForDate("not-a-date"), []);
    assert.deepEqual(candidateSlotsForDate("2026-13-01"), []);
  });
});

describe("timezone handling", () => {
  test("10:00 London in summer is 09:00 UTC", () => {
    const [first] = candidateSlotsForDate(BST_WEDNESDAY);
    assert.equal(first.start.toISOString(), "2026-08-19T09:00:00.000Z");
  });

  test("10:00 London in winter is 10:00 UTC", () => {
    const [first] = candidateSlotsForDate(GMT_WEDNESDAY);
    assert.equal(first.start.toISOString(), "2026-01-21T10:00:00.000Z");
  });

  test("a slot keeps its London label across the DST boundary", () => {
    const summer = candidateSlotsForDate(BST_WEDNESDAY)[0].start;
    const winter = candidateSlotsForDate(GMT_WEDNESDAY)[0].start;
    assert.equal(timeLabelInZone(summer, bookingConfig.timeZone), "10:00");
    assert.equal(timeLabelInZone(winter, bookingConfig.timeZone), "10:00");
  });

  test("a late-evening instant reports the correct London date", () => {
    // 22:30 UTC in summer is 23:30 the same day in London.
    assert.equal(
      isoDateInZone(new Date("2026-08-19T22:30:00Z"), bookingConfig.timeZone),
      "2026-08-19",
    );
    // 23:30 UTC in summer is 00:30 the *next* day in London.
    assert.equal(
      isoDateInZone(new Date("2026-08-19T23:30:00Z"), bookingConfig.timeZone),
      "2026-08-20",
    );
  });

  test("long date formatting does not drift a day", () => {
    assert.equal(
      formatLongDate("2026-08-19", bookingConfig.timeZone),
      "Wednesday, 19 August 2026",
    );
    assert.equal(
      formatLongDate("2026-01-01", bookingConfig.timeZone),
      "Thursday, 1 January 2026",
    );
  });
});

describe("busy slot removal and buffers", () => {
  // The day before, so the 12-hour notice rule never masks the buffer logic.
  const now = at("2026-08-18", 6);

  test("a busy period removes the slot it overlaps", () => {
    const busy: Interval[] = [
      { start: at(BST_WEDNESDAY, 13), end: at(BST_WEDNESDAY, 13, 45) },
    ];
    const free = filterAvailableSlots(candidateSlotsForDate(BST_WEDNESDAY), busy, now);
    const labels = free.map((s) => timeLabelInZone(s.start, bookingConfig.timeZone));
    assert.ok(!labels.includes("13:00"));
  });

  test("the buffer also blocks the slot either side of a busy period", () => {
    const busy: Interval[] = [
      { start: at(BST_WEDNESDAY, 13), end: at(BST_WEDNESDAY, 13, 45) },
    ];
    const labels = filterAvailableSlots(
      candidateSlotsForDate(BST_WEDNESDAY),
      busy,
      now,
    ).map((s) => timeLabelInZone(s.start, bookingConfig.timeZone));

    // 12:00 job ends 12:45, and 13:00 busy padded back to 12:45 — touching,
    // not overlapping, so 12:00 survives.
    assert.ok(labels.includes("12:00"));
    // 14:00 starts exactly when the padded busy period ends, so it survives.
    assert.ok(labels.includes("14:00"));
    // The overlapping slot itself is gone.
    assert.ok(!labels.includes("13:00"));
  });

  test("an all-day busy period clears the whole day", () => {
    const busy: Interval[] = [
      { start: at(BST_WEDNESDAY, 0), end: at(BST_WEDNESDAY, 23, 59) },
    ];
    assert.equal(
      filterAvailableSlots(candidateSlotsForDate(BST_WEDNESDAY), busy, now).length,
      0,
    );
  });

  test("busy periods on another day do not affect this one", () => {
    const busy: Interval[] = [
      { start: at("2026-08-20", 13), end: at("2026-08-20", 13, 45) },
    ];
    assert.equal(
      filterAvailableSlots(candidateSlotsForDate(BST_WEDNESDAY), busy, now).length,
      12,
    );
  });
});

describe("minimum booking notice", () => {
  test("slots inside the notice window are withheld", () => {
    // 10:00 London on the day: the 12-hour cutoff lands at 22:00, past the
    // last start of 21:00.
    const now = at(BST_WEDNESDAY, 10);
    const free = filterAvailableSlots(candidateSlotsForDate(BST_WEDNESDAY), [], now);
    assert.equal(free.length, 0);
  });

  test("slots beyond the notice window are offered", () => {
    // 05:00 London: cutoff is 17:00, so everything from 17:00 remains.
    const now = at(BST_WEDNESDAY, 5);
    const labels = filterAvailableSlots(
      candidateSlotsForDate(BST_WEDNESDAY),
      [],
      now,
    ).map((s) => timeLabelInZone(s.start, bookingConfig.timeZone));
    assert.deepEqual(labels, ["17:00", "18:00", "19:00", "20:00", "21:00"]);
  });

  test("the notice period is exactly the configured number of hours", () => {
    assert.equal(bookingConfig.minimumNoticeHours, 12);
  });

  test("the bookable window covers the configured advance horizon", () => {
    const dates = bookableDates(at(BST_WEDNESDAY, 9));
    assert.equal(dates.length, bookingConfig.maximumAdvanceDays + 1);
    assert.equal(dates[0], BST_WEDNESDAY);
  });
});

/**
 * The cap counts customers, not diary entries.
 *
 * It used to count busy periods, which meant the engineer's own calendar ate
 * the day's capacity — the weekday school run alone would have spent two of
 * them. Bookings and busy periods are now separate inputs, and only bookings
 * consume a seat.
 */
describe("daily booking cap", () => {
  /** `count` customer bookings on one date, at successive hours. */
  function bookingsOn(isoDate: string, count: number) {
    return Array.from({ length: count }, (_, index) => ({
      start: at(isoDate, 10 + index),
    }));
  }

  test("the cap is ten customer bookings a day", () => {
    assert.equal(bookingConfig.maximumBookingsPerDay, 10);
  });

  test("nine bookings still leaves the day open", () => {
    const counts = countBookingsByDate(bookingsOn(BST_WEDNESDAY, 9));
    assert.equal(counts.get(BST_WEDNESDAY), 9);
    assert.equal(isDayFullyBooked(counts, BST_WEDNESDAY), false);

    const [day] = buildAvailability(
      [BST_WEDNESDAY],
      [],
      at("2026-08-18", 6),
      bookingConfig,
      counts,
    );
    assert.ok(day.slots.length > 0, "a ninth booking closed the day");
  });

  test("ten bookings offers nothing further", () => {
    const counts = countBookingsByDate(bookingsOn(BST_WEDNESDAY, 10));
    assert.equal(isDayFullyBooked(counts, BST_WEDNESDAY), true);

    const [day] = buildAvailability(
      [BST_WEDNESDAY],
      [],
      at("2026-08-18", 6),
      bookingConfig,
      counts,
    );
    assert.deepEqual(day.slots, []);
  });

  test("a slot on a full day fails the confirmation re-check too", () => {
    const counts = countBookingsByDate(bookingsOn(BST_WEDNESDAY, 10));
    assert.equal(
      isSlotStillAvailable(
        at(BST_WEDNESDAY, 14).toISOString(),
        [],
        at("2026-08-18", 6),
        bookingConfig,
        counts,
      ),
      false,
    );
  });

  test("an ordinary blocking event costs times, not capacity", () => {
    // The school run: 15:00-17:00 on the diary, and not a customer.
    const schoolRun: Interval[] = [
      { start: at(BST_WEDNESDAY, 15), end: at(BST_WEDNESDAY, 17) },
    ];
    const counts = countBookingsByDate([]);

    assert.equal(counts.get(BST_WEDNESDAY), undefined);
    assert.equal(isDayFullyBooked(counts, BST_WEDNESDAY), false);

    const [day] = buildAvailability(
      [BST_WEDNESDAY],
      schoolRun,
      at("2026-08-18", 6),
      bookingConfig,
      counts,
    );
    const labels = day.slots.map((slot) => slot.label);

    assert.ok(day.slots.length > 0, "a blocking event closed the whole day");
    assert.equal(labels.includes("15:00"), false);
    assert.equal(labels.includes("16:00"), false);
  });

  test("the cap counts against the London date, across BST and GMT", () => {
    // 00:30 BST on 1 September is 23:30 UTC on 31 August. The booking belongs
    // to the day the engineer will drive to it.
    const counts = countBookingsByDate([
      { start: new Date("2026-08-31T23:30:00.000Z") },
      { start: new Date("2026-12-31T23:30:00.000Z") },
    ]);
    assert.equal(counts.get("2026-09-01"), 1);
    assert.equal(counts.get("2026-08-31"), undefined);
    assert.equal(counts.get("2026-12-31"), 1);
  });

  test("bookings on other days do not fill this one", () => {
    const counts = countBookingsByDate([
      ...bookingsOn("2026-08-20", 10),
      ...bookingsOn(BST_WEDNESDAY, 2),
    ]);
    assert.equal(isDayFullyBooked(counts, "2026-08-20"), true);
    assert.equal(isDayFullyBooked(counts, BST_WEDNESDAY), false);
  });
});

describe("slot taken between display and confirmation", () => {
  const now = at(BST_WEDNESDAY, 5);
  const slotIso = at(BST_WEDNESDAY, 18).toISOString();

  test("a free slot validates", () => {
    assert.equal(isSlotStillAvailable(slotIso, [], now), true);
  });

  test("the same slot fails once the calendar shows it busy", () => {
    const busy: Interval[] = [
      { start: at(BST_WEDNESDAY, 18), end: at(BST_WEDNESDAY, 18, 45) },
    ];
    assert.equal(isSlotStillAvailable(slotIso, busy, now), false);
  });

  test("a time that is not a configured slot is rejected", () => {
    const offGrid = at(BST_WEDNESDAY, 18, 17).toISOString();
    assert.equal(isSlotStillAvailable(offGrid, [], now), false);
  });

  test("a slot inside the notice window is rejected", () => {
    const soon = at(BST_WEDNESDAY, 10).toISOString();
    assert.equal(isSlotStillAvailable(soon, [], now), false);
  });

  test("a Saturday slot is rejected even if the calendar is empty", () => {
    const saturday = at(SATURDAY, 12).toISOString();
    assert.equal(isSlotStillAvailable(saturday, [], at(SATURDAY, 0)), false);
  });

  test("nonsense input is rejected rather than throwing", () => {
    assert.equal(isSlotStillAvailable("not-an-instant", [], now), false);
  });
});

describe("appliance pricing", () => {
  test("the base price covers a boiler plus two appliances", () => {
    assert.equal(calculatePrice(1).total, 45);
    assert.equal(calculatePrice(2).total, 45);
    assert.equal(calculatePrice(3).total, 45);
  });

  test("each appliance beyond three adds fifteen pounds", () => {
    assert.equal(calculatePrice(4).total, 60);
    assert.equal(calculatePrice(5).total, 75);
    assert.equal(calculatePrice(6).total, 90);
  });

  test("the breakdown explains the extra charge", () => {
    const price = calculatePrice(5);
    assert.equal(price.basePrice, 45);
    assert.equal(price.extraAppliances, 2);
    assert.equal(price.extraCharge, 30);
    assert.equal(price.totalDisplay, "£75 total");
  });

  test("out-of-range counts are clamped, never negative", () => {
    assert.equal(calculatePrice(0).applianceCount, 1);
    assert.equal(calculatePrice(-5).applianceCount, 1);
    assert.equal(calculatePrice(999).applianceCount, 12);
    assert.equal(calculatePrice(2.7).applianceCount, 2);
  });
});

describe("booking form validation", () => {
  const valid = {
    slotStart: "2026-08-19T17:00:00.000Z",
    fullName: "Jane Smith",
    email: "Jane@Example.co.uk",
    phone: "07700 900123",
    houseOrName: "24",
    street: "Example Road",
    postcode: "wv1 1aa",
    addressConfirmedByCustomer: true,
    customerType: "landlord",
    applianceCount: 4,
    termsAccepted: true,
    termsVersion: TERMS_VERSION,
    idempotencyKey: "abcdefgh1234",
  };

  test("a complete submission passes and is normalised", () => {
    const result = bookingSchema.safeParse(valid);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.email, "jane@example.co.uk");
      assert.equal(result.data.postcode, "WV1 1AA");
      assert.equal(result.data.phone, "+447700900123");
    }
  });

  test("a bad email is rejected", () => {
    const result = bookingSchema.safeParse({ ...valid, email: "not-an-email" });
    assert.equal(result.success, false);
  });

  test("a bad postcode is rejected", () => {
    assert.equal(
      bookingSchema.safeParse({ ...valid, postcode: "ZZZ" }).success,
      false,
    );
  });

  test("a non-UK phone number is rejected", () => {
    assert.equal(
      bookingSchema.safeParse({ ...valid, phone: "12345" }).success,
      false,
    );
  });

  test("an unknown customer type is rejected", () => {
    assert.equal(
      bookingSchema.safeParse({ ...valid, customerType: "landlord-ish" }).success,
      false,
    );
  });

  test("an appliance count above the maximum is rejected", () => {
    assert.equal(
      bookingSchema.safeParse({ ...valid, applianceCount: 99 }).success,
      false,
    );
  });

  test("a missing idempotency key is rejected", () => {
    const withoutKey: Record<string, unknown> = { ...valid };
    delete withoutKey.idempotencyKey;
    assert.equal(bookingSchema.safeParse(withoutKey).success, false);
  });

  test("a filled honeypot is caught by the schema shape", () => {
    const result = bookingSchema.safeParse({ ...valid, company: "spam ltd" });
    assert.equal(result.success, false);
  });

  test("optional tenant and access fields may be omitted", () => {
    assert.equal(bookingSchema.safeParse(valid).success, true);
  });
});

/**
 * The rule that lets a 60-minute bundle be sold at 19:00.
 *
 * An appointment must finish inside working hours. The 15-minute buffer is
 * internal scheduling protection, not part of what the customer books, so it
 * may run past closing on the last job of the day — but it is still enforced
 * in full between two bookings. Confirmed 31 August 2026; see
 * docs/business-details.md.
 */
describe("appointment length versus the working-hours boundary", () => {
  const bundleConfig = bookingConfigFor("cp12-boiler-service");

  function labels(isoDate: string, config = bookingConfig): string[] {
    return candidateSlotsForDate(isoDate, config).map((slot) =>
      timeLabelInZone(slot.start, config.timeZone),
    );
  }

  test("the CP12 grid runs 10:00 to 21:00", () => {
    assert.equal(bookingConfigFor("cp12").appointmentMinutes, 45);
    assert.deepEqual(labels(BST_WEDNESDAY), [
      "10:00",
      "11:00",
      "12:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
      "17:00",
      "18:00",
      "19:00",
      "20:00",
      "21:00",
    ]);
  });

  test("20:00 and 21:00 are offered; 22:00 is not a start", () => {
    for (const id of ["cp12", "boiler-service", "cp12-boiler-service"] as const) {
      const starts = labels(BST_WEDNESDAY, bookingConfigFor(id));
      assert.equal(starts.includes("20:00"), true, `${id} lost 20:00`);
      assert.equal(starts.includes("21:00"), true, `${id} lost 21:00`);
      assert.equal(starts.includes("22:00"), false, `${id} offered 22:00`);
      assert.equal(starts.at(-1), "21:00");
    }
  });

  test("the bundle is an hour long", () => {
    assert.equal(bundleConfig.appointmentMinutes, 60);
    assert.equal(blockMinutesFor(bundleConfig), 75);
  });

  test("the bundle still offers the last start, and it runs to 22:00", () => {
    const slots = candidateSlotsForDate(BST_WEDNESDAY, bundleConfig);
    const last = slots.at(-1);
    assert.ok(last);

    assert.equal(timeLabelInZone(last.start, bundleConfig.timeZone), "21:00");
    assert.equal(timeLabelInZone(last.end, bundleConfig.timeZone), "22:00");
    assert.equal((last.end.getTime() - last.start.getTime()) / 60000, 60);
  });

  test("the buffer running to 22:15 does not invalidate the 21:00 bundle", () => {
    const last = candidateSlotsForDate(BST_WEDNESDAY, bundleConfig).at(-1);
    assert.ok(last);

    // The block genuinely does overrun the working day. That is the point:
    // the boundary is the appointment, not the block.
    const blockEnd = new Date(
      last.start.getTime() + blockMinutesFor(bundleConfig) * 60000,
    );
    assert.equal(timeLabelInZone(blockEnd, bundleConfig.timeZone), "22:15");
    assert.ok(
      blockMinutesFor(bundleConfig) >
        bundleConfig.workingHours.endMinutes - 21 * 60,
    );
  });

  test("neither product ever offers a start after 21:00", () => {
    for (const config of [bookingConfig, bundleConfig]) {
      const starts = labels(BST_WEDNESDAY, config);
      assert.equal(starts.at(-1), "21:00");
      assert.equal(starts.includes("22:00"), false);
      assert.equal(starts.length, 12);
    }
  });

  test("both products are offered the same twelve hourly starts", () => {
    // The bundle is longer, but it does not lose a slot to that — which is
    // what the appointment-versus-buffer distinction was decided to protect.
    assert.deepEqual(labels(BST_WEDNESDAY), labels(BST_WEDNESDAY, bundleConfig));
  });

  test("a bundle is validated against the bundle's own length", () => {
    const lastStart = candidateSlotsForDate(BST_WEDNESDAY, bundleConfig).at(-1);
    assert.ok(lastStart);
    const day = at("2026-08-18", 6);

    assert.equal(
      isSlotStillAvailable(
        lastStart.start.toISOString(),
        [],
        day,
        bundleConfig,
      ),
      true,
    );
  });

  test("the buffer is still enforced in full between two bookings", () => {
    // A 19:00–20:00 bundle blocks from 18:45: the buffer is only forgiving at
    // the end of the day, never between jobs.
    const bundleBusy: Interval[] = [
      { start: at(BST_WEDNESDAY, 19), end: at(BST_WEDNESDAY, 20) },
    ];
    const free = filterAvailableSlots(
      candidateSlotsForDate(BST_WEDNESDAY),
      bundleBusy,
      at("2026-08-18", 6),
    );
    const open = free.map((s) => timeLabelInZone(s.start, bookingConfig.timeZone));

    assert.equal(open.includes("19:00"), false);
    assert.equal(open.includes("18:00"), true, "18:00–18:45 clears 19:00 by 15m");
    // 20:00 would start inside the buffer that runs to 20:15; 21:00 is clear.
    assert.equal(open.includes("20:00"), false);
    assert.equal(open.includes("21:00"), true, "the evening beyond it is free");
  });

  test("an 18:00 bundle blocks the 19:00 that follows it", () => {
    // 18:00–19:00 plus the buffer reaches 19:15, so nothing may start at 19:00.
    const busy: Interval[] = [
      { start: at(BST_WEDNESDAY, 18), end: at(BST_WEDNESDAY, 19) },
    ];
    const free = filterAvailableSlots(
      candidateSlotsForDate(BST_WEDNESDAY, bundleConfig),
      busy,
      at("2026-08-18", 6),
      bundleConfig,
    );
    const open = free.map((s) => timeLabelInZone(s.start, bundleConfig.timeZone));

    assert.equal(open.includes("19:00"), false);
    assert.equal(open.includes("17:00"), false, "17:00–18:00 would abut 18:00");
    assert.equal(open.includes("16:00"), true);
  });
});

/**
 * The rest of the date path, at the boundary that broke the picker.
 *
 * The month bug was in the browser. These are the server-side rules that share
 * the same "what day is it" question, checked at the same instants so the fix
 * is not left resting on the assumption that they were fine.
 */
describe("date boundaries elsewhere in the booking path", () => {
  /** 00:30 on 1 September 2026 in London — BST, so 31 August in UTC. */
  const JUST_AFTER_MIDNIGHT_BST = new Date("2026-08-31T23:30:00.000Z");
  /** 00:01 on 1 January 2027 in London — GMT, so UTC agrees. */
  const NEW_YEAR = new Date("2027-01-01T00:01:00.000Z");

  test("the first bookable date is today in London, not yesterday in UTC", () => {
    assert.equal(bookableDates(JUST_AFTER_MIDNIGHT_BST)[0], "2026-09-01");
    assert.equal(bookableDates(NEW_YEAR)[0], "2027-01-01");
  });

  test("the horizon still runs the configured number of days", () => {
    const dates = bookableDates(JUST_AFTER_MIDNIGHT_BST);
    assert.equal(dates.length, bookingConfig.maximumAdvanceDays + 1);
    assert.equal(dates.at(-1), "2026-10-01");
  });

  test("yesterday never reappears as bookable", () => {
    for (const now of [JUST_AFTER_MIDNIGHT_BST, NEW_YEAR]) {
      const dates = bookableDates(now);
      const today = isoDateInZone(now, bookingConfig.timeZone);
      assert.ok(
        dates.every((date) => date >= today),
        "a past date was offered",
      );
    }
  });

  test("a slot earlier today is not resurrected by the UTC date lagging", () => {
    // 10:00 on 31 August is comfortably in the past at 00:30 on 1 September,
    // even though UTC still reads 31 August at that moment.
    const yesterdayMorning = at("2026-08-31", 10).toISOString();
    assert.equal(
      isSlotStillAvailable(yesterdayMorning, [], JUST_AFTER_MIDNIGHT_BST),
      false,
    );
  });

  test("the 12-hour notice measures elapsed time, so it cannot drift", () => {
    /*
      The notice compares two instants. It never asks what day it is, so the
      offset that broke the picker cannot reach it — proved here rather than
      assumed.
    */
    const candidates = candidateSlotsForDate("2026-09-01");
    const free = filterAvailableSlots(candidates, [], JUST_AFTER_MIDNIGHT_BST);
    const labels = free.map((s) => timeLabelInZone(s.start, bookingConfig.timeZone));

    // 00:30 + 12h = 12:30, so 12:00 is too soon and 13:00 is the first offer.
    assert.equal(labels.includes("12:00"), false);
    assert.equal(labels[0], "13:00");
    assert.equal(labels.at(-1), "21:00");
  });

  test("the last start survives the boundary for every product", () => {
    for (const id of ["cp12", "boiler-service", "cp12-boiler-service"] as const) {
      const config = bookingConfigFor(id);
      const last = candidateSlotsForDate("2026-09-01", config).at(-1);
      assert.ok(last);

      assert.equal(timeLabelInZone(last.start, config.timeZone), "21:00");
      assert.equal(
        isSlotStillAvailable(
          last.start.toISOString(),
          [],
          JUST_AFTER_MIDNIGHT_BST,
          config,
        ),
        true,
        `${id} lost its last slot at the month boundary`,
      );
    }
  });

  test("same-day urgency reads the London date, not the UTC one", async () => {
    const { isSameDay } = await import("@/lib/email/booking-notification");

    // Booked at 00:30 on 1 September for 19:00 that same evening: same day.
    assert.equal(
      isSameDay(
        at("2026-09-01", 19),
        JUST_AFTER_MIDNIGHT_BST,
        bookingConfig.timeZone,
      ),
      true,
      "a booking for tonight was not flagged as same-day",
    );

    // And a slot on 31 August is not "today" any more, though UTC still says so.
    assert.equal(
      isSameDay(
        at("2026-08-31", 19),
        JUST_AFTER_MIDNIGHT_BST,
        bookingConfig.timeZone,
      ),
      false,
    );
  });
});
