import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  assignRefusal,
  availableActions,
  canAssign,
  canComplete,
  canStart,
  canUnassign,
  checkCompletionNote,
  completeRefusal,
  MAX_COMPLETION_NOTE,
  startRefusal,
  type WorkFacts,
} from "./work";
import { JOB_LIFECYCLE_STATUSES, type JobLifecycleStatus } from "./lifecycle";

/**
 * What may be done to a job, and by whom.
 *
 * These rules are enforced in two places — the buttons a screen renders and
 * the write the action performs — and the whole point of putting them here is
 * that both read the same functions. A rule that were only in the handler
 * would be a button that appears and then refuses; one that were only in the
 * screen would be a write nobody checked.
 */

const ME = "11111111-1111-4111-8111-111111111111";
const SOMEBODY_ELSE = "22222222-2222-4222-8222-222222222222";

const facts = (over: Partial<WorkFacts> = {}): WorkFacts => ({
  lifecycleStatus: "scheduled",
  assignedEngineerId: null,
  hasAppointment: true,
  ...over,
});

describe("allocating work", () => {
  test("a scheduled job with a time can be allocated", () => {
    assert.equal(canAssign(facts()), true);
    assert.equal(assignRefusal(facts()), null);
  });

  test("a job with no appointment cannot be, whatever its status", () => {
    // Allocating somebody to a job with no agreed time is allocating them to
    // nothing — and the engineer's day view is built on the appointment.
    assert.equal(canAssign(facts({ hasAppointment: false })), false);
    assert.match(assignRefusal(facts({ hasAppointment: false }))!, /no appointment/i);
  });

  test("a job already with somebody can be moved to somebody else", () => {
    assert.equal(
      canAssign(facts({ lifecycleStatus: "engineer_assigned", assignedEngineerId: ME })),
      true,
    );
    // Including mid-visit: swapping an engineer is a real operational event,
    // and making it illegal only pushes it into a hand-edited row.
    assert.equal(
      canAssign(facts({ lifecycleStatus: "in_progress", assignedEngineerId: ME })),
      true,
    );
  });

  test("a finished or cancelled job cannot be allocated", () => {
    for (const status of ["completed", "cancelled"] as JobLifecycleStatus[]) {
      assert.equal(canAssign(facts({ lifecycleStatus: status })), false, status);
      assert.ok(assignRefusal(facts({ lifecycleStatus: status })));
    }
  });

  test("a job still with the tenant cannot be allocated", () => {
    for (const status of [
      "draft",
      "tenant_outreach",
      "awaiting_tenant",
    ] as JobLifecycleStatus[]) {
      assert.equal(canAssign(facts({ lifecycleStatus: status })), false, status);
    }
  });

  test("every refusal says something, for every status", () => {
    // A control that disappears without explanation is a support call.
    for (const status of JOB_LIFECYCLE_STATUSES) {
      const f = facts({ lifecycleStatus: status });
      if (canAssign(f)) assert.equal(assignRefusal(f), null, status);
      else assert.ok(assignRefusal(f), status);
    }
  });
});

describe("taking somebody off a job", () => {
  test("allowed before the visit", () => {
    assert.equal(
      canUnassign(
        facts({ lifecycleStatus: "engineer_assigned", assignedEngineerId: ME }),
      ),
      true,
    );
  });

  test("refused once they are on site", () => {
    // It would leave a job in progress with nobody on it. Reassign instead.
    assert.equal(
      canUnassign(facts({ lifecycleStatus: "in_progress", assignedEngineerId: ME })),
      false,
    );
  });

  test("there is nobody to take off a job nobody is on", () => {
    assert.equal(canUnassign(facts({ lifecycleStatus: "scheduled" })), false);
  });
});

