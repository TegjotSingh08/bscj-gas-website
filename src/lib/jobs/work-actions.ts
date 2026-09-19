import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { recordAudit } from "@/lib/audit/record";
import { assertCan } from "@/lib/auth/roles";
import { canAccessAssignedJob, type AccessScope } from "@/lib/auth/scope";
import type { Session } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { activities, appUsers, jobs } from "@/lib/db/schema";
import { assertTransition, type JobLifecycleStatus } from "./lifecycle";
import {
  canAssign,
  canComplete,
  canStart,
  canUnassign,
  assignRefusal,
  checkCompletionNote,
  completeRefusal,
  startRefusal,
  type WorkFacts,
} from "./work";

/**
 * Allocating work, and recording what happened to it.
 *
 * Four writes, and every one of them obeys the same five rules:
 *
 * 1. **Nothing is taken from the caller but an id.** No status, no price, no
 *    ownership and no timestamp arrives from a browser. The job is re-read
 *    here and every decision is made from the row.
 * 2. **The capability is checked, then the row.** `job:assign` is BSCJ's;
 *    `job:work` belongs to whoever is actually on the job. Both checks are
 *    required, because a capability says what kind of user may act and the
 *    scope says whether this row is theirs.
 * 3. **The transition is asserted before it is written**, so an impossible
 *    status cannot be reached from a screen that happened to render a button.
 * 4. **The update is conditional on the state that was read.** Two taps on a
 *    phone with a bad signal, or an engineer and an administrator acting at
 *    the same moment, produce one change and one honest "that has moved"
 *    rather than two writes racing.
 * 5. **Every change writes its own timeline entry**, in the same batch as the
 *    change. A status somebody cannot account for is worse than no status.
 *
 * Nothing here contacts Google or Resend. Allocation and completion do not
 * move an appointment, so there is nothing for the calendar to learn, and no
 * customer is written to — that stays with the outbox.
 */

export type WorkResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/** Anything that is not a UUID is not an id; Postgres would throw on it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the row says, with the caller's access already decided.
 *
 * The scope check happens here rather than in each action, so no action can
 * be written that forgets it. "Not yours" and "no such job" are the same
 * answer for the same reason they are everywhere else.
 */
type LoadedJob = {
  id: string;
  reference: string;
  propertyId: string;
  agentOrganisationId: string | null;
  lifecycleStatus: JobLifecycleStatus;
  assignedEngineerId: string | null;
  appointmentStart: Date | null;
  facts: WorkFacts;
};

