import { NextResponse } from "next/server";

import { accessByToken } from "@/lib/scheduling/access";
import {
  SCHEDULING_PREFILL_COOKIE,
  issueSchedulingPrefill,
  schedulingPrefillCookieOptions,
} from "@/lib/scheduling/session";

export const dynamic = "force-dynamic";

/**
 * The invitation link.
 *
 * **A link is not a key.** It used to be: opening one issued a scheduling
 * session and dropped the tenant straight onto their appointment. That made
 * the URL itself sufficient to see an address, a reference and a booked time —
 * and links get forwarded, screenshotted, left in shared inboxes and pasted
 * into chats. One of those is all it took.
 *
 * So the token now proves only that the holder was sent *something*, and what
 * it buys them is a form with the reference already filled in. The postcode of
 * the property is still required, and `accessByReference` still decides —
 * generically, and rate limited per caller and per reference.
 *
 * A token that is unknown, expired, revoked or attached to a job that is no
 * longer schedulable all end in exactly the same place as one that was never
 * issued: the entry page, with the same words. Telling them apart would be an
 * oracle.
 *
 * A Route Handler rather than a page because it writes a cookie, which Next
 * refuses during an ordinary render.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const job = await accessByToken(token);

  // Relative destinations, resolved against this request. The token is never
  // reflected into either of them.
  if (!job) {
    return NextResponse.redirect(new URL("/schedule?problem=1", request.url));
  }

  /*
    The reference travels in a signed cookie rather than a query string. It is
    not a secret — it is designed to be read aloud — but a URL ends up in
    history, in a referrer and in somebody's logs, and there is no reason to
    put it there when a cookie does the same job and expires.
  */
  const prefill = issueSchedulingPrefill(job.reference);
  const response = NextResponse.redirect(new URL("/schedule", request.url));
  response.cookies.set(
    SCHEDULING_PREFILL_COOKIE,
    prefill.value,
    schedulingPrefillCookieOptions(prefill.expiresAt),
  );
  return response;
}
