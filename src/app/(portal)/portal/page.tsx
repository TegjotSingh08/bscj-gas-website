import type { Metadata } from "next";

import { requireAgent } from "@/lib/auth/session";
import { business } from "@/lib/business";
import { SignOutButton } from "./SignOutButton";

export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * The agency dashboard.
 *
 * Deliberately empty of operational data. The portfolio, jobs, compliance and
 * invoice screens arrive in later phases, and a dashboard of zeroes would
 * invite the reading that there is no work on — which would be wrong rather
 * than empty.
 *
 * `requireAgent()` is what makes this page an agency's. It verifies the
 * session, re-reads the role and the organisation from the database, and
 * refuses a suspended user or a suspended agency. An administrator is sent to
 * the portal sign-in rather than shown somebody's account: view-as is an
 * audited feature, not a side effect of being staff.
 */

/** The surfaces this portal will grow. Named now so the shape is visible. */
const SECTIONS = [
  {
    title: "Portfolio",
    description: "Landlords, properties and tenants.",
  },
  {
    title: "Jobs",
    description: "Work requested, scheduled and completed.",
  },
  {
    title: "Compliance",
    description: "Certificates, due dates and renewals.",
  },
  {
    title: "Invoices",
    description: "What has been billed, and what is outstanding.",
  },
  {
    title: "Support",
    description: "Message BSCJ about a job or a property.",
  },
] as const;

export default async function PortalDashboardPage() {
  const { user, organisationName } = await requireAgent();

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-flame-600">
            BSCJ Gas &amp; Heating
          </p>
          <h1 className="mt-1 text-2xl font-extrabold text-navy-900 sm:text-3xl">
            {organisationName}
          </h1>
          <p className="mt-1 text-sm text-navy-600">
            Signed in as {user.name} ({user.email})
          </p>
        </div>
        <SignOutButton />
      </div>

      <div className="mt-8 rounded-2xl border-2 border-navy-200 bg-white p-6">
        <h2 className="text-lg font-extrabold text-navy-900">
          Your portal is ready
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-navy-700">
          Your account is open. The sections below are being built and will
          appear here as they are finished. In the meantime, call or WhatsApp{" "}
          {business.phoneDisplay} and we will arrange work for you directly.
        </p>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((section) => (
          <div
            key={section.title}
            className="rounded-2xl border-2 border-navy-200 bg-white p-5"
            aria-disabled="true"
          >
            <h3 className="text-sm font-extrabold text-navy-900">
              {section.title}
            </h3>
            <p className="mt-1 text-sm text-navy-600">{section.description}</p>
            <p className="mt-3 inline-block rounded-lg bg-navy-50 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-navy-600">
              Coming soon
            </p>
          </div>
        ))}
      </div>
    </main>
  );
}