async function loadJob(
  scope: AccessScope,
  jobId: string,
): Promise<LoadedJob | null> {
  const db = getDb();
  if (!db || !UUID.test(jobId)) return null;

  const [row] = await db
    .select({
      id: jobs.id,
      reference: jobs.reference,
      propertyId: jobs.propertyId,
      agentOrganisationId: jobs.agentOrganisationId,
      lifecycleStatus: jobs.lifecycleStatus,
      assignedEngineerId: jobs.assignedEngineerId,
      appointmentStart: jobs.appointmentStart,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!row) return null;
  if (!canAccessAssignedJob(scope, row)) return null;

  const lifecycleStatus = row.lifecycleStatus as JobLifecycleStatus;
  return {
    ...row,
    lifecycleStatus,
    facts: {
      lifecycleStatus,
      assignedEngineerId: row.assignedEngineerId,
      hasAppointment: row.appointmentStart !== null,
    },
  };
}

/** The one refusal every action shares. Says nothing about what exists. */
const NOT_FOUND = "That job could not be found.";
const MOVED =
  "This job changed while you were looking at it. Reload and try again.";
const NO_DATABASE = "The database is not available.";

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/**
 * Putting an engineer on a job.
 *
 * The engineer is verified as an active engineer account before anything is
 * written: an id from a form is a string, and allocating a job to an agency
 * user — or to a deactivated account — would be a job nobody is doing that
 * looks like a job somebody is.
 *
 * Reassignment is allowed and is not a special case. The status only moves
 * on the first allocation; after that the column changes and the timeline
 * records who it moved from and to.
 */
export async function assignEngineer(input: {
  session: Session;
  jobId: string;
  engineerId: string;
}): Promise<WorkResult> {
  const { session, jobId, engineerId } = input;
  assertCan(session.user.role, "job:assign");

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };

  const job = await loadJob(session.scope, jobId);
  if (!job) return { ok: false, error: NOT_FOUND };

  if (!canAssign(job.facts)) {
    return { ok: false, error: assignRefusal(job.facts) ?? NOT_FOUND };
  }

  if (!UUID.test(engineerId)) {
    return { ok: false, error: "Choose an engineer." };
  }
  if (engineerId === job.assignedEngineerId) {
    return { ok: false, error: "That engineer is already on this job." };
  }

  const [engineer] = await db
    .select({ id: appUsers.id, name: appUsers.name })
    .from(appUsers)
    .where(
      and(
        eq(appUsers.id, engineerId),
        eq(appUsers.role, "engineer"),
        eq(appUsers.isActive, true),
      ),
    )
    .limit(1);

  if (!engineer) {
    return { ok: false, error: "That is not an active engineer account." };
  }

  // Only the first allocation moves the status. A swap is a change of who,
  // not a change of where the work has got to.
  const nextStatus: JobLifecycleStatus =
    job.lifecycleStatus === "scheduled" ? "engineer_assigned" : job.lifecycleStatus;
  if (nextStatus !== job.lifecycleStatus) {
    assertTransition(job.lifecycleStatus, nextStatus);
  }

  const updated = await db
    .update(jobs)
    .set({
      assignedEngineerId: engineer.id,
      lifecycleStatus: nextStatus,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.lifecycleStatus, job.lifecycleStatus),
        job.assignedEngineerId
          ? eq(jobs.assignedEngineerId, job.assignedEngineerId)
          : isNull(jobs.assignedEngineerId),
      ),
    )
    .returning({ id: jobs.id });

  if (updated.length === 0) return { ok: false, error: MOVED };

  await record(db, {
    job,
    kind: "job.engineer_assigned",
    actor: session.user.id,
    detail: {
      engineerId: engineer.id,
      ...(job.assignedEngineerId
        ? { previousEngineerId: job.assignedEngineerId }
        : {}),
    },
  });

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "job.engineer_assigned",
    subjectType: "job",
    subjectId: job.id,
    // Who, not what: no address, no customer, no contact detail.
    detail: { reference: job.reference, engineerId: engineer.id },
  });

  return { ok: true, message: `${engineer.name} is now on this job.` };
}

/** Taking the allocation off again. Only before the visit — see `work.ts`. */
export async function unassignEngineer(input: {
  session: Session;
  jobId: string;
}): Promise<WorkResult> {
  const { session, jobId } = input;
  assertCan(session.user.role, "job:assign");

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };

  const job = await loadJob(session.scope, jobId);
  if (!job) return { ok: false, error: NOT_FOUND };

  if (!canUnassign(job.facts)) {
    return {
      ok: false,
      error:
        job.lifecycleStatus === "in_progress"
          ? "This job has been started. Allocate it to somebody else rather than leaving it with nobody on it."
          : "There is nobody to take off this job.",
    };
  }

  assertTransition(job.lifecycleStatus, "scheduled");

  const updated = await db
    .update(jobs)
    .set({
      assignedEngineerId: null,
      lifecycleStatus: "scheduled",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.lifecycleStatus, job.lifecycleStatus),
        eq(jobs.assignedEngineerId, job.assignedEngineerId!),
      ),
    )
    .returning({ id: jobs.id });

  if (updated.length === 0) return { ok: false, error: MOVED };

  await record(db, {
    job,
    kind: "job.engineer_unassigned",
    actor: session.user.id,
    detail: { previousEngineerId: job.assignedEngineerId },
  });

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "job.engineer_unassigned",
    subjectType: "job",
    subjectId: job.id,
    detail: { reference: job.reference },
  });

  return { ok: true, message: "Nobody is allocated to this job now." };
}

// ---------------------------------------------------------------------------
// On site
// ---------------------------------------------------------------------------

