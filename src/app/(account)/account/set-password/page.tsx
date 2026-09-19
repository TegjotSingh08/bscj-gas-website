import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { decodeAccountCookie } from "@/lib/auth/account-cookie";
import { ACCOUNT_COOKIE, PROBLEM_PATH } from "@/lib/auth/account-paths";
import { peekCredential } from "@/lib/auth/credentials";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { SetPasswordForm } from "./SetPasswordForm";

export const metadata: Metadata = {
  title: "Choose a password",
  robots: { index: false, follow: false, nocache: true },
};

/** Force-dynamic: the answer depends entirely on the caller's cookie. */
export const dynamic = "force-dynamic";

/**
 * Choosing a password, with a credential already in the cookie.
 *
 * The credential is **read, not spent**. Rendering this page changes nothing;
 * the single-use consumption happens in the submission, atomically, so a
 * reload, a prefetch or a mail scanner following the link costs nobody their
 * invitation.
 *
 * The account's email address is shown. That is deliberate and it is not a
 * leak: reaching this page required holding a credential that was sent to that
 * address, so the reader already knows it — and seeing it is what lets
 * somebody with two work addresses tell which account they are setting up.
 * Nothing else about the account is shown: no role, no organisation, no
 * indication of what it can reach.
 */
export default async function SetPasswordPage() {
  const jar = await cookies();
  const credential = decodeAccountCookie(jar.get(ACCOUNT_COOKIE)?.value);
  if (!credential) redirect(PROBLEM_PATH);

  const view = await peekCredential(credential.token, credential.purpose);
  if (!view) redirect(PROBLEM_PATH);

  const isInvitation = view.purpose === "invitation";

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <div className="rounded-2xl border-2 border-navy-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-extrabold text-navy-900">
          {isInvitation ? "Choose a password" : "Choose a new password"}
        </h1>
        <p className="mt-2 text-sm text-navy-700">
          {isInvitation
            ? "This finishes setting up your account."
            : "This replaces the password on your account."}
        </p>
        <p className="mt-1 text-sm font-bold text-navy-900">{view.email}</p>

        <SetPasswordForm
          isInvitation={isInvitation}
          minLength={MIN_PASSWORD_LENGTH}
        />

        <div className="mt-6 border-t-2 border-navy-100 pt-4 text-xs text-navy-600">
          <p>
            Use at least {MIN_PASSWORD_LENGTH} characters. A few unrelated words
            are easier to remember and harder to guess than one word with
            symbols in it.
          </p>
          {!isInvitation && (
            <p className="mt-2">
              Setting a new password signs out anybody already using this
              account, on every device.
            </p>
          )}
          <p className="mt-2">
            Nobody at BSCJ can see your password, and this link stops working
            once you have used it.
          </p>
        </div>
      </div>
    </main>
  );
}
