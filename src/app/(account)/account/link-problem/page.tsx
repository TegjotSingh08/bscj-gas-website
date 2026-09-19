import type { Metadata } from "next";
import Link from "next/link";

import { business } from "@/lib/business";
import { FORGOT_PATH } from "@/lib/auth/account-paths";

export const metadata: Metadata = {
  title: "That link did not work",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Where every bad link lands.
 *
 * **One page, one message, for every cause.** Expired, already used, revoked,
 * wrong purpose, never existed, account suspended, agency suspended — all of
 * them arrive here and read the same. Distinguishing them would answer
 * questions nobody holding a bad link is entitled to have answered: "expired"
 * confirms the address has an account, and "already used" confirms somebody
 * has set a password on it.
 *
 * What it does give is the way forward, which is what a person with a genuinely
 * stale link actually needs.
 */
export default function LinkProblemPage() {
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <div className="rounded-2xl border-2 border-navy-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-extrabold text-navy-900">
          That link did not work
        </h1>
        <p className="mt-2 text-sm text-navy-700">
          Links stop working once they have been used, and after a while on
          their own. That is normal and nothing has gone wrong with your
          account.
        </p>

        <Link
          href={FORGOT_PATH}
          className="mt-6 block w-full rounded-xl bg-flame-500 px-6 py-4 text-center text-base font-bold text-white hover:bg-flame-600"
        >
          Email me a new link
        </Link>

        <p className="mt-4 text-xs text-navy-600">
          Already set your password? Sign in at{" "}
          <Link href="/portal/login" className="font-bold underline">
            the agency portal
          </Link>
          . Still stuck? Call or WhatsApp {business.phoneDisplay}.
        </p>
      </div>
    </main>
  );
}
