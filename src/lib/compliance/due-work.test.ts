import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { bucketFor, resolveRange } from "./due-work";

/**
 * Where a renewal sits relative to the range somebody chose.
 *
 * The rules that matter are the ones about **not inventing a policy**: the
 * range is the operator's, "overdue" is a fact about today rather than a
 * threshold, and a property with no date on file is a state of its own rather
 * than an absence that drops off the list.
 */

const TODAY = "2026-09-22";
const RANGE = { from: "2026-09-22", to: "2026-11-21" };

describe("which bucket a due date falls in", () => {
  test("yesterday is overdue", () => {
    assert.equal(bucketFor("2026-09-21", RANGE, TODAY), "overdue");
  });

  test("today is not overdue — there are still hours left in it", () => {
    assert.equal(bucketFor(TODAY, RANGE, TODAY), "in_range");
  });

  test("a date inside the chosen range is in range", () => {
    assert.equal(bucketFor("2026-10-15", RANGE, TODAY), "in_range");
  });

  test("both ends of the range are included", () => {
    assert.equal(bucketFor(RANGE.from, RANGE, TODAY), "in_range");
    assert.equal(bucketFor(RANGE.to, RANGE, TODAY), "in_range");
  });

  test("a date beyond the range is later, not hidden", () => {
    assert.equal(bucketFor("2027-03-01", RANGE, TODAY), "later");
  });

  test("overdue beats the range, even when the range starts in the past", () => {
    /*
      An operator looking back over the summer still needs August's overdue
      work marked overdue rather than quietly counted as "due in range".
    */
    const lookingBack = { from: "2026-08-01", to: "2026-12-31" };
    assert.equal(bucketFor("2026-08-15", lookingBack, TODAY), "overdue");
  });

  test("no date on file is its own state, not an absence", () => {
    // Usually an import with no expiry column. Hiding these would make the
    // list look complete when it is not.
    assert.equal(bucketFor(null, RANGE, TODAY), "unknown");
  });

  test("a value that is not a real date is unknown rather than guessed at", () => {
    assert.equal(bucketFor("2027-02-30", RANGE, TODAY), "unknown");
    assert.equal(bucketFor("not a date", RANGE, TODAY), "unknown");
  });
});

describe("the range the operator asked for", () => {
  test("two valid dates are used as given", () => {
    assert.deepEqual(resolveRange("2026-10-01", "2026-10-31", TODAY), {
      from: "2026-10-01",
      to: "2026-10-31",
    });
  });

  test("nothing chosen starts at today and runs sixty days", () => {
    // A starting view, not a policy: it is shown on screen and editable, and
    // nothing anywhere acts on it.
    const range = resolveRange(undefined, undefined, TODAY);
    assert.equal(range.from, TODAY);
    assert.equal(range.to, "2026-11-21");
  });

  test("an inverted range falls back rather than returning nothing", () => {
    const range = resolveRange("2026-12-01", "2026-10-01", TODAY);
    assert.equal(range.from, TODAY);
    assert.equal(range.to, "2026-11-21");
  });

  test("a mistyped date does not produce an empty screen", () => {
    const range = resolveRange("last tuesday", "2026-10-31", TODAY);
    assert.equal(range.from, TODAY);
    assert.equal(range.to, "2026-10-31");
  });

  test("the sixty days crosses a year end correctly", () => {
    const range = resolveRange(undefined, undefined, "2026-12-15");
    assert.equal(range.to, "2027-02-13");
  });

  test("and a leap year", () => {
    const range = resolveRange(undefined, undefined, "2028-01-15");
    assert.equal(range.to, "2028-03-15");
  });
});
