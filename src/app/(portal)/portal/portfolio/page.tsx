import type { Metadata } from "next";
import Link from "next/link";

import { requireAgent } from "@/lib/auth/session";
import { listPortfolio, portfolioSummary } from "@/lib/portfolio/queries";
import { deadlineRisk } from "@/lib/compliance/renewal";
import { PortalNav } from "../PortalNav";

export const metadata: Metadata = {
  title: "Portfolio",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/** Today, in the booking timezone, as the risk calculation expects it. */
function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const RISK_STYLE: Record<string, string> = {
  overdue: "bg-flame-500 text-white",
  urgent: "bg-flame-400/20 text-flame-700",
  approaching: "bg-navy-100 text-navy-800",
  normal: "bg-navy-50 text-navy-600",
};

/**
 * The portfolio.
 *
 * Every property the agency holds, with the three things they actually need at
 * a glance: who owns it, who is in it, and when its certificate runs out. The
 * compliance column is sorted to the top of attention by colour rather than by
 * order, so the list stays in address order and stays scannable.
 *
 * `requireAgent()` supplies the organisation. It is never read from the URL —
 * there is no organisation in the URL at all, which is the simplest way to
 * guarantee one cannot be substituted.
 */
export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { user, organisationId, organisationName } = await requireAgent();
  const { q = "" } = await searchParams;

  const [rows, summary] = await Promise.all([
    listPortfolio(organisationId, q),
    portfolioSummary(organisationId),
  ]);

  const today = todayIso();

  return (
    <>
      <PortalNav
        organisationName={organisationName}
        userName={user.name}
        current="portfolio"
      />

      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-extrabold text-navy-900">Portfolio</h1>
            {summary && (
              <p className="mt-1 text-sm text-navy-600">
                {summary.properties}{" "}
                {summary.properties === 1 ? "property" : "properties"} ·{" "}
                {summary.landlords}{" "}
                {summary.landlords === 1 ? "landlord" : "landlords"} ·{" "}
                {summary.withTenant} with a tenant on file ·{" "}
                {summary.withCompliance} with a certificate date
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/portal/portfolio/import"
              className="rounded-xl border-2 border-navy-200 px-5 py-3 text-sm font-bold text-navy-900 hover:border-navy-600"
            >
              Import from a spreadsheet
            </Link>
            <Link
              href="/portal/portfolio/new"
              className="rounded-xl bg-flame-500 px-5 py-3 text-sm font-bold text-white hover:bg-flame-600"
            >
              Add property
            </Link>
          </div>
        </div>

        <form method="get" className="mt-6 flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search address, postcode, landlord or tenant"
            aria-label="Search the portfolio"
            className="w-full rounded-xl border-2 border-navy-200 bg-white px-4 py-2.5 text-base text-navy-900 focus:border-flame-500 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-xl border-2 border-navy-200 px-5 py-2.5 text-sm font-bold text-navy-900 hover:border-navy-600"
          >
            Search
          </button>
        </form>

        {rows === null ? (
          <p className="mt-6 rounded-xl bg-navy-50 px-4 py-3 text-sm text-navy-700">
            The portfolio is temporarily unavailable.
          </p>
        ) : rows.length === 0 && q ? (
          <div className="mt-6 rounded-2xl border-2 border-navy-200 bg-white p-8 text-center">
            <p className="text-sm text-navy-700">
              Nothing matched “{q}”.
            </p>
            <Link
              href="/portal/portfolio"
              className="mt-2 inline-block text-sm font-bold text-flame-600 underline"
            >
              Clear the search
            </Link>
          </div>
        ) : rows.length === 0 ? (
          <div className="mt-6 rounded-2xl border-2 border-dashed border-navy-300 bg-white p-8 text-center">
            <h2 className="text-lg font-extrabold text-navy-900">
              Add your first property
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-navy-700">
              Enter a postcode and we fill in the rest. Add the landlord and the
              tenant as you go, and the certificate date if you have it — that
              is what lets us tell you when a renewal is coming.
            </p>
            <Link
              href="/portal/portfolio/new"
              className="mt-5 inline-block rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600"
            >
              Add property
            </Link>
          </div>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-2xl border-2 border-navy-200 bg-white">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead className="bg-navy-50 text-xs uppercase tracking-wide text-navy-600">
                <tr>
                  <th className="px-4 py-3 font-bold">Property</th>
                  <th className="px-4 py-3 font-bold">Landlord</th>
                  <th className="px-4 py-3 font-bold">Tenant</th>
                  <th className="px-4 py-3 font-bold">CP12 due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-100">
                {rows.map((row) => {
                  const risk = row.dueDate
                    ? deadlineRisk(row.dueDate, today)
                    : null;
                  return (
                    <tr key={row.id} className="hover:bg-navy-50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/portal/portfolio/${row.id}`}
                          className="font-bold text-flame-600 underline"
                        >
                          {row.houseOrName} {row.street}
                        </Link>
                        <p className="text-xs text-navy-600">
                          {[row.town, row.postcode].filter(Boolean).join(", ")}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-navy-700">
                        <Link
                          href={`/portal/landlords/${row.landlordId}`}
                          className="underline"
                        >
                          {row.landlordName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-navy-700">
                        {row.tenantName ? (
                          row.tenantName
                        ) : row.tenancyId ? (
                          <span className="text-navy-500">Tenant unnamed</span>
                        ) : (
                          <span className="text-navy-500">No tenant on file</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {row.dueDate ? (
                          <span
                            className={`inline-block rounded-lg px-2.5 py-1 text-xs font-bold ${
                              RISK_STYLE[risk ?? "normal"]
                            }`}
                          >
                            {row.dueDate}
                            {risk === "overdue" ? " · overdue" : ""}
                          </span>
                        ) : (
                          // Never "compliant" and never "overdue" by assumption.
                          <span className="text-xs text-navy-500">Not known</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
