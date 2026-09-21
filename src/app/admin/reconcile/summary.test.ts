import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { summariseReconcile } from "./summary";

/**
 * The one sentence this page must never print wrongly.
 *
 * "Nothing outstanding." is an instruction to stop looking. Every test here
 * is about the states in which it must not appear — and each of them is a
 * state the page was previously willing to print it in, because a failed or
 * truncated read collapsed into zero.
 */

const empty = {
  awaitingCalendarSync: 0,
  awaitingCalendarCleanup: 0,
  unpersistedBookings: 0,
  pendingNotifications: 0,
  failedNotifications: 0,
};

const exhausted = { rows: [], stoppedBecause: "exhausted" as const };

const base = {
  renewals: exhausted,
  messagesReadable: true,
  reservationsListed: true,
  counts: empty,
};

describe("when everything could be read", () => {
  test("an empty page says so plainly", () => {
    const result = summariseReconcile(base);
    assert.equal(result.nothingOutstanding, true);
    assert.equal(result.everythingKnown, true);
    assert.equal(result.renewalsUnavailable, false);
    assert.equal(result.renewalsIncomplete, false);
  });

  test("one outstanding renewal is enough to withhold it", () => {
    const result = summariseReconcile({
      ...base,
      renewals: { rows: [{}], stoppedBecause: "exhausted" },
    });
    assert.equal(result.nothingOutstanding, false);
  });

  test("and so is anything in any other queue", () => {
    for (const key of Object.keys(empty) as (keyof typeof empty)[]) {
      const result = summariseReconcile({
        ...base,
        counts: { ...empty, [key]: 1 },
      });
      assert.equal(result.nothingOutstanding, false, key);
    }
  });
});

describe("when the compliance records could not be read", () => {
  test("null is unknown, not zero", () => {
    /*
      **The defect.** `(renewals?.length ?? 0) === 0` made a failed query
      indistinguishable from a clean one, so the page told an administrator
      there were no repairs outstanding at the exact moment it had no idea.
    */
    const result = summariseReconcile({ ...base, renewals: null });
    assert.equal(result.renewalsUnavailable, true);
    assert.equal(result.nothingOutstanding, false);
    assert.equal(result.everythingKnown, false);
  });

  test("and nothing else being wrong does not rescue the claim", () => {
    const result = summariseReconcile({
      ...base,
      renewals: null,
      counts: empty,
    });
    assert.equal(result.nothingOutstanding, false);
  });
});

describe("when the walk stopped before the end", () => {
  test("a bounded search with nothing found has ruled nothing out", () => {
    const result = summariseReconcile({
      ...base,
      renewals: { rows: [], stoppedBecause: "bound" },
    });
    assert.equal(result.renewalsIncomplete, true);
    assert.equal(result.renewalsUnavailable, false);
    assert.equal(result.nothingOutstanding, false);
    assert.equal(result.everythingKnown, false);
  });

  test("a full page of repairs is incomplete too", () => {
    const result = summariseReconcile({
      ...base,
      renewals: { rows: [{}, {}], stoppedBecause: "limit" },
    });
    assert.equal(result.renewalsIncomplete, true);
    assert.equal(result.nothingOutstanding, false);
  });
});

describe("the other two unknowns", () => {
  test("an unreadable message queue qualifies the reassurance", () => {
    const result = summariseReconcile({ ...base, messagesReadable: false });
    assert.equal(result.everythingKnown, false);
    // Still "nothing outstanding", but the page words it as what it can see.
    assert.equal(result.nothingOutstanding, true);
  });

  test("an unlistable reservation store does the same", () => {
    const result = summariseReconcile({ ...base, reservationsListed: false });
    assert.equal(result.everythingKnown, false);
    assert.equal(result.nothingOutstanding, true);
  });
});
