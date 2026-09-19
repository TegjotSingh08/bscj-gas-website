"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  clearedAccountCookieOptions,
  decodeAccountCookie,
} from "@/lib/auth/account-cookie";
import {
  ACCOUNT_COOKIE,
  DONE_PATH,
  FORGOT_PATH,
} from "@/lib/auth/account-paths";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { peekCredential, redeemCredential } from "@/lib/auth/credentials";
import { requestPasswordReset } from "@/lib/auth/onboarding";
import { recordAudit } from "@/lib/audit/record";
import { rateLimit, rateLimits } from "@/lib/booking/rate-limit";

/**
 * The two things an unauthenticated visitor may do to an account: set a
 * password with a credential they were sent, and ask for one to be sent.
 *
 * A server action is a public HTTP endpoint with a generated name, so both are
 * written as if anyone can call them — because anyone can. Neither trusts a
 * field for anything that decides an outcome: **the account is named by the
 * credential, never by the form.** There is no user id, no email and no
 * organisation in either submission that the server acts on, which is what
 * makes "set somebody else's password" not a request that can be expressed.
 */

export type AccountActionState = { error?: string };

/** The caller, for rate limiting. The first forwarded hop, or nothing. */
async function callerKey(): Promise<string> {
  const header = await headers();
  return header.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/**
 * Sets the password behind the credential in the cookie.
 *
 * The credential is read from the httpOnly cookie the link handler wrote, not
 * from the form, so nothing the page renders and nothing a script on it could
 * reach carries the token.
 *
 * **Every refusal says the same thing** and clears the cookie. Expired, spent,
 * revoked, wrong purpose, suspended: one sentence, because the difference is
 * only useful to somebody who should not be here. A person who genuinely has a
 * dead link is told what to do about it, which is all they need.
 *
 * On success the cookie is cleared before the redirect. Leaving it would mean
 * a browser Back landing on a form holding a credential that is now spent —
 * harmless, but it would show a confusing error to somebody who just
 * succeeded.
 */
export async function setPasswordAction(
  _previous: AccountActionState,
  form: FormData,
): Promise<AccountActionState> {
  const jar = await cookies();
  const credential = decodeAccountCookie(jar.get(ACCOUNT_COOKIE)?.value);

  const refuse = (): AccountActionState => {
    jar.set(ACCOUNT_COOKIE, "", clearedAccountCookieOptions());
    return {
      error:
        "That link is no longer valid. It may have expired, or already been used. Ask for a new one.",
    };
  };

  if (!credential) return refuse();

  /*
    Limited per caller *and* on the submission, not only on opening the link.
    Opening is a lookup; this is a lookup plus a deliberately expensive scrypt
    hash, and an unauthenticated endpoint that does expensive work on demand is
    a denial-of-service surface whether or not the credential is valid.
  */
  const limited = await rateLimit(
    `account-submit:${await callerKey()}`,
    rateLimits.accountCredential.limit,
    rateLimits.accountCredential.windowSeconds,
  );
  if (!limited.ok) {
    return { error: "Too many attempts. Wait a few minutes and try again." };
  }

  const password = typeof form.get("password") === "string"
    ? String(form.get("password"))
    : "";
  const confirm = typeof form.get("passwordConfirm") === "string"
    ? String(form.get("passwordConfirm"))
    : "";

  /*
    The password rules are checked **before** the credential is spent. A
    credential burned on a password the rules then refuse would leave somebody
    locked out by a typo, having done nothing wrong.
  */
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  if (password !== confirm) return { error: "Those passwords do not match." };

  // Re-read so a suspended account or an expired credential is caught before
  // the expensive hash, and so the audit line can name the account.
  const view = await peekCredential(credential.token, credential.purpose);
  if (!view) return refuse();

  const redeemed = await redeemCredential({
    token: credential.token,
    purpose: credential.purpose,
    passwordHash: await hashPassword(password),
  });

  if (redeemed.status !== "ok") return refuse();

  await recordAudit({
    actorUserId: redeemed.userId,
    actorDescription: "account holder",
    kind:
      credential.purpose === "invitation"
        ? "account.invitation.redeemed"
        : "account.password.reset",
    subjectType: "app_user",
    subjectId: redeemed.userId,
    // The purpose and the fact it happened. Never the token, never the hash.
    detail: { purpose: credential.purpose },
  });

  jar.set(ACCOUNT_COOKIE, "", clearedAccountCookieOptions());
  redirect(DONE_PATH);
}

/**
 * Asks for a reset link.
 *
 * **Answers identically whatever happens.** Unknown address, suspended
 * account, an account still holding an unredeemed invitation, a rate limit, a
 * database that is down — the caller is told the same sentence every time, and
 * it is true every time: if that address has an account, a link is on its way.
 *
 * Anything else makes this form a way to test whether an address has an
 * account here, which for a business whose customers are letting agencies is a
 * list worth having.
 */
export async function requestResetAction(
  _previous: AccountActionState,
  form: FormData,
): Promise<AccountActionState> {
  const caller = await callerKey();

  const limited = await rateLimit(
    `reset-form:${caller}`,
    rateLimits.passwordResetRequest.limit,
    rateLimits.passwordResetRequest.windowSeconds,
  );
  /*
    Even the rate limit answers generically — by simply not calling through.
    A "too many requests" message here would distinguish a caller who has been
    asking about real addresses from one who has not.
  */
  if (limited.ok) {
    const email = typeof form.get("email") === "string"
      ? String(form.get("email"))
      : "";
    await requestPasswordReset({ email, callerKey: caller });
  }

  redirect(`${FORGOT_PATH}?sent=1`);
}
