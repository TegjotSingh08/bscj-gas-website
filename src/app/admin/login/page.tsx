import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { currentSession } from "@/lib/auth/session";
import { isAgentRole } from "@/lib/auth/roles";
import { business } from "@/lib/business";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false, nocache: true },
};

/** Force-dynamic: this page's answer depends on the caller's session. */
export const dynamic = "force-dynamic";

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await currentSession();

  /*
    **Where a signed-in person is sent from here, and why it is not simply
    "/admin".**

    It used to be: any session at all was redirected to `/admin`. But `/admin`
    asks `requireAdmin()`, which sends everybody who is not an administrator
    straight back to this page — so the two pages pushed each other round in
    a circle. An engineer who typed the right password was bounced between
    them until the browser gave up with ERR_TOO_MANY_REDIRECTS, which is to
    say **an engineer could not sign in at all**; an agency user who followed
    an admin link got the same dead end instead of being told they were in
    the wrong place. It was found by signing in as each role in a browser and
    following the redirects.

    So each session goes where that session is actually allowed to be, and
    anyone else is left on this page with the form — the rule `/portal/login`
    already follows for an administrator who lands there.
  */
  if (session?.user.role === "admin") redirect("/admin");
  if (session?.user.role === "engineer") redirect("/engineer");

  const signedInElsewhere = session ? isAgentRole(session.user.role) : false;

  const { next } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-2xl border-2 border-navy-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-lg font-extrabold text-navy-900">
          BSCJ <span className="text-flame-600">Gas &amp; Heating</span>
        </p>
        <h1 className="mt-4 text-2xl font-extrabold text-navy-900">
          Staff sign in
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-navy-600">
          This area is for {business.name} staff. If you are a customer looking
          for your booking, the details are in your confirmation email.
        </p>

        {signedInElsewhere && (
          <p
            role="status"
            className="mt-4 rounded-xl border-2 border-navy-200 bg-navy-50 px-4 py-3 text-sm leading-relaxed text-navy-800"
          >
            You are signed in as an agency user. This area is for {business.name}{" "}
            staff.{" "}
            <Link href="/portal" className="font-bold text-flame-600 underline">
              Go to your portal
            </Link>
            .
          </p>
        )}

        <LoginForm next={next} />

        <p className="mt-4 text-sm">
          <Link
            href="/account/forgot"
            className="font-bold text-flame-600 underline"
          >
            Forgotten your password?
          </Link>
        </p>
      </div>
    </main>
  );
}
