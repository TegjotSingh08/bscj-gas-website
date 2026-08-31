import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  currentMonthInZone,
  initialCalendarMonth,
  monthOfIsoDate,
} from "./calendar-month";
import { bookingConfig } from "./config";
import { bookableDates } from "./slots";
import { isoDateInZone } from "./time";

const LONDON = "Europe/London";

/** The month the picker opens on, for an instant, with nothing loaded yet. */
function openingMonth(instant: string, timeZone = LONDON) {
  return initialCalendarMonth({
    selectedDate: null,
    firstBookable: null,
    now: new Date(instant),
    timeZone,
  });
}

/**
 * The production bug, pinned to the instant it was reported.
 *
 * At 00:30 on 1 September 2026 the clock in Wolverhampton reads September, but
 * Britain is an hour ahead of UTC in summer, so the UTC date is still 31
 * August. The picker seeded its month from the browser's UTC fields and opened
 * on August — every time, on every refresh, because it is arithmetic rather
 * than stale state.
 */
describe("the month shown is the month it is in Wolverhampton", () => {
  /** 00:30 on 1 September 2026 in London. */
  const JUST_AFTER_MIDNIGHT_BST = "2026-08-31T23:30:00.000Z";

  test("just after midnight on 1 September, the picker opens on September", () => {
    assert.deepEqual(openingMonth(JUST_AFTER_MIDNIGHT_BST), {
      year: 2026,
      month: 9,
    });
  });

  test("the UTC date at that instant really is still August", () => {
    // The reproduction, not a redundant assertion: this is precisely what the
    // old code read, and why refreshing never helped.
    const instant = new Date(JUST_AFTER_MIDNIGHT_BST);
    assert.equal(instant.getUTCMonth() + 1, 8);
    assert.equal(
      currentMonthInZone(instant, LONDON).month,
      9,
      "the business month must not follow UTC",
    );
  });

  test("the whole first hour of a BST day is affected, and all of it is fixed", () => {
    // 00:00 to 00:59 London is the previous day in UTC while Britain is an
    // hour ahead. Every minute of it must still read September.
    for (const minute of [0, 1, 15, 30, 45, 59]) {
      const instant = new Date(
        Date.UTC(2026, 7, 31, 23, minute, 0),
      );
      assert.deepEqual(
        currentMonthInZone(instant, LONDON),
        { year: 2026, month: 9 },
        `00:${String(minute).padStart(2, "0")} BST opened the wrong month`,
      );
    }
  });
});

describe("month and year boundaries", () => {
  const cases = [
    {
      name: "31 August 2026, 23:59 London (BST) → August",
      instant: "2026-08-31T22:59:00.000Z",
      expected: { year: 2026, month: 8 },
    },
    {
      name: "1 September 2026, 00:01 London (BST) → September",
      instant: "2026-08-31T23:01:00.000Z",
      expected: { year: 2026, month: 9 },
    },
    {
      name: "31 December 2026, 23:59 London (GMT) → December",
      instant: "2026-12-31T23:59:00.000Z",
      expected: { year: 2026, month: 12 },
    },
    {
      name: "1 January 2027, 00:01 London (GMT) → January 2027",
      instant: "2027-01-01T00:01:00.000Z",
      expected: { year: 2027, month: 1 },
    },
  ];

  for (const { name, instant, expected } of cases) {
    test(name, () => {
      assert.deepEqual(openingMonth(instant), expected);
    });
  }

  test("the London wall clock for each case is what the case claims", () => {
    // Guards the fixtures themselves: a wrong instant would make the tests
    // above pass while proving nothing.
    const wallClock = (iso: string) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: LONDON,
        dateStyle: "short",
        timeStyle: "short",
        hour12: false,
      }).format(new Date(iso));

    assert.equal(wallClock("2026-08-31T22:59:00.000Z"), "31/08/2026, 23:59");
    assert.equal(wallClock("2026-08-31T23:01:00.000Z"), "01/09/2026, 00:01");
    assert.equal(wallClock("2026-12-31T23:59:00.000Z"), "31/12/2026, 23:59");
    assert.equal(wallClock("2027-01-01T00:01:00.000Z"), "01/01/2027, 00:01");
  });
});

