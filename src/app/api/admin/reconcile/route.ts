import { NextResponse } from "next/server";

import { requireAdminOrThrow } from "@/lib/auth/session";
import { recordAudit } from "@/lib/audit/record";
import { checkSameOrigin } from "@/lib/scheduling/origin";
import { runReconciliation } from "@/lib/ops/reconcile";

export const dynamic = "force-dynamic";

/**
 * The reconciliation sweep, without a browser.
 *
 * The same bounded engine the admin page runs, reachable for a scheduled
 * caller. **Authenticated as an administrator**, not by a shared secret in a
 * header: there is one identity model in this application and adding a second
 * one for a convenience endpoint is how an unauthenticated write path gets
 * created by accident.
 *
 * POST, because it changes things. A GET that mutated would be followed by
 * every prefetcher and link checker that ever saw the URL.
 */
export async function POST(request: Request) {
  /*
    The same explicit same-origin check the tenant endpoint carries, for the
    same reason. Auth.js sets `SameSite=Lax`, so a cross-site POST would not
    carry the session anyway — but a protection that exists only as a cookie
    attribute set by a library disappears silently the day that default
    changes, and nothing in this handler would look any different.

    A Server Action gets an equivalent check from Next itself; the admin page's
    button is one. A Route Handler gets nothing by default.
  */
  if (!checkSameOrigin(request).ok) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let session;
  try {
    session = await requireAdminOrThrow();
  } catch {
    // Middleware already refuses a caller with no session cookie; this refuses
    // one whose verified session is not an administrator, and says no more.
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  try {
    const report = await runReconciliation();

    await recordAudit({
      actorUserId: session.user.id,
      actorDescription: session.user.email,
      kind: "ops.reconciliation_run",
      detail: {
        calendarSynced: report.calendarSync.synced,
        calendarFailed: report.calendarSync.failed,
        calendarCleaned: report.calendarCleanup.cleaned,
        bookingsRecovered: report.bookingRecovery.recovered,
      },
    });

    // Counts only. A reference or an idempotency key in a response body is a
    // reference or an idempotency key in somebody's log.
    return NextResponse.json({ ok: true, report });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
