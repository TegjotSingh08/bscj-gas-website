import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { confirmTenantAppointment, syncJobToCalendar } from "@/lib/scheduling/confirm";
import { readSchedulingSession, SCHEDULING_COOKIE } from "@/lib/scheduling/session";
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
 * **The job comes from the signed session, never from the body.** The tenant
 * sends a slot and a hold token and nothing else; there is no field here for a
 * job id, an organisation, a price or a status, so none can be forged.
 *
 * Authorisation is enforced here independently of any page: this route is
 * reachable directly and refuses a caller with no valid session, whatever the
 * UI happens to render.
 *
 * The calendar write runs **after** the appointment is committed and cannot
 * fail it — see `confirm.ts`. A failure leaves `calendar_sync_state = failed`
 * for the retry sweep rather than telling a tenant their booking did not work
 * when it did.
 */
export async function POST(request: Request) {
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

  const result = await confirmTenantAppointment({
    jobId: session.jobId,
    slotStart,
    holdToken,
  });

  if (result.status === "confirmed" || result.status === "already") {
    /*
      Best effort, and after the commit. `syncJobToCalendar` is idempotent —
      the event id is derived from the job and the slot — so a retry collides
      with the event it already wrote rather than creating a second.
    */
    try {
      await syncJobToCalendar(session.jobId);
    } catch {
      // The job is committed and the state says `pending` or `failed`. The
      // tenant is not told, because it is not their problem.
    }

    return NextResponse.json({
      ok: true,
      start: result.start.toISOString(),
      end: result.end.toISOString(),
    });
  }

  const messages: Record<string, string> = {
    hold_expired:
      "Your reservation expired. Please choose an appointment again.",
    slot_taken:
      "Sorry — that time has just been taken. Please choose another.",
    day_full: "That day is now full. Please choose another date.",
    not_schedulable:
      "This appointment can no longer be changed here. Please call us.",
    not_found: "We could not find that appointment.",
    unavailable: "We could not confirm that appointment. Please try again.",
  };

  return NextResponse.json(
    { ok: false, error: result.status, message: messages[result.status] },
    { status: result.status === "not_found" ? 404 : 409 },
  );
}
