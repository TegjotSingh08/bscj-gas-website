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
 * 1. **A scheduler**, with `Authorization: Bearer $CRON_SECRET`, over **GET**.
 *    Off entirely unless that secret is set — see `lib/ops/cron-auth.ts`.
 * 2. **An administrator**, over **POST**, from a same-origin request, so the
 *    manual retry keeps working and a person is never locked out of the queue
 *    because a schedule is misconfigured.
 *
 * **Why GET as well as POST, when this mutates.**
 *
 * Vercel Cron invokes a job with an HTTP **GET** against the project's
 * production deployment URL. This route was POST-only, so every scheduled run
 * would have answered `405` and the queue would never have drained — silently,
 * because nothing in the application would report it. Everything would sit
 * `pending`: no invitation, no password reset, no tenant link, no certificate,
 * no invoice.
 *
 * The original objection to GET was sound and still is: *a GET that mutates
 * gets followed by every prefetcher and link checker that ever sees the URL.*
 * It is answered by the credential rather than by the method. **GET requires
 * the bearer token and has no session fallback**, so a prefetcher, a crawler
 * or a curious browser gets `401` and changes nothing. Only something holding
 * the secret can drain, and a secret is not something a link checker has.
 *
 * The administrator path stays on POST, where a browser is involved and the
 * method genuinely is the safer default.
 *
 * **The `vercel-cron/1.0` user agent and the `x-vercel-cron-schedule` header
 * are deliberately not used as authentication.** Both are request headers and
 * anyone can send them; the secret is the only thing that proves anything.
 *
 * The response is **counts only**. No reference, no address, and above all no
 * token: an invitation's link exists in the message body and nowhere else.
 */

/** Never cached, and never presented as a page. */
async function drain(trigger: "schedule" | "admin"): Promise<NextResponse> {
  try {
    const report = await drainOutbox();
    return NextResponse.json({ ok: true, trigger, report });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}

const unauthenticated = () =>
  NextResponse.json({ error: "unauthenticated" }, { status: 401 });

/**
 * The scheduler's door.
 *
 * Bearer token only. There is deliberately **no** same-origin or session
 * fallback here — that would reintroduce exactly the mutating-GET problem the
 * token exists to close.
 */
export async function GET(request: Request) {
  if (!checkCronSecret(request).ok) return unauthenticated();
  return drain("schedule");
}

/**
 * The administrator's door, and the scheduler's if it prefers POST.
 *
 * An external scheduler — anything not Vercel Cron — can use either method,
 * since the bearer check runs first on both.
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
    if (!checkSameOrigin(request).ok) return unauthenticated();
    try {
      await requireAdminOrThrow();
    } catch {
      return unauthenticated();
    }
  }

  return drain(scheduled ? "schedule" : "admin");
}
