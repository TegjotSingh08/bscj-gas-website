import { NextResponse } from "next/server";

import { requireAdminOrThrow } from "@/lib/auth/session";
import { checkCronSecret } from "@/lib/ops/cron-auth";
import { checkSameOrigin } from "@/lib/scheduling/origin";
import { drainOutbox } from "@/lib/notifications/outbox";

export const dynamic = "force-dynamic";

/**
 * One bounded pass over the email outbox.
 *
 * Two ways in, and no third:
 *
 * 1. **A scheduler**, with `Authorization: Bearer $CRON_SECRET`. Off entirely
 *    unless that secret is set — see `lib/ops/cron-auth.ts`.
 * 2. **An administrator**, from a same-origin request, so the manual retry on
 *    `/admin/reconcile` keeps working and a person is never locked out of the
 *    queue because a schedule is misconfigured.
 *
 * POST, because it sends things. A GET that mutated would be followed by every
 * prefetcher and link checker that ever saw the URL.
 *
 * The response is **counts only**. No reference, no address, and above all no
 * token: an invitation's link exists in the message body and nowhere else.
 */
export async function POST(request: Request) {
  const scheduled = checkCronSecret(request).ok;

  if (!scheduled) {
    /*
      The human path. Origin is checked first for the same reason the tenant
      endpoint checks it: `SameSite=Lax` does the same work, but a protection
      that exists only as a library's cookie default disappears silently the
      day that default changes.

      A scheduler is exempt because it is not a browser and carries no cookie —
      its credential is the bearer token, which a cross-site page cannot read.
    */
    if (!checkSameOrigin(request).ok) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    try {
      await requireAdminOrThrow();
    } catch {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
  }

  try {
    const report = await drainOutbox();
    return NextResponse.json({ ok: true, trigger: scheduled ? "schedule" : "admin", report });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