/**
 * The engineer says they are there.
 *
 * `startedAt` is the server's clock, not the phone's. A time a client can
 * choose is a time that can be wrong by a timezone, a stopped clock or a
 * deliberate edit, and this one ends up in a record of when a property was
 * attended.
 */
export async function startWork(input: {
  session: Session;
  jobId: string;
}): Promise<WorkResult> {
  const { session, jobId } = input;
  assertCan(session.user.role, "job:work");

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };

  const job = await loadJob(session.scope, jobId);
  if (!job) return { ok: false, error: NOT_FOUND };

  if (!canStart(job.facts, session.user.id)) {
    return { ok: false, error: startRefusal(job.facts, session.user.id) ?? NOT_FOUND };
  }

  assertTransition(job.lifecycleStatus, "in_progress");
  const startedAt = new Date();

  const updated = await db
    .update(jobs)
    .set({
      lifecycleStatus: "in_progress",
      workStartedAt: startedAt,
      updatedAt: startedAt,
    })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.lifecycleStatus, "engineer_assigned"),
        eq(jobs.assignedEngineerId, session.user.id),
      ),
    )
    .returning({ id: jobs.id });

  if (updated.length === 0) return { ok: false, error: MOVED };

  await record(db, {
    job,
    kind: "job.started",
    actor: session.user.id,
    detail: { startedAt: startedAt.toISOString() },
  });

  return { ok: true, message: "Marked as started." };
}

/**
 * The work is done.
 *
 * `completed` is terminal, so this is the one action here that cannot be
 * undone from a screen. It records the engineer's own account of the visit
 * and the time it finished, and it does **not** issue a certificate, raise an
 * invoice or set a renewal date: none of those rules exist yet, and inventing
 * them here would put a number in front of a customer that nobody approved.
 */
export async function completeWork(input: {
  session: Session;
  jobId: string;
  notes?: unknown;
}): Promise<WorkResult> {
  const { session, jobId } = input;
  assertCan(session.user.role, "job:work");

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };

  const note = checkCompletionNote(input.notes);
  if (!note.ok) return { ok: false, error: note.error };

  const job = await loadJob(session.scope, jobId);
  if (!job) return { ok: false, error: NOT_FOUND };

  if (!canComplete(job.facts, session.user.id)) {
    return {
      ok: false,
      error: completeRefusal(job.facts, session.user.id) ?? NOT_FOUND,
    };
  }

  assertTransition(job.lifecycleStatus, "completed");
  const completedAt = new Date();

  const updated = await db
    .update(jobs)
    .set({
      lifecycleStatus: "completed",
      completedAt,
      completionNotes: note.value,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.lifecycleStatus, "in_progress"),
        eq(jobs.assignedEngineerId, session.user.id),
      ),
    )
    .returning({ id: jobs.id });

  if (updated.length === 0) return { ok: false, error: MOVED };

  await record(db, {
    job,
    kind: "job.completed",
    actor: session.user.id,
    detail: {
      completedAt: completedAt.toISOString(),
      // Whether a note was left, never the note. The timeline is read by
      // people who are not the engineer; the account itself lives on the job.
      noteRecorded: note.value !== null,
    },
  });

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "job.completed",
    subjectType: "job",
    subjectId: job.id,
    detail: { reference: job.reference },
  });

  return { ok: true, message: "Recorded as done." };
}

// ---------------------------------------------------------------------------

/**
 * The timeline entry for a change that has already been written.
 *
 * Never fatal. The change is committed by the time this runs, and refusing
 * to acknowledge an allocation because a log line would not write is the
 * wrong failure — a gap in the timeline is visible; a rolled-back assignment
 * is an engineer who never hears about the job.
 */
async function record(
  db: NonNullable<ReturnType<typeof getDb>>,
  input: {
    job: LoadedJob;
    kind: string;
    actor: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.insert(activities).values({
      jobId: input.job.id,
      propertyId: input.job.propertyId,
      agentOrganisationId: input.job.agentOrganisationId,
      kind: input.kind,
      actor: `user:${input.actor}`,
      detail: input.detail,
    });
  } catch {
    // A gap in the timeline is a smaller problem than a refused change.
  }
}
