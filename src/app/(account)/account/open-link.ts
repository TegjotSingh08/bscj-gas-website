import "server-only";

import { NextResponse } from "next/server";

import { peekCredential } from "@/lib/auth/credentials";
import type { CredentialPurpose } from "@/lib/auth/credential-token";
import {
  accountCookieOptions,
  encodeAccountCookie,
} from "@/lib/auth/account-cookie";
import {
  ACCOUNT_COOKIE,
  PROBLEM_PATH,
  SET_PASSWORD_PATH,
} from "@/lib/auth/account-paths";
import { clientKey, rateLimit, rateLimits } from "@/lib/booking/rate-limit";

/**
 * Opening an invitation or a reset link.
 *
 * Two rules, and they pull in opposite directions until you see why both hold:
 *
 * - **Opening the link spends nothing.** Mail clients prefetch. Security
 *   appliances follow links to scan them. Browsers speculatively fetch what
 *   they think you are about to click. A credential consumed by *opening* is a
 *   credential that is reliably dead before its owner ever sees the form, and
 *   that failure is invisible in testing and constant in the field. The
 *   credential is spent by the submission that actually sets a password, in
 *   one atomic statement — see `redeemCredential`.
 *
 * - **The token does not survive into a rendered page.** It arrives once, in
 *   this handler's path, and leaves in an httpOnly cookie scoped to
 *   `/account`. What renders next is a clean URL. So the token is never in
 *   browser history, never in a `Referer`, never in a screenshot of the
 *   address bar and never in a log of request paths.
 *
 * **Every failure lands in the same place with the same words.** Unknown,
 * expired, already redeemed, revoked, wrong purpose, suspended account,
 * suspended agency, no database — all of them are `/account/link-problem`.
 * Telling them apart would turn the link into an oracle: "expired" confirms
 * the address has an account, and "already used" confirms somebody set a
 * password.
 *
 * Rate limited per caller, because this is an unauthenticated endpoint that
 * does a database lookup and a keyed hash on anything it is handed.
 */
export async function openCredentialLink(
  request: Request,
  token: string,
  purpose: CredentialPurpose,
): Promise<NextResponse> {
  // Relative destinations, resolved against this request. The token is never
  // reflected into either of them.
  const problem = NextResponse.redirect(new URL(PROBLEM_PATH, request.url));

  const limited = await rateLimit(
    `account-link:${clientKey(request)}`,
    rateLimits.accountCredential.limit,
    rateLimits.accountCredential.windowSeconds,
  );
  /*
    A limited caller is sent to the same page as a bad link, rather than a 429.
    Somebody sweeping tokens learns nothing from the difference, and a real
    person who reloaded too many times gets a page that tells them what to do.
  */
  if (!limited.ok) return problem;

  const credential = await peekCredential(token, purpose);
  if (!credential) return problem;

  const response = NextResponse.redirect(new URL(SET_PASSWORD_PATH, request.url));
  response.cookies.set(
    ACCOUNT_COOKIE,
    encodeAccountCookie(purpose, token),
    accountCookieOptions(),
  );
  return response;
}
