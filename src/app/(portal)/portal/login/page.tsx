import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { currentSession } from "@/lib/auth/session";
import { isAgentRole } from "@/lib/auth/roles";
import { business } from "@/lib/business";
import { PortalLoginForm } from "./PortalLoginForm";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false, nocache: true },
};

/** Force-dynamic: this page's answer depends on the caller's session. */
export const dynamic = "force-dynamic";

/**
 * Agency sign-in.
 *
 * Branded as BSCJ but addressed to an agency rather than to staff. The
 * credential check behind it is the same one `/admin/login` uses — one
 * `app_user` table, one password path — and a suspended user or a suspended
 * agency is refused here with exactly the same words as a wrong password.
 */
export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await currentSession();
  // Already signed in as an agency? There is nothing to do here. A signed-in
  // administrator is left on this page: they have no organisation to show.
  if (session && isAgentRole(session.user.role)) redirect("/portal");

  const { next } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-2xl border-2 border-navy-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-lg font-extrabold text-navy-900">
          BSCJ <span className="text-flame-600">Gas &amp; Heating</span>
        </p>
        <h1 className="mt-4 text-xl font-extrabold text-navy-900">
          Agency portal
        </h1>
        <p className="mt-1 text-sm text-navy-600">
          Sign in to manage your properties and compliance.
        </p>

        <PortalLoginForm next={next} />

        <p className="mt-6 border-t-2 border-navy-100 pt-4 text-xs text-navy-600">
          Accounts are opened by BSCJ. If you need access, call{" "}
          {business.phoneDisplay}.
        </p>
      </div>
    </main>
  );
}
