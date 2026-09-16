import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  jobDeadlineRisk,
  jobStage,
  needsAttention,
  type JobStateFacts,
} from "./derived";
import { JOB_LIFECYCLE_STATUSES } from "./lifecycle";

/**
 * The state that is computed rather than stored.
 *
 * "Certificate issued" and "invoiced" are derived from whether the document
 * exists, so a dashboard can never contradict the documents themselves.
 */

const facts = (over: Partial<JobStateFacts> = {}): JobStateFacts => ({
  lifecycleStatus: "completed",
  hasCertificate: false,
  isInvoiced: false,
  isPaid: false,
  ...over,
});

describe("the stage a job displays as", () => {
  test("before completion it is simply the lifecycle status", () => {
    for (const status of JOB_LIFECYCLE_STATUSES) {
      if (status === "completed" || status === "cancelled") continue;
      assert.equal(jobStage(facts({ lifecycleStatus: status })), status);
    }
  });

  test("a completed job with no certificate is awaiting one", () => {
    assert.equal(jobStage(facts()), "awaiting_certificate");
  });

  test("a certificate moves it on without a status change", () => {
    assert.equal(
      jobStage(facts({ hasCertificate: true })),
      "certificate_issued",
    );
  });

  test("money outranks documents, because it comes later", () => {
    /*
      An invoiced job is certainly completed and certificated, so showing
      "completed" would tell the reader less than we know.
    */
    assert.equal(
      jobStage(facts({ hasCertificate: true, isInvoiced: true })),
      "invoiced",
    );
    assert.equal(
      jobStage(facts({ hasCertificate: true, isInvoiced: true, isPaid: true })),
      "paid",
    );
  });

  test("cancellation outranks everything", () => {
    // A cancelled job that happens to carry a document is still cancelled.
    assert.equal(
      jobStage(
        facts({
          lifecycleStatus: "cancelled",
          hasCertificate: true,
          isInvoiced: true,
          isPaid: true,
        }),
      ),
      "cancelled",
    );
  });

  test("an unfinished job is never shown as certificated or invoiced", () => {
    // Documents only become a stage once the work itself is done.
    assert.equal(
      jobStage(facts({ lifecycleStatus: "scheduled", hasCertificate: true })),
      "scheduled",
    );
  });
});

describe("deadline risk on a job", () => {
  const today = "2026-09-16";

  test("a job with no deadline has no risk, rather than a normal one", () => {
    /*
      Saying "normal" would imply a deadline exists and is being met. A job
      asked for as soon as possible has no date to be measured against.
    */
    assert.equal(
      jobDeadlineRisk({ completeByDate: null, lifecycleStatus: "scheduled" }, today),
      null,
    );
  });

  test("an open job is measured against its deadline", () => {
    assert.equal(
      jobDeadlineRisk(
        { completeByDate: "2026-09-18", lifecycleStatus: "awaiting_tenant" },
        today,
      ),
      "urgent",
    );
    assert.equal(
      jobDeadlineRisk(
        { completeByDate: "2026-09-01", lifecycleStatus: "scheduled" },
        today,
      ),
      "overdue",
    );
  });

  test("a finished job cannot still be at risk", () => {
    // Whether it met the deadline is recorded on the job itself, as an
    // exception flag. Reporting it as overdue for ever would fill the
    // dashboard with work nobody can act on.
    for (const status of ["completed", "cancelled"] as const) {
      assert.equal(
        jobDeadlineRisk(
          { completeByDate: "2026-09-01", lifecycleStatus: status },
          today,
        ),
        null,
        status,
      );
    }
  });
});

describe("what needs a person", () => {
  const base = {
    lifecycleStatus: "awaiting_tenant" as const,
    risk: null,
    hasRemedialAwaitingApproval: false,
    calendarSyncFailed: false,
  };

  test("a job proceeding normally does not", () => {
    assert.equal(needsAttention(base), false);
    assert.equal(needsAttention({ ...base, risk: "normal" }), false);
    assert.equal(needsAttention({ ...base, risk: "approaching" }), false);
  });

  test("a failed calendar write always does", () => {
    // The customer may have been told an appointment exists that does not.
    assert.equal(needsAttention({ ...base, calendarSyncFailed: true }), true);
  });

  test("a remedial waiting on an agent does", () => {
    assert.equal(
      needsAttention({ ...base, hasRemedialAwaitingApproval: true }),
      true,
    );
  });

  test("an urgent or overdue deadline does", () => {
    assert.equal(needsAttention({ ...base, risk: "urgent" }), true);
    assert.equal(needsAttention({ ...base, risk: "overdue" }), true);
  });

  test("a cancelled job never does, whatever else is true of it", () => {
    assert.equal(
      needsAttention({
        lifecycleStatus: "cancelled",
        risk: "overdue",
        hasRemedialAwaitingApproval: true,
        calendarSyncFailed: true,
      }),
      false,
    );
  });
});
