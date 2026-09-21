import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  bookingHorizon,
  laterDatesView,
  withinDeadline,
  type DeadlineDay,
} from "./later-dates";

/**
 * Offering later dates.
 *
 * Observed on 21 September: deadline 21 October, `maximumAdvanceDays` 30. The
 * window ended at the deadline, so **every** slot was already before it —
 * "show me later dates" revealed the same list while announcing "you are now
 * choosing from times after 21 October", and there was no way back.
 *
 * These exercise `laterDatesView` itself, which is what the component renders
 * from. Nothing below reimplements the rule: a test that recomputed the answer
 * would have passed against the broken component too.
 */

const DEADLINE_DATE = "2026-10-21";
/** End of the deadline date. A slot must *finish* by it. */
const ENDS_BEFORE = "2026-10-21T23:00:00.000Z";

/** One 45-minute slot, on a date, at an hour. */
function slot(date: string, hour: number) {
  const start = `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const end = `${date}T${String(hour).padStart(2, "0")}:45:00.000Z`;
  return { startIso: start, endIso: end, label: `${hour}:00` };
}

/**
 * The window as `/api/availability` returns it: **every** date it takes
 * bookings for, whether or not any time on it is free.
 */
function window(entries: [string, number[]][]): DeadlineDay<ReturnType<typeof slot>>[] {
  return entries.map(([date, hours]) => ({
    date,
    slots: hours.map((hour) => slot(date, hour)),
  }));
}

function view(
  days: DeadlineDay<ReturnType<typeof slot>>[],
  options: { showingLate?: boolean; overdue?: boolean; deadline?: boolean } = {},
) {
  const hasDeadline = options.deadline !== false;
  return laterDatesView({
    days,
    endsBeforeIso: hasDeadline ? ENDS_BEFORE : null,
    deadlineDate: hasDeadline ? DEADLINE_DATE : null,
    showingLate: options.showingLate ?? false,
    deadlineOverdue: options.overdue ?? false,
  });
}

describe("the cutoff itself", () => {
  test("a slot that starts before and ends after the deadline is late", () => {
    // The cutoff is on the end, because a booking starting at 22:30 does not
    // finish before the day does.
    assert.equal(
      withinDeadline(
        { startIso: "2026-10-21T22:30:00.000Z", endIso: "2026-10-21T23:30:00.000Z" },
        ENDS_BEFORE,
      ),
      false,
    );
    assert.equal(
      withinDeadline(
        { startIso: "2026-10-21T22:00:00.000Z", endIso: "2026-10-21T23:00:00.000Z" },
        ENDS_BEFORE,
      ),
      true,
    );
  });

  test("no deadline means nothing is ever late", () => {
    assert.equal(
      withinDeadline(
        { startIso: "2099-01-01T00:00:00.000Z", endIso: "2099-01-01T01:00:00.000Z" },
        null,
      ),
      true,
    );
  });
});

describe("the horizon is read off the diary, not from configuration", () => {
  test("it is the last date offered, free or not", () => {
    assert.equal(
      bookingHorizon(window([["2026-10-20", [9]], ["2026-10-25", []]])),
      "2026-10-25",
    );
  });

  test("an empty diary has no horizon", () => {
    assert.equal(bookingHorizon([]), null);
  });
});

describe("where the deadline sits relative to the booking window", () => {
  test("INSIDE the window — later times exist, so the offer is real", () => {
    const result = view(
      window([
        ["2026-10-10", [9]],
        ["2026-10-21", [9]],
        ["2026-10-25", [9]],
      ]),
    );

    assert.equal(result.laterSlotsExist, true);
    assert.equal(result.hasCompliantSlot, true);
    assert.equal(result.offer, "offer");
  });

  test("AT the end of the window — nothing later exists, and nothing is promised", () => {
    /*
      The reported case. The last bookable day is the deadline itself, so every
      slot is compliant and there is nothing whatsoever to reveal.
    */
    const result = view(
      window([
        ["2026-10-10", [9]],
        ["2026-10-21", [9, 16]],
      ]),
    );

    assert.equal(result.laterSlotsExist, false);
    assert.equal(result.windowReachesPastDeadline, false);
    assert.equal(result.offer, "beyond_horizon");
  });

  test("BEYOND the window — the deadline is further off than we book", () => {
    const result = view(
      window([
        ["2026-09-25", [9]],
        ["2026-10-01", [9]],
      ]),
    );

    assert.equal(result.laterSlotsExist, false);
    assert.equal(result.windowReachesPastDeadline, false);
    assert.equal(result.offer, "beyond_horizon");
  });

  test("PAST the deadline but fully booked — waiting will not help, so it does not say wait", () => {
    /*
      The distinction the first version lost. The diary *does* reach past the
      deadline; every time on those dates is taken. "We open more dates as they
      get closer" would be false comfort.
    */
    const result = view(
      window([
        ["2026-10-20", [9]],
        ["2026-10-22", []],
        ["2026-10-26", []],
      ]),
    );

    assert.equal(result.laterSlotsExist, false);
    assert.equal(result.windowReachesPastDeadline, true);
    assert.equal(result.offer, "later_taken");
  });

  test("an empty diary offers nothing later and claims no horizon", () => {
    const result = view([]);
    assert.equal(result.laterSlotsExist, false);
    assert.equal(result.hasCompliantSlot, false);
    assert.equal(result.offer, "beyond_horizon");
  });

  test("a full diary past the deadline with nothing compliant still reaches past it", () => {
    const result = view(window([["2026-10-20", []], ["2026-10-24", []]]));
    assert.equal(result.hasCompliantSlot, false);
    assert.equal(result.offer, "later_taken");
  });

  test("no deadline at all hides the whole question", () => {
    const result = view(window([["2026-10-25", [9]]]), { deadline: false });
    assert.equal(result.offer, "hidden");
    assert.equal(result.visibleDays[0].slots.length, 1);
  });
});

describe("what the tenant is actually shown", () => {
  const DIARY = window([
    ["2026-10-10", [9]],
    ["2026-10-25", [9, 11]],
  ]);

  test("before asking, only times that meet the deadline", () => {
    const result = view(DIARY);
    assert.deepEqual(
      result.visibleDays.map((day) => day.slots.length),
      [1, 0],
    );
  });

  test("after asking, the earlier times are still there", () => {
    /*
      The wording defect. Revealing later dates **widens** the list; it does
      not replace it. "You are now choosing from times after 21 October" was
      describing a filter the page does not apply.
    */
    const result = view(DIARY, { showingLate: true });
    assert.deepEqual(
      result.visibleDays.map((day) => day.slots.length),
      [1, 2],
    );
    assert.equal(result.showingEarlierToo, true);
  });

  test("filtering never mutates the diary it was given", () => {
    const diary = window([["2026-10-25", [9]]]);
    view(diary, { showingLate: true }).visibleDays[0].slots.pop();
    assert.equal(diary[0].slots.length, 1);
  });

  test("the offer is withdrawn once later times are showing", () => {
    assert.equal(view(DIARY, { showingLate: true }).offer, "hidden");
  });
});

describe("returning to times within the deadline", () => {
  test("offered when something compliant remains", () => {
    const result = view(
      window([
        ["2026-10-10", [9]],
        ["2026-10-25", [9]],
      ]),
      { showingLate: true },
    );
    assert.equal(result.canReturnToEarlier, true);
  });

  test("not offered when nothing compliant remains — a dead control is worse than none", () => {
    const result = view(window([["2026-10-25", [9]]]), { showingLate: true });
    assert.equal(result.canReturnToEarlier, false);
    assert.equal(result.showingEarlierToo, false);
  });

  test("not offered on an overdue job, which has no compliant times by definition", () => {
    const result = view(window([["2026-10-25", [9]]]), {
      showingLate: true,
      overdue: true,
    });
    assert.equal(result.canReturnToEarlier, false);
    assert.equal(result.showingEarlierToo, false);
  });

  test("an overdue job starts on the later list and is never offered the button", () => {
    // `showingLate` is initialised from `deadlineOverdue`, so this is the
    // state the page opens in.
    const result = view(window([["2026-10-25", [9]]]), {
      showingLate: true,
      overdue: true,
    });
    assert.equal(result.offer, "hidden");
    assert.equal(result.visibleDays[0].slots.length, 1);
  });
});

/**
 * The few things the view cannot state on its own: that the component uses it,
 * that the hold survives a change of filter, and that the server still decides.
 * Each is a property of the wiring rather than of the rule.
 */
describe("the scheduler is wired to it", () => {
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

  test("it renders from the shared view rather than its own copy of the rule", () => {
    assert.match(code, /laterDatesView\(/);
    assert.equal(/const laterSlotsExist =/.test(code), false);
  });

  test("going back clears the chosen date but keeps the hold", () => {
    /*
      The date may exist only in the later list, so keeping it would drop the
      tenant onto an empty set of times. The reservation is a server-side hold
      and is deliberately left alone — releasing it because somebody changed a
      filter would lose a slot they still have.
    */
    const back = code.indexOf("Back to times before");
    assert.ok(back > 0);
    const handler = code.slice(Math.max(0, back - 900), back);
    assert.match(handler, /setSelectedDate\(null\)/);
    assert.match(handler, /setShowingLate\(false\)/);
    assert.match(handler, /setAcknowledged\(false\)/);
    assert.equal(/release\(/.test(handler), false);
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
