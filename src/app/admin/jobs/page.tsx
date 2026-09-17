import type { Metadata } from "next";
import Link from "next/link";

import { requireAdmin } from "@/lib/auth/session";
import { listJobs } from "@/lib/jobs/queries";
import { productFor } from "@/lib/booking/products";
import { bookingConfig } from "@/lib/booking/config";

export const metadata: Metadata = {
  title: "Jobs",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * Every recorded job, newest first.
 *
 * Operational, not a dashboard: its whole purpose at this phase is to let
 * somebody confirm that a booking taken on the public site arrived in the
 * database, and to open it. The buckets, filters and search belong to the
 * agent portal in a later phase.
 */
export default async function AdminJobsPage() {
  // The scope comes from the verified session, not from the request.
  const { scope } = await requireAdmin();
  const jobs = await listJobs(scope);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-extrabold text-navy-900">Jobs</h1>
        <Link href="/admin" className="text-sm font-bold text-flame-600 underline">
          Back to dashboard
        </Link>
      </div>

      {jobs === null ? (
        <p className="mt-6 rounded-xl bg-navy-50 px-4 py-3 text-sm text-navy-700">
          The database is not configured, so no jobs can be listed. The public
          booking flow is unaffected.
        </p>
      ) : jobs.length === 0 ? (
        <p className="mt-6 rounded-xl bg-navy-50 px-4 py-3 text-sm text-navy-700">
          No jobs recorded yet. A booking taken on the website appears here once
          its calendar event has been written.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-2xl border-2 border-navy-200 bg-white">
          <table className="w-full min-w-[46rem] text-left text-sm">
            <thead className="bg-navy-50 text-xs uppercase tracking-wide text-navy-600">
              <tr>
                <th className="px-4 py-3 font-bold">Reference</th>
                <th className="px-4 py-3 font-bold">Customer</th>
                <th className="px-4 py-3 font-bold">Service</th>
                <th className="px-4 py-3 font-bold">Appointment</th>
                <th className="px-4 py-3 font-bold">Postcode</th>
                <th className="px-4 py-3 font-bold">Status</th>
                <th className="px-4 py-3 text-right font-bold">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-100">
              {jobs.map((job) => (
                <tr key={job.id} className="hover:bg-navy-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/jobs/${job.id}`}
                      className="font-bold text-flame-600 underline"
                    >
                      {job.reference}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-navy-900">
                    {job.customerName ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-navy-700">
                    {productFor(job.productId).subjectName}
                  </td>
                  <td className="px-4 py-3 text-navy-700">
                    {job.appointmentStart
                      ? job.appointmentStart.toLocaleString("en-GB", {
                          timeZone: bookingConfig.timeZone,
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-navy-700">
                    {job.postcode ?? "—"}
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
  );
}
