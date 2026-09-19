import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { dayBoundsInZone, isoDateInZone } from "./time";

/**
 * A local day is not twenty-four hours.
 *
 * Twice a year in London it is twenty-three or twenty-five, and an engineer's
 * day view built on `+ 24 * 60 * 60 * 1000` loses or duplicates an hour of
 * appointments on exactly those two days. These assert the boundary is built
 * from the wall clock instead.
 */

const LONDON = "Europe/London";

describe("the bounds of a local day", () => {
  test("an ordinary winter day starts and ends at local midnight", () => {
    const bounds = dayBoundsInZone("2026-01-15", LONDON);
    assert.ok(bounds);
    // GMT: local midnight is UTC midnight.
    assert.equal(bounds.start.toISOString(), "2026-01-15T00:00:00.000Z");
    assert.equal(bounds.end.toISOString(), "2026-01-16T00:00:00.000Z");
  });

  test("an ordinary summer day is an hour behind UTC midnight", () => {
    const bounds = dayBoundsInZone("2026-07-15", LONDON);
    assert.ok(bounds);
    // BST: local midnight is 23:00 UTC the day before.
    assert.equal(bounds.start.toISOString(), "2026-07-14T23:00:00.000Z");
    assert.equal(bounds.end.toISOString(), "2026-07-15T23:00:00.000Z");
  });

  test("the day the clocks go forward is twenty-three hours", () => {
    // 29 March 2026: 01:00 GMT becomes 02:00 BST.
    const bounds = dayBoundsInZone("2026-03-29", LONDON);
    assert.ok(bounds);
    const hours = (bounds.end.getTime() - bounds.start.getTime()) / 3_600_000;
    assert.equal(hours, 23);
  });

  test("the day the clocks go back is twenty-five hours", () => {
    // 25 October 2026: 02:00 BST becomes 01:00 GMT.
    const bounds = dayBoundsInZone("2026-10-25", LONDON);
    assert.ok(bounds);
    const hours = (bounds.end.getTime() - bounds.start.getTime()) / 3_600_000;
    assert.equal(hours, 25);
  });

  test("every instant in the range belongs to that local date", () => {
    for (const date of ["2026-03-29", "2026-10-25", "2026-01-15", "2026-07-15"]) {
      const bounds = dayBoundsInZone(date, LONDON)!;
      assert.equal(isoDateInZone(bounds.start, LONDON), date, date);
      // The end is exclusive: it is the first instant of the next day.
      assert.notEqual(isoDateInZone(bounds.end, LONDON), date, date);
      assert.equal(
        isoDateInZone(new Date(bounds.end.getTime() - 1), LONDON),
        date,
        date,
      );
    }
  });

  test("consecutive days meet exactly, with no gap and no overlap", () => {
    const first = dayBoundsInZone("2026-10-25", LONDON)!;
    const second = dayBoundsInZone("2026-10-26", LONDON)!;
    assert.equal(first.end.getTime(), second.start.getTime());
  });

  test("something that is not a date is refused rather than guessed at", () => {
    assert.equal(dayBoundsInZone("2026-02-30", LONDON), null);
    assert.equal(dayBoundsInZone("yesterday", LONDON), null);
    assert.equal(dayBoundsInZone("", LONDON), null);
  });
});
