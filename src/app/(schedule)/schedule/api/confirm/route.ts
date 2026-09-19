import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import {
  confirmTenantAppointment,
  reconcileJobCalendar,
} from "@/lib/scheduling/confirm";
import {
  readSchedulingSession,
  SCHEDULING_COOKIE,
} from "@/lib/scheduling/session";
import { checkSameOrigin } from "@/lib/scheduling/origin";
import {
  clientKey,
  pruneRateLimits,
  rateLimit,
  rateLimits,
} from "@/lib/booking/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Confirming a tenant's appointment.
 *
 * **It lives under `/schedule` for one reason: that is where the cookie is.**
 * The session is path-scoped to `/schedule`, and this endpoint used to sit at
 * `/api/schedule/confirm`, which does not match that path — so the browser
 * never attached the cookie and the handler answered 401 to every genuine
 * tenant while the domain function underneath it worked perfectly. The path is
 * containment, not authorisation: everything below still runs.
 *
 * **The job comes from the signed session, never from the body.** The tenant
 * sends a slot and a hold token and nothing else; there is no field here for a
 * job id, an organisation, a price or a status, so none can be forged.
 *
 * Authorisation is enforced here independently of any page: this route is
 * reachable directly and refuses a caller with no valid session, whatever the
 * UI happens to render. Origin is checked explicitly rather than left to
 * `SameSite=Lax` alone — the attribute does the same work, but a protection
 * that exists only as a cookie flag disappears silently when the flag changes.
 *
 * The calendar write runs **after** the appointment is committed and cannot
 * fail it. A failure leaves `calendar_sync_state = failed` and, on a move, the
 * superseded event id on the row — both on the reconciliation queue, and both
 * keeping the slot reserved meanwhile — rather than telling a tenant their
 * booking did not work when it did.
 */
export async function POST(request: Request) {
  if (!checkSameOrigin(request).ok) {
    // Same shape as an unauthenticated reply. A probe learns nothing about
    // which check it failed.
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const store = await cookies();
  const session = readSchedulingSession(store.get(SCHEDULING_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  pruneRateLimits();
  const limited = await rateLimit(
    `schedule-confirm:${clientKey(request)}`,
    rateLimits.booking.limit,
    rateLimits.booking.windowSeconds,
  );
  if (!limited.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(limited.retryAfterSeconds) },
      },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const body = payload as { slotStart?: unknown; holdToken?: unknown };
  const slotStart = typeof body.slotStart === "string" ? body.slotStart : "";
  const holdToken = typeof body.holdToken === "string" ? body.holdToken : "";

  if (!slotStart) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  /*
    Nothing the domain can raise is allowed to become a 500. A lifecycle rule,
    a driver error or an unreachable calendar are all answers to a tenant's
    request, and an unhandled throw here is how rescheduling used to report
    itself as a server fault with no message at all.
  */
  let result: Awaited<ReturnType<typeof confirmTenantAppointment>>;
  try {
    result = await confirmTenantAppointment({
      jobId: session.jobId,
      slotStart,
      holdToken,
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "unavailable",
        message: MESSAGES.unavailable,
      },
      { status: 503 },
    );
  }

  if (result.status === "confirmed" || result.status === "already") {
    /*
      Best effort, and after the commit: write the new event, then remove the
      one it replaced. Both are idempotent and both leave durable state behind
      when they fail, so the reconciliation sweep can finish what this could
      not. The tenant is not told, because it is not their problem.
    */
    try {
      await reconcileJobCalendar(session.jobId);
    } catch {
      // `reconcileJobCalendar` does not throw; this is belt and braces.
    }

    return NextResponse.json({
      ok: true,
      start: result.start.toISOString(),
      end: result.end.toISOString(),
    });
  }

  return NextResponse.json(
    { ok: false, error: result.status, message: MESSAGES[result.status] },
    { status: statusCodeFor(result.status) },
  );
}

const MESSAGES: Record<string, string> = {
  hold_expired: "Your reservation expired. Please choose an appointment again.",
  slot_taken: "Sorry — that time has just been taken. Please choose another.",
  day_full: "That day is now full. Please choose another date.",
  not_schedulable:
    "This appointment can no longer be changed here. Please call us.",
  not_found: "We could not find that appointment.",
  /*
    Deliberately different words from `slot_taken`. The slot may be perfectly
    free — what changed is the job — and telling the tenant to pick another
    time would send them round a loop that cannot succeed.
  */
  conflict:
    "This appointment was changed somewhere else. Please reload the page to see the latest time.",
  unavailable: "We could not confirm that appointment. Please try again.",
};

function statusCodeFor(status: string): number {
  if (status === "not_found") return 404;
  if (status === "unavailable") return 503;
  // Everything else is a conflict with the world as it now is: the slot, the
  // day, the hold, or the job itself.
  return 409;
}
