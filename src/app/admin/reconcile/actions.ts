"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/session";
import { recordAudit } from "@/lib/audit/record";
import { runReconciliation, type ReconcileReport } from "@/lib/ops/reconcile";
import { retryFailedNotification } from "@/lib/notifications/outbox";
import { releaseStalledSubmission } from "@/lib/documents/certificate-drafts";

/**
 * Running the reconciliation sweep.
 *
 * A server action is a public HTTP endpoint with a generated name — the fact
 * that only an admin page renders the button protects nothing — so this starts
 * with `requireAdmin()` against a verified session, before it does anything.
 *
 * It is audited. The sweep writes to the operational record and to Google on
 * BSCJ's behalf, and "who ran it and what did it change" is exactly the kind of
 * question a security log exists to answer.
 */

export type ReconcileState = {
  report?: ReconcileReport;
  ranAt?: string;
  error?: string;
};

export async function runReconciliationAction(): Promise<ReconcileState> {
  const session = await requireAdmin();

  let report: ReconcileReport;
  try {
    report = await runReconciliation();
  } catch {
    return { error: "The sweep could not be completed. Please try again." };
  }

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "ops.reconciliation_run",
    // Counts only. No reference, no customer, no calendar id.
    detail: {
      calendarSynced: report.calendarSync.synced,
      calendarFailed: report.calendarSync.failed,
      calendarCleaned: report.calendarCleanup.cleaned,
      bookingsRecovered: report.bookingRecovery.recovered,
      alertsAccepted: report.notifications.accepted,
      alertsFailed: report.notifications.failed,
    },
  });

  revalidatePath("/admin/reconcile");
  return { report, ranAt: new Date().toISOString() };
}

export type RetryState = { message?: string; error?: string };

/**
 * Putting one failed message back in the queue.
 *
 * `requireAdmin()` first, because a server action is a public endpoint with a
 * generated name and the button that renders it protects nothing. The row is
 * named by id from the page, and everything that decides whether the retry is
 * allowed is re-read on the server — the screen is not evidence of the state.
 *
 * Attributable: `retryFailedNotification` records who did it and what the
 * message had failed with, before the reason is cleared.
 */
export async function retryNotificationAction(
  _previous: RetryState,
  form: FormData,
): Promise<RetryState> {
  const session = await requireAdmin();

  const id = String(form.get("id") ?? "");
  if (!id) return { error: "No message was named." };

  const result = await retryFailedNotification({
    id,
    actorUserId: session.user.id,
  });
  if (!result.ok) return { error: result.error };

  revalidatePath("/admin/reconcile");
  return { message: result.message };
}

/**
 * Releasing a certificate submission that claimed a job and never finished.
 *
 * A submission takes a claim on the job before it stores anything, so a
 * process that dies in between leaves a claim with no document under it. The
 * engineer's own retry recovers it once the lease expires — this is for when
 * that does not happen, because they have finished for the day and the office
 * is looking at a record nobody can send.
 *
 * **It is the safest action available**, and that is the point: it clears a
 * claim and nothing else. No document is deleted, no certificate is touched,
 * no renewal moves and nobody is emailed. If the dead attempt did store a PDF,
 * that PDF is already in the review list and is left exactly where it is.
 *
 * Audited, because it is an administrator intervening in somebody else's
 * unfinished work.
 */
export async function releaseSubmissionAction(
  _previous: RetryState,
  form: FormData,
): Promise<RetryState> {
  const session = await requireAdmin();

  const jobId = String(form.get("jobId") ?? "");
  if (!jobId) return { error: "No job was named." };

  const result = await releaseStalledSubmission({ session, jobId });
  if (!result.ok) return { error: result.error };

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "certificate.submission_released",
    subjectType: "job",
    subjectId: jobId,
    detail: {},
  });

  revalidatePath("/admin/reconcile");
  revalidatePath(`/admin/jobs/${jobId}`);
  revalidatePath(`/engineer/jobs/${jobId}`);
  return { message: result.message };
}
