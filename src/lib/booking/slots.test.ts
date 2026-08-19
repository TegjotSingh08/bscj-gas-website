import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { bookingConfig, blockMinutes } from "./config";
import {
  bookableDates,
  buildAvailability,
  candidateSlotsForDate,
  countBookingsOnDate,
  filterAvailableSlots,
  isSlotStillAvailable,
  type Interval,
} from "./slots";
import { calculatePrice } from "./pricing";
import { bookingSchema } from "./schema";
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
  test("slots run from 10:00 and stop when the job plus buffer would overrun", () => {
    const slots = candidateSlotsForDate(BST_WEDNESDAY);
    const labels = slots.map((s) => timeLabelInZone(s.start, bookingConfig.timeZone));

    assert.equal(labels[0], "10:00");
    // 19:00 + 45min + 15min buffer = 20:00 exactly, so 19:00 is the last slot.
    assert.equal(labels.at(-1), "19:00");
    assert.equal(labels.length, 10);
  });

  test("appointment length and buffer come from the shared config", () => {
    assert.equal(bookingConfig.appointmentMinutes, 45);
    assert.equal(bookingConfig.bufferMinutes, 15);
    assert.equal(blockMinutes, 60);
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
      10,
    );
  });
});

describe("minimum booking notice", () => {
  test("slots inside the notice window are withheld", () => {
    // 09:00 London on the day: the 12-hour cutoff lands at 21:00, past closing.
    const now = at(BST_WEDNESDAY, 9);
    const free = filterAvailableSlots(candidateSlotsForDate(BST_WEDNESDAY), [], now);
    assert.equal(free.length, 0);
  });

  test("slots beyond the notice window are offered", () => {
    // 05:00 London: cutoff is 17:00, so 17:00, 18:00 and 19:00 remain.
    const now = at(BST_WEDNESDAY, 5);
    const labels = filterAvailableSlots(
      candidateSlotsForDate(BST_WEDNESDAY),
      [],
      now,
    ).map((s) => timeLabelInZone(s.start, bookingConfig.timeZone));
    assert.deepEqual(labels, ["17:00", "18:00", "19:00"]);
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

describe("daily booking cap", () => {
  test("a day at the cap offers nothing further", () => {
    const busy: Interval[] = Array.from({ length: 8 }, (_, index) => ({
      start: at(BST_WEDNESDAY, 10 + index),
      end: at(BST_WEDNESDAY, 10 + index, 45),
    }));
    assert.equal(countBookingsOnDate(busy, BST_WEDNESDAY), 8);

    const [day] = buildAvailability([BST_WEDNESDAY], busy, at(BST_WEDNESDAY, 5));
    assert.deepEqual(day.slots, []);
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
    propertyAddress: "12 Sedgley Street",
    postcode: "wv2 3aj",
    customerType: "landlord",
    applianceCount: 4,
    idempotencyKey: "abcdefgh1234",
  };

  test("a complete submission passes and is normalised", () => {
    const result = bookingSchema.safeParse(valid);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.email, "jane@example.co.uk");
      assert.equal(result.data.postcode, "WV2 3AJ");
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
