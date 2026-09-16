import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  allowedTransitions,
  assertTransition,
  canTransition,
  expectsAppointment,
  InvalidJobTransitionError,
  initialStatus,
  isJobLifecycleStatus,
  isTerminal,
  JOB_LIFECYCLE_STATUSES,
  TERMINAL_STATUSES,
  UNSCHEDULED_STATUSES,
  type JobLifecycleStatus,
} from "./lifecycle";

/**
 * The lifecycle is small enough to state exhaustively, so it is: every pair of
 * statuses is checked against an explicit table rather than a handful of
 * examples. A transition that is quietly allowed is how a job ends up in a
 * state nobody can explain a year later.
 */
describe("job lifecycle transitions", () => {
  /** The permitted moves, written out independently of the implementation. */
  const PERMITTED: Record<JobLifecycleStatus, JobLifecycleStatus[]> = {
    draft: ["tenant_outreach", "awaiting_tenant", "scheduled", "cancelled"],
    tenant_outreach: ["awaiting_tenant", "scheduled", "cancelled"],
    awaiting_tenant: ["tenant_outreach", "scheduled", "cancelled"],
    scheduled: [
      "engineer_assigned",
      "awaiting_tenant",
      "in_progress",
      "cancelled",
    ],
    engineer_assigned: [
      "in_progress",
      "scheduled",
      "awaiting_tenant",
      "cancelled",
    ],
    in_progress: ["remedial_required", "completed", "cancelled"],
    remedial_required: ["completed", "scheduled", "cancelled"],
    completed: [],
    cancelled: [],
  };

  test("every pair is decided the same way the table decides it", () => {
    for (const from of JOB_LIFECYCLE_STATUSES) {
      for (const to of JOB_LIFECYCLE_STATUSES) {
        assert.equal(
          canTransition(from, to),
          PERMITTED[from].includes(to),
          `${from} → ${to} disagreed with the table`,
        );
      }
    }
  });

  test("a job cannot transition to the status it already has", () => {
    // Re-applying a status is a no-op the caller should not have asked for,
    // and allowing it would hide a double submission rather than reveal one.
    for (const status of JOB_LIFECYCLE_STATUSES) {
      assert.equal(canTransition(status, status), false, `${status} → itself`);
    }
  });

  test("completion and cancellation are both endings", () => {
    assert.deepEqual([...TERMINAL_STATUSES].sort(), ["cancelled", "completed"]);
    for (const status of TERMINAL_STATUSES) {
      assert.equal(isTerminal(status), true);
      assert.deepEqual(allowedTransitions(status), []);
    }
  });

  test("cancellation is an alternative ending, not one that follows completion", () => {
    // Work that has been carried out cannot become work that never happened.
    // Undoing a completed job is a credit note and a conversation.
    assert.equal(canTransition("completed", "cancelled"), false);
    assert.equal(canTransition("cancelled", "completed"), false);
  });

  test("nothing escapes a terminal status", () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of JOB_LIFECYCLE_STATUSES) {
        assert.equal(canTransition(from, to), false, `${from} → ${to}`);
      }
    }
  });

  test("everything unfinished can be cancelled", () => {
    // A job that cannot be cancelled is a job someone works around.
    for (const status of JOB_LIFECYCLE_STATUSES) {
      if (isTerminal(status)) continue;
      assert.equal(canTransition(status, "cancelled"), true, status);
    }
  });

  test("a tenant who cancels can be asked to choose again", () => {
    // A real operational event. Forbidding it would push it into a
    // delete-and-recreate, which loses the history.
    assert.equal(canTransition("scheduled", "awaiting_tenant"), true);
    assert.equal(canTransition("engineer_assigned", "awaiting_tenant"), true);
  });

  test("an engineer can be unassigned without losing the appointment", () => {
    assert.equal(canTransition("engineer_assigned", "scheduled"), true);
  });

  test("a remedial does not end the job", () => {
    // It is work that has been attended and cannot yet close: it can finish,
    // or go back for a second visit.
    assert.equal(isTerminal("remedial_required"), false);
    assert.equal(canTransition("in_progress", "remedial_required"), true);
    assert.equal(canTransition("remedial_required", "completed"), true);
    assert.equal(canTransition("remedial_required", "scheduled"), true);
  });

  test("nothing unattended can jump straight to completed", () => {
    // A job with no appointment holds nothing to have attended.
    for (const status of UNSCHEDULED_STATUSES) {
      assert.equal(canTransition(status, "completed"), false, status);
    }
    assert.equal(canTransition("scheduled", "completed"), false);
  });

  test("asserting a legal move is silent, and an illegal one is loud", () => {
    assert.doesNotThrow(() => assertTransition("in_progress", "completed"));

    assert.throws(
      () => assertTransition("completed", "scheduled"),
      (error: unknown) => {
        assert.ok(error instanceof InvalidJobTransitionError);
        assert.equal(error.from, "completed");
        assert.equal(error.to, "scheduled");
        return true;
      },
    );
  });

  test("only the nine statuses are recognised", () => {
    for (const status of JOB_LIFECYCLE_STATUSES) {
      assert.equal(isJobLifecycleStatus(status), true);
    }
    for (const value of [
      "invoiced",
      "certificate_sent",
      "certificate_issued",
      "paid",
      "",
      null,
      undefined,
      42,
      {},
    ]) {
      assert.equal(isJobLifecycleStatus(value), false, String(value));
    }
  });

  test("money and documents are deliberately not statuses here", () => {
    /*
      The brief listed "Certificate Issued" and "Invoiced" as statuses. They
      are not: a job is routinely completed, certificated and invoiced at once,
      and one enum has to pick one of those, which loses the others. They are
      derived in `derived.ts` from whether the document exists.
    */
    const names = JOB_LIFECYCLE_STATUSES.join(",");
    for (const absent of ["invoice", "paid", "certificate", "deadline"]) {
      assert.equal(names.includes(absent), false, `${absent} leaked in`);
    }
  });

  test("whether an appointment is expected is derived from the status", () => {
    // Used to decide whether a calendar event is required at all, rather than
    // inferring it from a null timestamp.
    for (const status of UNSCHEDULED_STATUSES) {
      assert.equal(expectsAppointment(status), false, status);
    }
    assert.equal(expectsAppointment("scheduled"), true);
    assert.equal(expectsAppointment("completed"), true);
    assert.equal(expectsAppointment("cancelled"), false);
  });
});

describe("where a new job starts", () => {
  test("a job the tenant will schedule begins with outreach, not with waiting", () => {
    // "Awaiting tenant" means the tenant has the link. A job that has just
    // been created has not contacted anybody yet, and a dashboard that says
    // otherwise sends an agent chasing a tenant nobody has written to.
    assert.equal(
      initialStatus({ tenantWillSchedule: true }),
      "tenant_outreach",
    );
  });

  test("anything else is booked the moment it is created", () => {
    assert.equal(initialStatus({ tenantWillSchedule: false }), "scheduled");
  });

  test("a job still being assembled is a draft", () => {
    assert.equal(
      initialStatus({ tenantWillSchedule: true, isDraft: true }),
      "draft",
    );
  });

  test("a new job never starts in a terminal status", () => {
    for (const tenantWillSchedule of [true, false]) {
      for (const isDraft of [true, false]) {
        assert.equal(
          isTerminal(initialStatus({ tenantWillSchedule, isDraft })),
          false,
        );
      }
    }
  });
});
