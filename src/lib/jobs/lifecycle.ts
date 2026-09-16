/**
 * Where the work has got to, and what may happen to it next.
 *
 * Deliberately one small thing. A job also has money state (the invoice), a
 * document state (whether a certificate exists and has been sent) and a
 * deadline exception flag — and none of those belong here. Folding them into
 * one enum produces states that cannot be reasoned about: a job that is both
 * `certificate_issued` and `invoiced` has to pick one, and picking loses
 * information. They are separate precisely so no combination is impossible to
 * express — see `derived.ts`.
 *
 * Pure and dependency-free, so every rule below is directly testable.
 */

export const JOB_LIFECYCLE_STATUSES = [
  /** Being put together. Not yet submitted, and nobody has been contacted. */
  "draft",
  /** Submitted. The tenant is being invited but has not been reached yet. */
  "tenant_outreach",
  /** The tenant has the link and it is with them. Holds no slot. */
  "awaiting_tenant",
  /** An appointment exists, in the diary and in the calendar. */
  "scheduled",
  /** An engineer has been allocated to it. */
  "engineer_assigned",
  /** The engineer is on site. */
  "in_progress",
  /** Something was found that needs putting right before this can close. */
  "remedial_required",
  /** The engineer has attended and the work is done. Terminal. */
  "completed",
  /** Called off before completion. Terminal, and not a kind of completion. */
  "cancelled",
] as const;

export type JobLifecycleStatus = (typeof JOB_LIFECYCLE_STATUSES)[number];

/**
 * The only moves allowed.
 *
 * Four rules shape this table:
 *
 * 1. **`completed` and `cancelled` are terminal**, and cancellation is an
 *    *alternative* ending rather than something that follows completion: work
 *    that has been carried out cannot become work that never happened. A job
 *    that needs undoing after completion is a credit note and a conversation.
 * 2. **Going back is allowed where the operational event is real.** A tenant
 *    cancels and has to pick again (`scheduled → awaiting_tenant`); an
 *    engineer is unassigned (`engineer_assigned → scheduled`). Making these
 *    illegal only pushes them into a delete-and-recreate, which loses history.
 * 3. **`remedial_required` is not an ending.** It is a job that has been
 *    attended and cannot yet close, so it can be completed once the remedial
 *    is resolved, or return to scheduling if a second visit is needed.
 * 4. **Everything unfinished can be cancelled.** A job that cannot be
 *    cancelled is a job someone works around.
 */
const TRANSITIONS: Readonly<
  Record<JobLifecycleStatus, readonly JobLifecycleStatus[]>
> = {
  draft: ["tenant_outreach", "awaiting_tenant", "scheduled", "cancelled"],
  tenant_outreach: ["awaiting_tenant", "scheduled", "cancelled"],
  awaiting_tenant: ["tenant_outreach", "scheduled", "cancelled"],
  scheduled: ["engineer_assigned", "awaiting_tenant", "in_progress", "cancelled"],
  engineer_assigned: ["in_progress", "scheduled", "awaiting_tenant", "cancelled"],
  in_progress: ["remedial_required", "completed", "cancelled"],
  remedial_required: ["completed", "scheduled", "cancelled"],
  completed: [],
  cancelled: [],
};

/** The statuses a job can never leave. */
export const TERMINAL_STATUSES: readonly JobLifecycleStatus[] = [
  "completed",
  "cancelled",
];

/**
 * Statuses in which the job has no appointment.
 *
 * Used to decide whether a calendar event is required at all, rather than
 * inferring it from a null timestamp.
 */
export const UNSCHEDULED_STATUSES: readonly JobLifecycleStatus[] = [
  "draft",
  "tenant_outreach",
  "awaiting_tenant",
];

export function isJobLifecycleStatus(
  value: unknown,
): value is JobLifecycleStatus {
  return (
    typeof value === "string" &&
    (JOB_LIFECYCLE_STATUSES as readonly string[]).includes(value)
  );
}

export function isTerminal(status: JobLifecycleStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Whether a job in this status is expected to hold an appointment. */
export function expectsAppointment(status: JobLifecycleStatus): boolean {
  return !UNSCHEDULED_STATUSES.includes(status) && status !== "cancelled";
}

/** What this job could become next. Empty once it is finished either way. */
export function allowedTransitions(
  from: JobLifecycleStatus,
): readonly JobLifecycleStatus[] {
  return TRANSITIONS[from];
}

/**
 * Whether a move is legal.
 *
 * A status is never a legal move to itself: re-applying a status is a no-op
 * the caller should not have asked for, and treating it as valid hides
 * double-submissions that ought to be recognised as such.
 */
export function canTransition(
  from: JobLifecycleStatus,
  to: JobLifecycleStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidJobTransitionError extends Error {
  readonly from: JobLifecycleStatus;
  readonly to: JobLifecycleStatus;

  constructor(from: JobLifecycleStatus, to: JobLifecycleStatus) {
    super(`A job cannot move from ${from} to ${to}.`);
    this.name = "InvalidJobTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Asserts a move before it is written.
 *
 * Every status change goes through here rather than assigning the column
 * directly, so an impossible transition fails loudly at the point it is
 * attempted instead of quietly becoming a row nobody can explain.
 */
export function assertTransition(
  from: JobLifecycleStatus,
  to: JobLifecycleStatus,
): void {
  if (!canTransition(from, to)) {
    throw new InvalidJobTransitionError(from, to);
  }
}

/**
 * The status a newly created job starts in.
 *
 * A job whose tenant will choose the time holds no appointment and no slot;
 * anything else is booked the moment it is created. A job that is still being
 * assembled is a draft, and a draft has contacted nobody.
 */
export function initialStatus(input: {
  tenantWillSchedule: boolean;
  isDraft?: boolean;
}): JobLifecycleStatus {
  if (input.isDraft) return "draft";
  return input.tenantWillSchedule ? "tenant_outreach" : "scheduled";
}
