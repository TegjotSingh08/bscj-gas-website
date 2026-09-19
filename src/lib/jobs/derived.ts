/**
 * The parts of a job's state that are *not* stored.
 *
 * The brief listed "Certificate Issued" and "Invoiced" alongside the lifecycle
 * statuses. They are deliberately not statuses: a job is routinely completed,
 * certificated and invoiced at the same time, and one enum has to pick one of
 * those to display, which loses the other two — and can contradict the
 * documents themselves.
 *
 * So they are computed from whether the document exists. A dashboard still
 * shows them as stages; it just derives them, and cannot go stale.
 *
 * Pure and dependency-free.
 */

import type { JobLifecycleStatus } from "./lifecycle";
import { deadlineRisk, type DeadlineRisk, type DeadlineWindows } from "@/lib/compliance/renewal";

/**
 * What a job looks like to a dashboard, once documents are taken into account.
 *
 * Ordered as the work actually proceeds, so a list can sort by it.
 */
export const JOB_STAGES = [
  "draft",
  "tenant_outreach",
  "awaiting_tenant",
  "scheduled",
  "engineer_assigned",
  "in_progress",
  "remedial_required",
  "awaiting_certificate",
  "certificate_issued",
  "invoiced",
  "paid",
  "cancelled",
] as const;

export type JobStage = (typeof JOB_STAGES)[number];

/** Everything the derivation needs, and nothing it does not. */
export type JobStateFacts = {
  lifecycleStatus: JobLifecycleStatus;
  /** A current-version certificate exists for this job. */
  hasCertificate: boolean;
  /** An invoice line references this job. */
  isInvoiced: boolean;
  /** That invoice has been marked paid. */
  isPaid: boolean;
};

/**
 * The stage to show.
 *
 * Money outranks documents and documents outrank the lifecycle, because that
 * is the order in which the work finishes: an invoiced job is certainly
 * completed and certificated, so showing "completed" would be telling the
 * reader less than we know.
 *
 * `cancelled` outranks everything: a cancelled job that happens to carry a
 * document is still cancelled.
 */
export function jobStage(facts: JobStateFacts): JobStage {
  if (facts.lifecycleStatus === "cancelled") return "cancelled";

  if (facts.lifecycleStatus === "completed") {
    if (facts.isPaid) return "paid";
    if (facts.isInvoiced) return "invoiced";
    return facts.hasCertificate ? "certificate_issued" : "awaiting_certificate";
  }

  return facts.lifecycleStatus;
}

/** Whether the job is finished as far as the work itself is concerned. */
export function isWorkComplete(status: JobLifecycleStatus): boolean {
  return status === "completed";
}

/**
 * Whether a job belongs in the "needs attention" bucket.
 *
 * Deliberately generous: a dashboard that under-reports is one nobody trusts.
 * A job needs attention when nothing can move it forward without a person —
 * the tenant has not responded, the deadline is at risk, a remedial is waiting
 * on an approval, or an external write failed.
 */
export type AttentionFacts = {
  lifecycleStatus: JobLifecycleStatus;
  risk: DeadlineRisk | null;
  hasRemedialAwaitingApproval: boolean;
  calendarSyncFailed: boolean;
  /**
   * An appointment was accepted after the deadline and recorded as such.
   *
   * It stays on the list until somebody deals with it: the tenant has booked,
   * so nothing is *blocked*, but a date the agent asked for is going to be
   * missed and that is not something to leave for them to discover.
   */
  hasDeadlineException: boolean;
};

export function needsAttention(facts: AttentionFacts): boolean {
  if (facts.lifecycleStatus === "cancelled") return false;
  if (facts.calendarSyncFailed) return true;
  if (facts.hasRemedialAwaitingApproval) return true;
  if (facts.hasDeadlineException) return true;
  if (facts.risk === "urgent" || facts.risk === "overdue") return true;
  return false;
}

/**
 * The deadline risk for a job, or null when it has no deadline.
 *
 * A job with no requested completion date has no risk — not "normal". Saying
 * "normal" would imply a deadline exists and is being met.
 */
export function jobDeadlineRisk(
  job: { completeByDate: string | null; lifecycleStatus: JobLifecycleStatus },
  today: string,
  windows?: DeadlineWindows,
): DeadlineRisk | null {
  if (!job.completeByDate) return null;
  // A finished job cannot be at risk of missing a deadline it already met or
  // missed; the exception is recorded on the job itself.
  if (job.lifecycleStatus === "completed" || job.lifecycleStatus === "cancelled") {
    return null;
  }
  return deadlineRisk(job.completeByDate, today, windows);
}
