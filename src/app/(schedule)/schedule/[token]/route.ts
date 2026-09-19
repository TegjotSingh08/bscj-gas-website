import { NextResponse } from "next/server";

import { accessByToken } from "@/lib/scheduling/access";
import {
  SCHEDULING_COOKIE,
  issueSchedulingSession,
  schedulingCookieOptions,
} from "@/lib/scheduling/session";

export const dynamic = "force-dynamic";

/**
 * The invitation link.
 *
 * Spends the token at the door and replaces it with a signed, path-scoped
 * session naming that one job, then redirects. Two things follow from that:
 * the token stops travelling in the address bar after the first hop, and every
 * later request is authorised by something the tenant cannot forge or edit.
 *
 * A token that is unknown, expired, revoked or attached to a job that is no
 * longer schedulable all end in exactly the same place — the manual entry
 * page — because telling them apart would be an oracle.
 *
 * **A Route Handler rather than a page, because this writes a cookie.** It was
 * a Server Component, and `cookies().set()` is refused during an ordinary
 * render: Next seals the cookie store outside a Server Action or a Route
 * Handler, so the only thing the old page could do with a valid invitation was
 * throw. Rendering nothing is not a loss here — the page existed solely to
 * redirect, and a handler redirects with a `Set-Cookie` attached in one hop.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const job = await accessByToken(token);

  // Relative destinations, resolved against this request by NextResponse. The
  // token is never reflected into either of them.
  if (!job) return NextResponse.redirect(new URL("/schedule?problem=1", request.url));

  const session = issueSchedulingSession(job.jobId);
  const response = NextResponse.redirect(
    new URL("/schedule/appointment", request.url),
  );
  response.cookies.set(
    SCHEDULING_COOKIE,
    session.value,
    schedulingCookieOptions(session.expiresAt),
  );
  return response;
}
