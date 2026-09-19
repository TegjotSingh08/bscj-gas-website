/**
 * Why a job needs somebody.
 *
 * `derived.ts` answers whether a job needs attention at all. That is the
 * right shape for a badge and the wrong shape for a queue: "14 jobs need
 * attention" tells nobody what to do next. This turns the same facts into
 * named reasons, each of which has an obvious action behind it.
 *
 * **Every reason is a real recorded signal.** Nothing here is a heuristic, a
 * guess at intent, or a threshold somebody invented — each one corresponds to
 * a column that a failed external call, a tenant's acknowledgement or a date
 * actually wrote. A queue that reports things nobody can verify is a queue
 * that gets ignored, and an ignored queue is worse than none.
 *
 * The two functions must always agree: a job with reasons needs attention,
 * and a job that needs attention has at least one reason. That is asserted
 * rather than assumed.
 *
 * Pure and dependency-free.
 */

import type { DeadlineRisk } from "@/lib/compliance/renewal";
import { needsAttention, type AttentionFacts } from "./derived";
import type { JobLifecycleStatus } from "./lifecycle";

export const ATTENTION_REASONS = [
  /** The appointment exists here and Google has not been told. */
  "calendar_not_written",
  /** A time changed and the entry it replaced is still in the diary. */
  "calendar_left_behind",
  /** A message was attempted to exhaustion and given up on. */
  "message_failed",
  /** A tenant accepted a time after the date the customer asked for. */
  "deadline_exception",
  /** The requested completion date has passed. */
  "deadline_overdue",
  /** The requested completion date is close. */
  "deadline_urgent",
  /** A remedial is waiting on somebody's approval. */
  "remedial_awaiting_approval",
] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/**
 * Everything a reason can be derived from.
 *
 * A superset of `AttentionFacts`, because two of the reasons are about
 * external state that the boolean deliberately folds together.
 */
export type AttentionInput = {
  lifecycleStatus: JobLifecycleStatus;
  /** `pending` or `failed` — either way, Google does not hold it. */
  calendarSyncPending: boolean;
  /** A superseded event id is still on the row. */
  calendarCleanupOutstanding: boolean;
  /** At least one `failed` row in the outbox for this job. */
  messageFailed: boolean;
  hasDeadlineException: boolean;
  risk: DeadlineRisk | null;
  hasRemedialAwaitingApproval: boolean;
};

/**
 * The facts the boolean takes, from the fuller input.
 *
 * One place, so the two can never be built from different readings of the
 * same row.
 */
export function toAttentionFacts(input: AttentionInput): AttentionFacts {
  return {
    lifecycleStatus: input.lifecycleStatus,
    risk: input.risk,
    hasRemedialAwaitingApproval: input.hasRemedialAwaitingApproval,
    /*
      Both kinds of calendar trouble are "the diary and the database
      disagree", which is the one thing the boolean is for. They are separate
      reasons below because they need different actions.
    */
    calendarSyncFailed:
      input.calendarSyncPending ||
      input.calendarCleanupOutstanding ||
      input.messageFailed,
    hasDeadlineException: input.hasDeadlineException,
  };
}

/**
 * Every reason, most urgent first.
 *
 * Ordered by what goes wrong if it is left: a customer turning up to a
 * property nobody knows about outranks a note in a diary.
 */
export function attentionReasons(
  input: AttentionInput,
): readonly AttentionReason[] {
  // A cancelled job needs nothing. Its outstanding messages are stood down by
  // the outbox and its calendar entry by the reconciliation sweep.
  if (input.lifecycleStatus === "cancelled") return [];

  const reasons: AttentionReason[] = [];
  if (input.calendarSyncPending) reasons.push("calendar_not_written");
  if (input.risk === "overdue") reasons.push("deadline_overdue");
  if (input.messageFailed) reasons.push("message_failed");
  if (input.hasRemedialAwaitingApproval) {
    reasons.push("remedial_awaiting_approval");
  }
  if (input.hasDeadlineException) reasons.push("deadline_exception");
  if (input.risk === "urgent") reasons.push("deadline_urgent");
  if (input.calendarCleanupOutstanding) reasons.push("calendar_left_behind");
  return reasons;
}

/** The boolean and the reasons, guaranteed to agree. */
export function attentionFor(input: AttentionInput): {
  needed: boolean;
  reasons: readonly AttentionReason[];
} {
  const reasons = attentionReasons(input);
  return { needed: needsAttention(toAttentionFacts(input)), reasons };
}

/**
 * What each reason says on screen.
 *
 * Plain, specific and free of blame. "Not yet in the calendar" is something
 * somebody can act on; "sync error" is something somebody escalates.
 */
export const ATTENTION_LABELS: Readonly<Record<AttentionReason, string>> = {
  calendar_not_written: "Not yet in the calendar",
  calendar_left_behind: "Old calendar entry to remove",
  message_failed: "A message could not be sent",
  deadline_exception: "Booked after the requested date",
  deadline_overdue: "Past the requested date",
  deadline_urgent: "Requested date is close",
  remedial_awaiting_approval: "Remedial waiting for approval",
};

/** A one-line explanation of what to do, for the queue on the dashboard. */
export const ATTENTION_NOTES: Readonly<Record<AttentionReason, string>> = {
  calendar_not_written:
    "The slot is still reserved, so nobody else is offered it, but it will not appear in the diary until the sweep runs.",
  calendar_left_behind:
    "A phantom entry is sitting in the diary. The sweep removes it.",
  message_failed:
    "Attempted to exhaustion and given up on. It needs a person, not another retry.",
  deadline_exception:
    "The tenant acknowledged it and booked anyway. The agency has been told; somebody should decide whether that stands.",
  deadline_overdue: "The date the customer asked for has passed.",
  deadline_urgent: "The date the customer asked for is within the week.",
  remedial_awaiting_approval:
    "Work was found that is beyond the standing authority. Nothing proceeds until it is approved or declined.",
};
