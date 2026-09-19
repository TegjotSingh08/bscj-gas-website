"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/session";
import { recordAudit } from "@/lib/audit/record";
import { runReconciliation, type ReconcileReport } from "@/lib/ops/reconcile";

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
