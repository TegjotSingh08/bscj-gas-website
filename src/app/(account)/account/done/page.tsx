import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Password saved",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Done.
 *
 * Both sign-in doors are offered, because this page cannot tell which one the
 * reader belongs to — and deliberately does not try. It is reached with no
 * session and no credential, so it knows nothing about the account, which is
 * exactly the right amount for a page anybody could load.
 */
export default function AccountDonePage() {
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <div className="rounded-2xl border-2 border-navy-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-extrabold text-navy-900">Password saved</h1>
        <p className="mt-2 text-sm text-navy-700">
          You can sign in now. That link has stopped working, and any other
          links we had sent you have too.
        </p>

        <Link
          href="/portal/login"
          className="mt-6 block w-full rounded-xl bg-flame-500 px-6 py-4 text-center text-base font-bold text-white hover:bg-flame-600"
        >
          Go to the agency portal
        </Link>

        <p className="mt-4 text-center text-xs text-navy-600">
          BSCJ staff sign in{" "}
          <Link href="/admin/login" className="font-bold underline">
            here
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
