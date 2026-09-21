import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Offering later dates, and the three places a deadline can sit relative to
 * the booking window.
 *
 * Observed on 21 September: deadline 21 October, `maximumAdvanceDays` 30. The
 * window ended at the deadline, so **every** slot was already before it —
 * "show me later dates" revealed the same list while announcing "you are now
 * choosing from times after 21 October", and there was no way back.
 *
 * The rule under test is pure and lives here; the component's use of it is
 * asserted structurally, because the failure was a *missing branch* rather
 * than a wrong value.
 */

/** The cutoff rule the scheduler applies: a slot must FINISH by the deadline. */
function withinDeadline(slotEndIso: string, endsBeforeIso: string): boolean {
  return Date.parse(slotEndIso) <= Date.parse(endsBeforeIso);
}

/** Whether there is anything to show after the deadline. */
function laterSlotsExist(
  slotEnds: readonly string[],
  endsBeforeIso: string,
): boolean {
  return slotEnds.some((end) => !withinDeadline(end, endsBeforeIso));
}

const DEADLINE = "2026-10-21T23:59:59.999Z";

describe("where the deadline sits relative to the booking window", () => {
  test("INSIDE the window — later times exist, so the offer is real", () => {
    const window = [
      "2026-10-10T10:00:00.000Z",
      "2026-10-20T10:00:00.000Z",
      "2026-10-25T10:00:00.000Z",
    ];
    assert.equal(laterSlotsExist(window, DEADLINE), true);
  });

  test("AT the end of the window — nothing later exists", () => {
    /*
      The reported case. The last bookable day is the deadline itself, so every
      slot is compliant and there is nothing whatsoever to reveal.
    */
    const window = [
      "2026-10-10T10:00:00.000Z",
      "2026-10-21T10:00:00.000Z",
      "2026-10-21T17:00:00.000Z",
    ];
    assert.equal(laterSlotsExist(window, DEADLINE), false);
  });

  test("BEYOND the window — nothing later exists either", () => {
    const window = ["2026-09-25T10:00:00.000Z", "2026-10-01T10:00:00.000Z"];
    assert.equal(laterSlotsExist(window, DEADLINE), false);
  });

  test("a slot that STARTS before and ENDS after the deadline is late", () => {
    // The cutoff is on the end, because a 60-minute booking starting at 23:30
    // does not finish that day.
    assert.equal(withinDeadline("2026-10-22T00:30:00.000Z", DEADLINE), false);
    assert.equal(withinDeadline("2026-10-21T23:59:59.000Z", DEADLINE), true);
  });

  test("an empty diary offers nothing later", () => {
    assert.equal(laterSlotsExist([], DEADLINE), false);
  });
});

describe("the scheduler acts on it", () => {
  const SOURCE = readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/(schedule)/schedule/appointment/TenantScheduler.tsx",
    ),
    "utf8",
  );

  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  test("it computes whether later times exist", () => {
    assert.match(code, /laterSlotsExist/);
  });

  test("the offer is gated on that, not shown unconditionally", () => {
    /*
      The defect exactly: the button used to render whenever a deadline
      existed, so it appeared in the one case where it could do nothing.
    */
    const button = code.indexOf("show me later dates");
    assert.ok(button > 0);
    const guard = code.slice(Math.max(0, button - 400), button);
    assert.match(guard, /laterSlotsExist/);
  });

  test("there is a way back to times within the deadline", () => {
    // Missing entirely before: a tenant who looked, then found something
    // earlier, had no route to it short of reloading.
    assert.match(code, /Back to times before/);
  });

  test("the way back is offered only when there is something to go back to", () => {
    // An overdue job has no compliant times by definition, and a dead control
    // is worse than none.
    const back = code.indexOf("Back to times before");
    const guard = code.slice(Math.max(0, back - 600), back);
    assert.match(guard, /!deadlineOverdue/);
    assert.match(guard, /hasCompliantSlot/);
  });

  test("going back clears the chosen date but keeps the hold", () => {
    /*
      The date may exist only in the later list, so keeping it would drop the
      tenant onto an empty set of times. The reservation is a server-side hold
      and is deliberately left alone — releasing it because somebody changed a
      filter would lose a slot they still have.
    */
    const back = code.indexOf("Back to times before");
    const handler = code.slice(Math.max(0, back - 900), back);
    assert.match(handler, /setSelectedDate\(null\)/);
    assert.match(handler, /setShowingLate\(false\)/);
    assert.match(handler, /setAcknowledged\(false\)/);
    assert.equal(/release\(/.test(handler), false);
  });

  test("the honest alternative is shown when nothing later exists", () => {
    assert.match(code, /no later dates to show|does not go past it yet/);
  });

  test("the booking horizon is not widened to paper over it", () => {
    // How far ahead BSCJ takes bookings is a business rule, not something a
    // tenant's frustration should change.
    assert.equal(/maximumAdvanceDays/.test(code), false);
  });

  test("the server still decides a late booking, not the browser", () => {
    // The acknowledgement is re-derived server-side; this component only
    // collects it.
    assert.match(code, /deadline_exceeded/);
    assert.match(code, /acknowledged/);
  });
});
