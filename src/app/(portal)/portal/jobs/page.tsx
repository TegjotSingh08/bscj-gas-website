import type { Metadata } from "next";
import Link from "next/link";

import { requireAgent } from "@/lib/auth/session";
import { listAgencyJobs } from "@/lib/jobs/portal-queries";
import { productFor } from "@/lib/booking/products";
import { PortalNav } from "../PortalNav";

export const metadata: Metadata = {
  title: "Jobs",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * The agency's jobs.
 *
 * Read-only, and deliberately plain. The buckets an agent actually works from
 * — needs attention, awaiting tenant, overdue — arrive with the dashboard in a
 * later phase; showing them now would mean inventing statuses nothing yet
 * drives.
 */
export default async function AgencyJobsPage() {
  const { user, organisationId, organisationName } = await requireAgent();
  const jobs = await listAgencyJobs(organisationId);

  return (
    <>
      <PortalNav
        organisationName={organisationName}
        userName={user.name}
        current="jobs"
      />

      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-extrabold text-navy-900">Jobs</h1>

        {jobs === null ? (
          <p className="mt-6 rounded-xl bg-navy-50 px-4 py-3 text-sm text-navy-700">
            Jobs are temporarily unavailable.
          </p>
        ) : jobs.length === 0 ? (
          <div className="mt-6 rounded-2xl border-2 border-dashed border-navy-300 bg-white p-8 text-center">
            <h2 className="text-lg font-extrabold text-navy-900">
              No work booked yet
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-navy-700">
              Open a property in your portfolio and book work against it.
            </p>
            <Link
              href="/portal/portfolio"
              className="mt-5 inline-block rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600"
            >
              Open portfolio
            </Link>
          </div>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-2xl border-2 border-navy-200 bg-white">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead className="bg-navy-50 text-xs uppercase tracking-wide text-navy-600">
                <tr>
                  <th className="px-4 py-3 font-bold">Reference</th>
                  <th className="px-4 py-3 font-bold">Property</th>
                  <th className="px-4 py-3 font-bold">Service</th>
                  <th className="px-4 py-3 font-bold">Needed</th>
                  <th className="px-4 py-3 font-bold">Status</th>
                  <th className="px-4 py-3 text-right font-bold">Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-100">
                {jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-navy-50">
                    <td className="px-4 py-3">
                      <Link
                        href={`/portal/jobs/${job.id}`}
                        className="font-bold text-flame-600 underline"
                      >
                        {job.reference}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-navy-700">
                      {job.houseOrName} {job.street}
                      <span className="block text-xs text-navy-600">
                        {job.postcode}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-navy-700">
                      {productFor(job.productId).subjectName}
                    </td>
                    <td className="px-4 py-3 text-navy-700">
                      {job.requestedAsap
                        ? "As soon as possible"
                        : (job.completeByDate ?? "—")}
                    </td>
                    <td className="px-4 py-3 text-navy-700">
                      {job.lifecycleStatus.replace(/_/g, " ")}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-navy-900">
                      £{(job.priceTotalPence / 100).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
