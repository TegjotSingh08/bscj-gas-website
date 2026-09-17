import type { Metadata } from "next";

import Link from "next/link";

import { requireAgent } from "@/lib/auth/session";
import { business } from "@/lib/business";
import { portfolioSummary } from "@/lib/portfolio/queries";
import { PortalNav } from "./PortalNav";

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
  const { user, organisationId, organisationName } = await requireAgent();
  const summary = await portfolioSummary(organisationId);

  return (
    <>
    <PortalNav
      organisationName={organisationName}
      userName={user.name}
      current="dashboard"
    />
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-extrabold text-navy-900">Dashboard</h1>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Properties", summary?.properties ?? 0],
          ["Landlords", summary?.landlords ?? 0],
          ["With a tenant", summary?.withTenant ?? 0],
          ["With a CP12 date", summary?.withCompliance ?? 0],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-2xl border-2 border-navy-200 bg-white p-5">
            <p className="text-xs font-bold uppercase tracking-wide text-navy-600">
              {label}
            </p>
            <p className="mt-1 text-2xl font-extrabold text-navy-900">{value}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-2xl border-2 border-navy-200 bg-white p-6">
        <h2 className="text-lg font-extrabold text-navy-900">Your portfolio</h2>
        <p className="mt-2 text-sm leading-relaxed text-navy-700">
          Add the properties you look after and we will track their certificate
          dates. Booking work from the portal is next; until then, call or
          WhatsApp {business.phoneDisplay} and we will arrange it directly.
        </p>
        <Link
          href="/portal/portfolio"
          className="mt-4 inline-block rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600"
        >
          Open portfolio
        </Link>
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
    </>
  );
}
