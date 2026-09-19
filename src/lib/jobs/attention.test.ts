import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ATTENTION_LABELS,
  ATTENTION_NOTES,
  ATTENTION_REASONS,
  attentionFor,
  attentionReasons,
  type AttentionInput,
} from "./attention";
import { needsAttention } from "./derived";
import { JOB_LIFECYCLE_STATUSES } from "./lifecycle";
import { DEADLINE_RISKS } from "@/lib/compliance/renewal";

/**
 * The queue says why, and it never disagrees with the badge.
 *
 * The failure worth preventing is the two drifting apart: a dashboard that
 * counts a job as needing attention while the job itself lists no reason is
 * a dashboard nobody can act on, and the fix is usually to stop believing the
 * count. So the agreement is exhaustively asserted rather than assumed.
 */

const clean = (over: Partial<AttentionInput> = {}): AttentionInput => ({
  lifecycleStatus: "scheduled",
  calendarSyncPending: false,
  calendarCleanupOutstanding: false,
  messageFailed: false,
  hasDeadlineException: false,
  risk: null,
  hasRemedialAwaitingApproval: false,
  ...over,
});

describe("a job with nothing wrong with it", () => {
  test("has no reasons and needs nobody", () => {
    const { needed, reasons } = attentionFor(clean());
    assert.equal(needed, false);
    assert.deepEqual(reasons, []);
  });

  test("a deadline comfortably ahead is not a reason", () => {
    assert.deepEqual(attentionReasons(clean({ risk: "normal" })), []);
    assert.deepEqual(attentionReasons(clean({ risk: "approaching" })), []);
  });
});

describe("each signal produces its own reason", () => {
  const cases: [Partial<AttentionInput>, string][] = [
    [{ calendarSyncPending: true }, "calendar_not_written"],
    [{ calendarCleanupOutstanding: true }, "calendar_left_behind"],
    [{ messageFailed: true }, "message_failed"],
    [{ hasDeadlineException: true }, "deadline_exception"],
    [{ risk: "overdue" }, "deadline_overdue"],
    [{ risk: "urgent" }, "deadline_urgent"],
    [{ hasRemedialAwaitingApproval: true }, "remedial_awaiting_approval"],
  ];

  for (const [input, expected] of cases) {
    test(`${expected}`, () => {
      assert.deepEqual(attentionReasons(clean(input)), [expected]);
    });
  }

  test("every named reason is reachable", () => {
    // A reason nothing can produce is a label pretending to be a signal.
    const produced = new Set(cases.map(([, reason]) => reason));
    for (const reason of ATTENTION_REASONS) {
      assert.ok(produced.has(reason), `${reason} is never produced`);
    }
  });
});

describe("several things can be wrong at once", () => {
  test("all of them are reported, not just the first", () => {
    const reasons = attentionReasons(
      clean({
        calendarSyncPending: true,
        messageFailed: true,
        risk: "overdue",
      }),
    );
    assert.deepEqual(reasons, [
      "calendar_not_written",
      "deadline_overdue",
      "message_failed",
    ]);
  });

  test("the worst is first", () => {
    // An appointment the diary does not hold outranks a note left behind in it.
    const reasons = attentionReasons(
      clean({ calendarCleanupOutstanding: true, calendarSyncPending: true }),
    );
    assert.equal(reasons[0], "calendar_not_written");
  });
});

describe("a cancelled job needs nobody", () => {
  test("whatever else is outstanding on it", () => {
    /*
      Its messages are stood down by the outbox and its calendar entry by the
      reconciliation sweep. Leaving it on the queue would mean a list that
      only ever grows.
    */
    const reasons = attentionReasons(
      clean({
        lifecycleStatus: "cancelled",
        calendarSyncPending: true,
        messageFailed: true,
        hasDeadlineException: true,
        risk: "overdue",
        hasRemedialAwaitingApproval: true,
      }),
    );
    assert.deepEqual(reasons, []);
    assert.equal(attentionFor(clean({ lifecycleStatus: "cancelled" })).needed, false);
  });
});

describe("the badge and the reasons never disagree", () => {
  test("across every combination of every signal", () => {
    const booleans = [false, true];
    let checked = 0;

    for (const lifecycleStatus of JOB_LIFECYCLE_STATUSES) {
      for (const risk of [null, ...DEADLINE_RISKS]) {
        for (const calendarSyncPending of booleans) {
          for (const calendarCleanupOutstanding of booleans) {
            for (const messageFailed of booleans) {
              for (const hasDeadlineException of booleans) {
                for (const hasRemedialAwaitingApproval of booleans) {
                  const input = clean({
                    lifecycleStatus,
                    risk,
                    calendarSyncPending,
                    calendarCleanupOutstanding,
                    messageFailed,
                    hasDeadlineException,
                    hasRemedialAwaitingApproval,
                  });
                  const { needed, reasons } = attentionFor(input);
                  assert.equal(
                    needed,
                    reasons.length > 0,
                    `${lifecycleStatus}/${risk} disagreed: needed=${needed}, reasons=[${reasons}]`,
                  );
                  checked += 1;
                }
              }
            }
          }
        }
      }
    }

    assert.ok(checked > 1000, "the combinations were not actually enumerated");
    // And the boolean is the one in `derived.ts`, not a second opinion.
    assert.equal(typeof needsAttention, "function");
  });
});

describe("every reason can be shown to a person", () => {
  test("each has a label and a note saying what to do", () => {
    for (const reason of ATTENTION_REASONS) {
      assert.ok(ATTENTION_LABELS[reason]?.length, reason);
      assert.ok(ATTENTION_NOTES[reason]?.length, reason);
    }
  });

  test("no label blames anybody or reads as an error code", () => {
    for (const reason of ATTENTION_REASONS) {
      assert.equal(/error|failure|exception:/i.test(ATTENTION_LABELS[reason]), false, reason);
    }
  });
});
