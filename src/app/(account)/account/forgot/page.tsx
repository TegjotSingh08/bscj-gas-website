import type { Metadata } from "next";
import Link from "next/link";

import { business } from "@/lib/business";
import { ForgotForm } from "./ForgotForm";

export const metadata: Metadata = {
  title: "Email me a link",
  robots: { index: false, follow: false, nocache: true },
};

/** Force-dynamic: the confirmation depends on the query the action set. */
export const dynamic = "force-dynamic";

/**
 * Asking for a link.
 *
 * Covers both cases with one form, because the caller must not have to say
 * which they are: somebody whose invitation expired and somebody who has
 * forgotten their password type the same thing here, and the server works out
 * which message to send from the state of the account. Two forms would mean
 * the *choice of form* leaked whether an account had been set up.
 *
 * The confirmation is shown **whatever happened**, including for an address
 * with no account at all. It is worded so that it is true either way.
 */
export default async function ForgotPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const { sent } = await searchParams;

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <div className="rounded-2xl border-2 border-navy-200 bg-white p-6 shadow-sm sm:p-8">
        {sent ? (
          <>
            <h1 className="text-xl font-extrabold text-navy-900">Check your email</h1>
            <p className="mt-2 text-sm text-navy-700">
              If that address has an account with us, a link is on its way. It
              works once, and only for a short time.
            </p>
            <p className="mt-3 text-sm text-navy-700">
              Nothing has changed on your account yet — your current password,
              if you have one, still works until you choose a new one.
            </p>
            <p className="mt-4 text-xs text-navy-600">
              Nothing arrived? Check the spam folder, then call or WhatsApp{" "}
              {business.phoneDisplay}. We cannot tell you whether an address has
              an account over the web, but we can help on the phone.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-extrabold text-navy-900">
              Email me a link
            </h1>
            <p className="mt-2 text-sm text-navy-700">
              Enter the address your account uses. We will send a link to set a
              password — whether you are setting one for the first time or
              replacing one you have forgotten.
            </p>
            <ForgotForm />
          </>
        )}

        <p className="mt-6 border-t-2 border-navy-100 pt-4 text-xs text-navy-600">
          Remembered it?{" "}
          <Link href="/portal/login" className="font-bold underline">
            Sign in
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
