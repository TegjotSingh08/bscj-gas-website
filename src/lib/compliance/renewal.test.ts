import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  addMonths,
  daysBetween,
  daysInMonth,
  deadlineRisk,
  DEFAULT_DEADLINE_WINDOWS,
  formatCalendarDate,
  nextDueDate,
  parseCalendarDate,
  RENEWAL_INTERVAL_MONTHS,
  requireNextDueDate,
  subtractDays,
} from "./renewal";

/**
 * The renewal rule.
 *
 * Confirmed by BSCJ on 16 September 2026: next due date is the inspection date
 * plus twelve months, minus one day. A day matters here — the question the
 * date answers is whether a property was legally certificated — so the awkward
 * cases are tested rather than assumed.
 */
describe("the renewal rule", () => {
  test("the interval is twelve months", () => {
    assert.equal(RENEWAL_INTERVAL_MONTHS, 12);
  });

  test("an ordinary date renews the day before its anniversary", () => {
    assert.equal(nextDueDate("2026-09-16"), "2027-09-15");
    assert.equal(nextDueDate("2026-01-10"), "2027-01-09");
  });

  test("the first of a month renews on the last day of the previous one", () => {
    // The awkward case the "minus one day" creates, and the reason it is
    // tested rather than reasoned about.
    assert.equal(nextDueDate("2026-03-01"), "2027-02-28");
    assert.equal(nextDueDate("2027-03-01"), "2028-02-29");
    assert.equal(nextDueDate("2026-01-01"), "2026-12-31");
  });

  test("a leap day renews without rolling into March", () => {
    /*
      29 February 2028 plus twelve months is 28 February 2029, because 2029 has
      no 29th — not 1 March, which is what a naive month add produces. Minus a
      day gives 27 February.
    */
    assert.equal(nextDueDate("2028-02-29"), "2029-02-27");
  });

  test("a month end renews at a month end", () => {
    assert.equal(nextDueDate("2026-08-31"), "2027-08-30");
    assert.equal(nextDueDate("2026-12-31"), "2027-12-30");
  });

  test("a due date is always earlier in the year than its inspection", () => {
    // Property of the rule: twelve months forward then a day back can never
    // land on or after the anniversary.
    for (const date of [
      "2026-01-15",
      "2026-02-28",
      "2026-06-30",
      "2026-07-04",
      "2026-11-30",
    ]) {
      const due = requireNextDueDate(date);
      const inspection = parseCalendarDate(date)!;
      const parsed = parseCalendarDate(due)!;
      assert.equal(parsed.year, inspection.year + 1, date);
      assert.ok(daysBetween(inspection, parsed) < 366, date);
      assert.ok(daysBetween(inspection, parsed) >= 364, date);
    }
  });

  test("a value that is not a calendar date is refused, not rolled over", () => {
    /*
      "2027-02-30" looks like a date and is not one. Silently rolling it into
      March would produce a plausible wrong renewal date in a row nobody would
      ever question.
    */
    for (const value of [
      "2027-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-09-00",
      "2026-9-16",
      "16/09/2026",
      "",
      "not a date",
    ]) {
      assert.equal(nextDueDate(value), null, value);
    }
  });

  test("the strict form throws where the lenient one returns null", () => {
    assert.throws(() => requireNextDueDate("2027-02-30"), RangeError);
  });
});

describe("the date arithmetic underneath", () => {
  test("February knows about leap years", () => {
    assert.equal(daysInMonth(2026, 2), 28);
    assert.equal(daysInMonth(2028, 2), 29);
    // The centurial rule, which a naive %4 check gets wrong.
    assert.equal(daysInMonth(2100, 2), 28);
    assert.equal(daysInMonth(2000, 2), 29);
  });

  test("adding months clamps rather than rolling over", () => {
    assert.deepEqual(addMonths({ year: 2026, month: 1, day: 31 }, 1), {
      year: 2026,
      month: 2,
      day: 28,
    });
    assert.deepEqual(addMonths({ year: 2026, month: 12, day: 15 }, 1), {
      year: 2027,
      month: 1,
      day: 15,
    });
  });

  test("subtracting a day crosses months and years", () => {
    assert.equal(
      formatCalendarDate(subtractDays({ year: 2026, month: 1, day: 1 }, 1)),
      "2025-12-31",
    );
    assert.equal(
      formatCalendarDate(subtractDays({ year: 2028, month: 3, day: 1 }, 1)),
      "2028-02-29",
    );
  });

  test("dates round-trip through parse and format", () => {
    for (const value of ["2026-09-16", "2000-02-29", "2099-12-31"]) {
      assert.equal(formatCalendarDate(parseCalendarDate(value)!), value);
    }
  });
});

describe("deadline risk", () => {
  const today = "2026-09-16";

  test("it is computed from the dates, never stored", () => {
    assert.equal(deadlineRisk("2026-12-31", today), "normal");
    assert.equal(deadlineRisk("2026-10-10", today), "approaching");
    assert.equal(deadlineRisk("2026-09-20", today), "urgent");
    assert.equal(deadlineRisk("2026-09-15", today), "overdue");
  });

  test("a deadline of today is urgent, not overdue", () => {
    // There are still hours left in it. It becomes overdue tomorrow.
    assert.equal(deadlineRisk(today, today), "urgent");
  });

  test("the window boundaries are inclusive on the risky side", () => {
    const { approachingDays, urgentDays } = DEFAULT_DEADLINE_WINDOWS;
    assert.equal(approachingDays, 30);
    assert.equal(urgentDays, 7);

    assert.equal(deadlineRisk("2026-09-23", today), "urgent");
    assert.equal(deadlineRisk("2026-09-24", today), "approaching");
    assert.equal(deadlineRisk("2026-10-16", today), "approaching");
    assert.equal(deadlineRisk("2026-10-17", today), "normal");
  });

  test("the windows are configurable, because they are not a legal position", () => {
    assert.equal(
      deadlineRisk("2026-10-10", today, { approachingDays: 90, urgentDays: 60 }),
      "urgent",
    );
  });

  test("a date that is not a date has no risk rather than a wrong one", () => {
    assert.equal(deadlineRisk("2026-02-30", today), null);
    assert.equal(deadlineRisk("2026-12-31", "nonsense"), null);
  });
});
