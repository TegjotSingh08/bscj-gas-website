import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ACCEPTED_DATE_FORMATS,
  describeDateProblem,
  formatParsedDate,
  parseImportDate,
} from "./dates";

/**
 * Dates, which is where an import can be wrong in a way nobody notices.
 *
 * A certificate expiry read a month wrong makes a property look compliant when
 * it is not, or chases a landlord for a renewal they do not owe. Neither is a
 * rounding error, so the rule is stated and everything outside it is refused.
 */

describe("the accepted formats", () => {
  test("ISO", () => {
    const parsed = parseImportDate("2026-11-30");
    assert.ok(parsed.ok);
    assert.equal(parsed.iso, "2026-11-30");
  });

  test("UK order with slashes, day first", () => {
    const parsed = parseImportDate("03/04/2026");
    assert.ok(parsed.ok);
    // 3 April, not 4 March. The template says day first and so does the screen.
    assert.equal(parsed.iso, "2026-04-03");
  });

  test("UK order with dashes", () => {
    const parsed = parseImportDate("03-04-2026");
    assert.ok(parsed.ok);
    assert.equal(parsed.iso, "2026-04-03");
  });

  test("single-digit day and month", () => {
    const parsed = parseImportDate("3/4/2026");
    assert.ok(parsed.ok);
    assert.equal(parsed.iso, "2026-04-03");
  });

  test("surrounding whitespace is ignored", () => {
    const parsed = parseImportDate("  2026-11-30  ");
    assert.ok(parsed.ok);
    assert.equal(parsed.iso, "2026-11-30");
  });
});

describe("ambiguity is refused, never guessed", () => {
  test("a two-digit year could be either century", () => {
    for (const value of ["01/02/26", "1-2-99", "03/04/00"]) {
      const parsed = parseImportDate(value);
      assert.equal(parsed.ok, false, value);
      assert.ok(!parsed.ok && parsed.problem === "two_digit_year", value);
    }
  });

  test("month-first order is refused rather than silently re-read", () => {
    /*
      `04/25/2026` can only be month-first. Quietly accepting it would mean the
      rows in the same file where both parts are under 13 — the great majority
      — are read a month wrong, with nothing on screen to show it.
    */
    const parsed = parseImportDate("04/25/2026");
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.problem === "ambiguous_order");
  });

  test("a date that does not exist is refused", () => {
    for (const value of ["31/02/2026", "2026-02-31", "2025-02-29"]) {
      const parsed = parseImportDate(value);
      assert.equal(parsed.ok, false, value);
      assert.ok(!parsed.ok && parsed.problem === "impossible_date", value);
    }
  });

  test("a leap day in a leap year is fine", () => {
    const parsed = parseImportDate("2028-02-29");
    assert.ok(parsed.ok);
  });

  test("an implausible year is refused", () => {
    for (const value of ["30/04/1899", "2262-04-30"]) {
      const parsed = parseImportDate(value);
      assert.equal(parsed.ok, false, value);
      assert.ok(!parsed.ok && parsed.problem === "implausible_year", value);
    }
  });
});

describe("everything outside the rule is refused by name", () => {
  test("formats that are not offered", () => {
    const rejected = [
      "30 November 2026",
      "Nov 30 2026",
      "30.11.2026",
      "2026/11/30",
      "20261130",
      "45000", // a spreadsheet serial that lost its formatting
      "next Tuesday",
      "",
      "   ",
      "2026-11-30T00:00:00Z",
    ];
    for (const value of rejected) {
      assert.equal(parseImportDate(value).ok, false, value);
    }
  });

  test("nothing reaches Date.parse, which accepts almost anything", () => {
    // `new Date("2026")` is a valid Date. Anything that leans on it resolves
    // against the host's timezone and is wrong by a day somewhere.
    assert.equal(parseImportDate("2026").ok, false);
    assert.equal(parseImportDate("March").ok, false);
  });
});

describe("what the agent is told", () => {
  test("every problem has its own sentence, and it says what to do", () => {
    const problems = [
      "two_digit_year",
      "ambiguous_order",
      "impossible_date",
      "implausible_year",
      "not_a_date",
    ] as const;
    const messages = problems.map(describeDateProblem);
    for (const message of messages) assert.ok(message.length > 10);
    // Distinct, so a row's error is actually informative.
    assert.equal(new Set(messages).size, messages.length);
  });

  test("the accepted formats are stated as day-first, unambiguously", () => {
    assert.match(ACCEPTED_DATE_FORMATS, /YYYY-MM-DD/);
    assert.match(ACCEPTED_DATE_FORMATS, /day first/i);
  });

  test("a parsed date is written back out in long form", () => {
    // Shown beside every date in the preview, so a person catches an ordering
    // mistake that no amount of parser cleverness could.
    assert.equal(formatParsedDate("2026-04-03"), "3 April 2026");
    assert.equal(formatParsedDate("2026-11-30"), "30 November 2026");
  });

  test("a date and its long form agree about which day it is", () => {
    const parsed = parseImportDate("03/04/2026");
    assert.ok(parsed.ok);
    assert.equal(formatParsedDate(parsed.iso), "3 April 2026");
  });
});