describe("British Summer Time is handled, not accidentally avoided", () => {
  test("in winter the business month and the UTC month agree", () => {
    // GMT: no offset, so the old code happened to be right for five months of
    // the year. That is why this reached production.
    const midwinter = new Date("2026-12-31T23:59:00.000Z");
    assert.equal(currentMonthInZone(midwinter, LONDON).month, 12);
    assert.equal(midwinter.getUTCMonth() + 1, 12);
  });

  test("in summer they do not, and the business month wins", () => {
    const midsummer = new Date("2026-06-30T23:30:00.000Z");
    assert.equal(midsummer.getUTCMonth() + 1, 6);
    assert.deepEqual(currentMonthInZone(midsummer, LONDON), {
      year: 2026,
      month: 7,
    });
  });

  test("the clocks going forward does not shift the month", () => {
    // BST began 29 March 2026 at 01:00 GMT.
    assert.deepEqual(
      currentMonthInZone(new Date("2026-03-29T00:59:00.000Z"), LONDON),
      { year: 2026, month: 3 },
    );
    assert.deepEqual(
      currentMonthInZone(new Date("2026-03-29T01:01:00.000Z"), LONDON),
      { year: 2026, month: 3 },
    );
  });

  test("the clocks going back does not shift the month either", () => {
    // BST ended 25 October 2026 at 02:00 BST.
    assert.deepEqual(
      currentMonthInZone(new Date("2026-10-25T00:59:00.000Z"), LONDON),
      { year: 2026, month: 10 },
    );
    assert.deepEqual(
      currentMonthInZone(new Date("2026-10-31T23:30:00.000Z"), LONDON),
      { year: 2026, month: 10 },
      "23:30 GMT on the 31st is still the 31st, not November",
    );
  });
});

describe("what the picker prefers, and why it agrees with the server", () => {
  test("a date the customer chose wins", () => {
    assert.deepEqual(
      initialCalendarMonth({
        selectedDate: "2026-11-03",
        firstBookable: "2026-09-01",
        now: new Date("2026-08-31T23:30:00.000Z"),
        timeZone: LONDON,
      }),
      { year: 2026, month: 11 },
    );
  });

  test("otherwise the first date the server offered", () => {
    assert.deepEqual(
      initialCalendarMonth({
        selectedDate: null,
        firstBookable: "2026-09-01",
        now: new Date("2026-08-31T23:30:00.000Z"),
        timeZone: LONDON,
      }),
      { year: 2026, month: 9 },
    );
  });

  test("a malformed date falls through rather than throwing", () => {
    assert.equal(monthOfIsoDate("nonsense"), null);
    assert.equal(monthOfIsoDate("2026-13-01"), null);
    assert.deepEqual(
      initialCalendarMonth({
        selectedDate: "nonsense",
        firstBookable: "also-nonsense",
        now: new Date("2026-08-31T23:30:00.000Z"),
        timeZone: LONDON,
      }),
      { year: 2026, month: 9 },
    );
  });

  test("the fallback and the server's own first date always agree", () => {
    /*
      This is what makes the one-line fix sufficient. The picker mounts before
      availability arrives, so the fallback decides what every customer sees
      first — and `bookableDates` derives its first entry in the same timezone,
      so the month cannot change under the customer when the data lands.
    */
    for (const instant of [
      "2026-08-31T23:30:00.000Z",
      "2026-12-31T23:59:00.000Z",
      "2027-01-01T00:01:00.000Z",
      "2026-06-30T23:30:00.000Z",
      "2026-03-29T01:01:00.000Z",
      "2026-10-25T01:30:00.000Z",
    ]) {
      const now = new Date(instant);
      const firstBookable = bookableDates(now, bookingConfig)[0];

      assert.equal(
        firstBookable,
        isoDateInZone(now, bookingConfig.timeZone),
        "the server's first offered date is not today in London",
      );
      assert.deepEqual(
        currentMonthInZone(now, bookingConfig.timeZone),
        monthOfIsoDate(firstBookable),
        `the fallback disagreed with the server at ${instant}`,
      );
    }
  });
});
