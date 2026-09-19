/**
 * What an engineer is allowed to do to a job, and when.
 *
 * `lifecycle.ts` says which status changes are legal at all. This says which
 * of them are *offered*, to whom, and what has to be true first — which is a
 * different question, and keeping it separate is what stops the transition
 * table growing conditions that only make sense on one screen.
 *
 * Three rules shape everything below:
 *
 * 1. **Assignment is the permission.** An engineer who is not on a job has no
 *    more access to it than a stranger. The scope check enforces that; this
 *    module refuses to *offer* the action, so the two never disagree.
 * 2. **Work is not started before it is allocated.** A job nobody is on
 *    cannot be in progress, because "in progress" would name nobody.
 * 3. **Completion is a statement about a visit that happened.** A job that
 *    was never started cannot be completed from a phone in a van — which is
 *    why the status the engineer's buttons move through is a sequence rather
 *    than a pair of independent switches.
 *
 * Pure and dependency-free, so every rule is directly testable.
 */

import { canTransition, type JobLifecycleStatus } from "./lifecycle";

/** The actions the operations surfaces offer. Named for the act, not the button. */
export const WORK_ACTIONS = ["assign", "unassign", "start", "complete"] as const;
export type WorkAction = (typeof WORK_ACTIONS)[number];

/** Enough about a job to decide. Deliberately not the whole row. */
export type WorkFacts = {
  lifecycleStatus: JobLifecycleStatus;
  assignedEngineerId: string | null;
  /** A job with no time agreed cannot be turned up to. */
  hasAppointment: boolean;
};

/** Why an action is not available, in words a person can act on. */
export type WorkRefusal = {
  action: WorkAction;
  reason: string;
};

/**
 * The statuses a job can be allocated to an engineer from.
 *
 * Reassignment while the work is in progress is deliberately allowed: an
 * engineer being swapped mid-job is a real operational event, and making it
 * illegal only means somebody does it by editing the database.
 */
const ASSIGNABLE: readonly JobLifecycleStatus[] = [
  "scheduled",
  "engineer_assigned",
  "in_progress",
];

export function canAssign(facts: WorkFacts): boolean {
  if (!ASSIGNABLE.includes(facts.lifecycleStatus)) return false;
  // Allocating somebody to a job with no agreed time is allocating them to
  // nothing. The appointment comes first.
  return facts.hasAppointment;
}

export function assignRefusal(facts: WorkFacts): string | null {
  if (canAssign(facts)) return null;
  if (!facts.hasAppointment) {
    return "This job has no appointment yet, so there is nothing to send an engineer to.";
  }
  if (facts.lifecycleStatus === "completed") return "This job is finished.";
  if (facts.lifecycleStatus === "cancelled") return "This job was cancelled.";
  if (facts.lifecycleStatus === "remedial_required") {
    return "This job has been attended and is waiting on a remedial, so there is nothing to allocate.";
  }
  return "A tenant has not chosen a time yet, so there is nothing to allocate.";
}

/**
 * Whether the allocation can be taken off again.
 *
 * Only before the visit. Once an engineer is on site, removing them would
 * leave a job in progress with nobody on it — the job is reassigned instead,
 * which keeps somebody named on it throughout.
 */
export function canUnassign(facts: WorkFacts): boolean {
  return (
    facts.assignedEngineerId !== null &&
    facts.lifecycleStatus === "engineer_assigned" &&
    canTransition("engineer_assigned", "scheduled")
  );
}

/**
 * Whether this engineer may say they are on site.
 *
 * `actorId` is checked against the allocation rather than assumed from the
 * screen the request came from: an administrator working the engineer views
 * passes their own id, and gets the same answer anyone else would.
 */
export function canStart(facts: WorkFacts, actorId: string): boolean {
  if (facts.lifecycleStatus !== "engineer_assigned") return false;
  if (facts.assignedEngineerId !== actorId) return false;
  return canTransition("engineer_assigned", "in_progress");
}

export function startRefusal(facts: WorkFacts, actorId: string): string | null {
  if (canStart(facts, actorId)) return null;
  if (facts.lifecycleStatus === "in_progress") return "Already started.";
  if (facts.lifecycleStatus === "completed") return "This job is finished.";
  if (facts.lifecycleStatus === "cancelled") return "This job was cancelled.";
  if (facts.assignedEngineerId === null) {
    return "Nobody is allocated to this job yet.";
  }
  if (facts.assignedEngineerId !== actorId) {
    return "This job is allocated to somebody else.";
  }
  return "This job is not ready to be started.";
}

/** Whether this engineer may record the work as done. */
export function canComplete(facts: WorkFacts, actorId: string): boolean {
  if (facts.lifecycleStatus !== "in_progress") return false;
  if (facts.assignedEngineerId !== actorId) return false;
  return canTransition("in_progress", "completed");
}

export function completeRefusal(facts: WorkFacts, actorId: string): string | null {
  if (canComplete(facts, actorId)) return null;
  if (facts.lifecycleStatus === "completed") return "Already recorded as done.";
  if (facts.lifecycleStatus === "cancelled") return "This job was cancelled.";
  if (facts.lifecycleStatus !== "in_progress") {
    return "Start the job before recording it as done.";
  }
  return "This job is allocated to somebody else.";
}

/**
 * How long the engineer's note may be.
 *
 * Generous — an account of a visit is not a tweet — and capped all the same,
 * because a free-text column with no limit is a column somebody eventually
 * pastes a log file into.
 */
export const MAX_COMPLETION_NOTE = 2000;

export type NoteResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * The completion note, checked.
 *
 * Empty is allowed and stored as null: a visit where there was nothing to say
 * is an ordinary outcome, and forcing a sentence out of somebody produces
 * "n/a" rather than information. Too long is refused rather than truncated —
 * silently cutting an engineer's account in half is worse than asking them to
 * shorten it.
 */
export function checkCompletionNote(raw: unknown): NoteResult {
  if (typeof raw !== "string") return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > MAX_COMPLETION_NOTE) {
    return {
      ok: false,
      error: `That note is ${trimmed.length} characters. Please keep it under ${MAX_COMPLETION_NOTE}.`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * What the engineer's screen should offer, in one call.
 *
 * The screen renders this rather than making the decisions itself, so a
 * button that is shown and an action that is permitted cannot drift apart.
 */
export function availableActions(
  facts: WorkFacts,
  actorId: string,
): readonly WorkAction[] {
  const available: WorkAction[] = [];
  if (canStart(facts, actorId)) available.push("start");
  if (canComplete(facts, actorId)) available.push("complete");
  return available;
}
