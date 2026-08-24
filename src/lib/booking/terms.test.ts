import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CANCELLATION_PERIOD_DAYS,
  cancellationPeriodEnd,
  cancellationPeriodLastDate,
  checkTermsAcceptance,
  isCurrentTermsVersion,
  requiresEarlyPerformanceRequest,
  termsProblemMessage,
  TERMS_VERSION,
} from "./terms";
import { zonedTimeToUtc } from "./time";

/**
 * The contractual gate on a booking.
 *
 * These rules exist because a booking here is a distance service contract: the
 * consumer has 14 days to cancel, and the engineer may not start inside that
 * window without an express request. Getting this wrong is not a UI bug — it
 * is the difference between being paid for a certificate and not.
 */

const ZONE = "Europe/London";

/** A London wall-clock instant, so daylight saving is exercised for real. */
const at = (
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
) => zonedTimeToUtc({ year, month, day, hour, minute }, ZONE);

describe("the terms version", () => {
  test("the current version is accepted", () => {
    assert.equal(isCurrentTermsVersion(TERMS_VERSION), true);
  });

  test("an older version is not", () => {
    assert.equal(isCurrentTermsVersion("2020-01-01"), false);
  });

  test("the immediately previous version is rejected too", () => {
    // The bump on 24 August 2026 added the inspection/remedial-work clause.
    // A tab still holding 2026-08-22 accepted wording that no longer stands.
    assert.equal(isCurrentTermsVersion("2026-08-22"), false);
  });

  test("a future-looking version is not, because only one is current", () => {
    assert.equal(isCurrentTermsVersion("2099-12-31"), false);
  });

  test("nonsense of any shape is rejected", () => {
    for (const value of [
      "",
      "v1",
      "latest",
      "2026-08-22 ",
      null,
      undefined,
      true,
      1,
      { version: TERMS_VERSION },
      [TERMS_VERSION],
    ]) {
      assert.equal(isCurrentTermsVersion(value), false, `${String(value)}`);
    }
  });

  test("it is date-shaped, so a record of it stays meaningful", () => {
    assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("the statutory cancellation period", () => {
  test("it runs for 14 days after the day of booking", () => {
    assert.equal(CANCELLATION_PERIOD_DAYS, 14);
    // Booked 22 August, so the last day is 5 September.
    assert.equal(
      cancellationPeriodLastDate(at(2026, 8, 22, 14), ZONE),
      "2026-09-05",
    );
  });

  test("the time of day the booking was made makes no difference", () => {
    // Counted on the local calendar date, not on elapsed hours.
    for (const hour of [0, 9, 23]) {
      assert.equal(
        cancellationPeriodLastDate(at(2026, 8, 22, hour, hour === 23 ? 59 : 0), ZONE),
        "2026-09-05",
      );
    }
  });

  test("it survives the clocks going back", () => {
    // Booked 20 October 2026; British Summer Time ends on 25 October.
    assert.equal(
      cancellationPeriodLastDate(at(2026, 10, 20, 14), ZONE),
      "2026-11-03",
    );
  });

  test("it survives the clocks going forward", () => {
    // Booked 20 March 2027; BST begins on 28 March.
    assert.equal(
      cancellationPeriodLastDate(at(2027, 3, 20, 14), ZONE),
      "2027-04-03",
    );
  });

  test("it crosses a year end correctly", () => {
    assert.equal(
      cancellationPeriodLastDate(at(2026, 12, 28, 14), ZONE),
      "2027-01-11",
    );
  });

  test("the period expires at the very end of the last day", () => {
    const end = cancellationPeriodEnd(at(2026, 8, 22, 14), ZONE);
    const nextDayStart = zonedTimeToUtc(
      { year: 2026, month: 9, day: 6, hour: 0, minute: 0 },
      ZONE,
    );
    assert.equal(end.getTime(), nextDayStart.getTime() - 1);
  });

  test("a booking made just before midnight still gets its full 14 days", () => {
    const booked = at(2026, 8, 22, 23, 59);
    assert.ok(
      cancellationPeriodEnd(booked, ZONE).getTime() - booked.getTime() >
        13 * 24 * 60 * 60000,
    );
  });
});

describe("when an express request to start early is needed", () => {
  const booked = at(2026, 8, 22, 14);

  test("an appointment tomorrow is inside the period", () => {
    assert.equal(
      requiresEarlyPerformanceRequest(at(2026, 8, 23, 10), booked, ZONE),
      true,
    );
  });

  test("an appointment on the last day of the period is still inside it", () => {
    assert.equal(
      requiresEarlyPerformanceRequest(at(2026, 9, 5, 19), booked, ZONE),
      true,
    );
  });

  test("an appointment the day after the period is outside it", () => {
    assert.equal(
      requiresEarlyPerformanceRequest(at(2026, 9, 6, 10), booked, ZONE),
      false,
    );
  });

  test("an appointment at the far end of the booking horizon is outside it", () => {
    // Bookings run 30 days ahead, so appointments beyond day 14 need nothing.
    assert.equal(
      requiresEarlyPerformanceRequest(at(2026, 9, 20, 10), booked, ZONE),
      false,
    );
  });
});

describe("the server decides whether a booking may proceed", () => {
  const booked = at(2026, 8, 22, 14);
  const insidePeriod = at(2026, 8, 25, 14);
  const outsidePeriod = at(2026, 9, 15, 14);

  const check = (overrides: Record<string, unknown> = {}) =>
    checkTermsAcceptance({
      termsVersion: TERMS_VERSION,
      termsAccepted: true,
      earlyPerformanceRequested: true,
      slotStart: insidePeriod,
      contractMadeAt: booked,
      timeZone: ZONE,
      ...overrides,
    });

  test("a complete acceptance passes", () => {
    const result = check();
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.earlyPerformanceRequired, true);
  });

  test("terms must be accepted", () => {
    const result = check({ termsAccepted: false });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.problem, "terms_not_accepted");
  });

  test("a missing acceptance is not an acceptance", () => {
    assert.equal(check({ termsAccepted: undefined }).ok, false);
  });

  test("acceptance must be literally true, not merely truthy", () => {
    // A forged payload cannot smuggle consent past the gate with a string.
    for (const forged of ["true", "yes", 1, "on", [], {}]) {
      const result = check({ termsAccepted: forged });
      assert.equal(result.ok, false, `${JSON.stringify(forged)} must not pass`);
      assert.equal(result.ok === false && result.problem, "terms_not_accepted");
    }
  });

  test("a stale terms version is rejected", () => {
    const result = check({ termsVersion: "2020-01-01" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.problem, "terms_version_stale");
  });

  test("a missing or manipulated version is rejected", () => {
    for (const version of ["", null, undefined, 20260822, "latest"]) {
      const result = check({ termsVersion: version });
      assert.equal(result.ok, false, `${String(version)} must not pass`);
      assert.equal(result.ok === false && result.problem, "terms_version_stale");
    }
  });

  test("an appointment inside the period needs the express request", () => {
    const result = check({ earlyPerformanceRequested: false });
    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.problem,
      "early_performance_not_requested",
    );
  });

  test("the express request must also be literally true", () => {
    for (const forged of ["true", "yes", 1, {}]) {
      assert.equal(check({ earlyPerformanceRequested: forged }).ok, false);
    }
  });

  test("an appointment outside the period does not need it", () => {
    const result = check({
      slotStart: outsidePeriod,
      earlyPerformanceRequested: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.earlyPerformanceRequired, false);
  });

  test("the requirement is derived from the slot, not claimed by the caller", () => {
    // The caller sends only whether the customer ticked the box. Whether one
    // was needed is decided here, from the slot and the moment of booking, so
    // a browser cannot make the requirement disappear.
    const result = check({ earlyPerformanceRequested: false });
    assert.equal(result.ok, false);

    const sameSlotWithRequest = check({ earlyPerformanceRequested: true });
    assert.equal(sameSlotWithRequest.ok, true);
  });

  test("terms are checked before the early-start question is even reached", () => {
    // Someone who accepted nothing is told about the terms, not sent to argue
    // about a cancellation period they have not agreed to yet.
    const result = check({
      termsAccepted: false,
      earlyPerformanceRequested: false,
    });
    assert.equal(result.ok === false && result.problem, "terms_not_accepted");
  });
});

describe("what the customer is told", () => {
  test("every problem has a plain-English message", () => {
    for (const problem of [
      "terms_not_accepted",
      "terms_version_stale",
      "early_performance_not_requested",
    ] as const) {
      const message = termsProblemMessage(problem);
      assert.ok(message.length > 20);
      // No jargon, no regulation numbers, no blame.
      assert.ok(!/regulation|statutory instrument|clause/i.test(message));
    }
  });
});