describe("starting the work", () => {
  const allocated = facts({
    lifecycleStatus: "engineer_assigned",
    assignedEngineerId: ME,
  });

  test("the engineer it is allocated to may start it", () => {
    assert.equal(canStart(allocated, ME), true);
    assert.equal(startRefusal(allocated, ME), null);
  });

  test("somebody else may not, even though the status allows it", () => {
    /*
      The rule that keeps the restricted interface restricted: assignment is
      the whole permission, so an engineer who is not on this job is in the
      same position as a stranger.
    */
    assert.equal(canStart(allocated, SOMEBODY_ELSE), false);
    assert.match(startRefusal(allocated, SOMEBODY_ELSE)!, /somebody else/i);
  });

  test("a job nobody is allocated to cannot be started", () => {
    const f = facts({ lifecycleStatus: "scheduled" });
    assert.equal(canStart(f, ME), false);
    assert.match(startRefusal(f, ME)!, /nobody is allocated/i);
  });

  test("starting twice is refused, not repeated", () => {
    const f = facts({ lifecycleStatus: "in_progress", assignedEngineerId: ME });
    assert.equal(canStart(f, ME), false);
    assert.match(startRefusal(f, ME)!, /already started/i);
  });
});

describe("recording the work as done", () => {
  const onSite = facts({ lifecycleStatus: "in_progress", assignedEngineerId: ME });

  test("the engineer on site may complete it", () => {
    assert.equal(canComplete(onSite, ME), true);
    assert.equal(completeRefusal(onSite, ME), null);
  });

  test("a job that was never started cannot be completed", () => {
    const f = facts({
      lifecycleStatus: "engineer_assigned",
      assignedEngineerId: ME,
    });
    assert.equal(canComplete(f, ME), false);
    assert.match(completeRefusal(f, ME)!, /start the job/i);
  });

  test("somebody else's job cannot be completed by this engineer", () => {
    assert.equal(canComplete(onSite, SOMEBODY_ELSE), false);
  });

  test("completing twice is refused", () => {
    const f = facts({ lifecycleStatus: "completed", assignedEngineerId: ME });
    assert.equal(canComplete(f, ME), false);
    assert.match(completeRefusal(f, ME)!, /already/i);
  });
});

describe("only one action is ever offered at a time", () => {
  test("no status offers both start and complete", () => {
    /*
      The engineer's screen renders whichever action the job is ready for.
      Two at once would be a choice to get wrong at a front door.
    */
    for (const status of JOB_LIFECYCLE_STATUSES) {
      const actions = availableActions(
        facts({ lifecycleStatus: status, assignedEngineerId: ME }),
        ME,
      );
      assert.ok(actions.length <= 1, `${status} offers ${actions.join(" and ")}`);
    }
  });

  test("an engineer who is not on the job is offered nothing, in any status", () => {
    for (const status of JOB_LIFECYCLE_STATUSES) {
      assert.deepEqual(
        availableActions(
          facts({ lifecycleStatus: status, assignedEngineerId: ME }),
          SOMEBODY_ELSE,
        ),
        [],
        status,
      );
    }
  });
});

describe("the engineer's account of the visit", () => {
  test("nothing said is an ordinary outcome, stored as nothing", () => {
    // Forcing a sentence out of somebody produces "n/a", not information.
    assert.deepEqual(checkCompletionNote(""), { ok: true, value: null });
    assert.deepEqual(checkCompletionNote("   "), { ok: true, value: null });
    assert.deepEqual(checkCompletionNote(undefined), { ok: true, value: null });
    assert.deepEqual(checkCompletionNote(null), { ok: true, value: null });
  });

  test("a note is trimmed and kept", () => {
    assert.deepEqual(checkCompletionNote("  Boiler fine.  "), {
      ok: true,
      value: "Boiler fine.",
    });
  });

  test("an over-long note is refused, never silently cut in half", () => {
    const result = checkCompletionNote("x".repeat(MAX_COMPLETION_NOTE + 1));
    assert.equal(result.ok, false);
  });

  test("a note of exactly the limit is accepted", () => {
    const result = checkCompletionNote("x".repeat(MAX_COMPLETION_NOTE));
    assert.equal(result.ok, true);
  });
});
