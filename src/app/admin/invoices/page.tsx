import type { Metadata } from "next";
import Link from "next/link";

import { requireAdmin } from "@/lib/auth/session";
import {
  countJobsAwaitingInvoice,
  invoiceConfiguration,
  listInvoices,
} from "@/lib/invoices/invoices";
import { formatPence } from "@/lib/invoices/model";
import { AdminNav } from "../AdminNav";
import { InvoiceStatusPill } from "./StatusPill";

export const metadata: Metadata = {
  title: "Invoices",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * Every invoice, newest first.
 *
 * Drafts sit in the same list as issued ones rather than behind a tab: a draft
 * nobody finished is the thing most worth noticing, and hiding it is how it
 * stays unfinished.
 *
 * The configuration banner is at the top rather than on the issue button
 * alone, because the fix — somebody typing bank details into the settings
 * screen — is not something the person trying to issue can do in the moment.
 */
export default async function AdminInvoicesPage() {
  const { user } = await requireAdmin();

  const [invoices, awaiting, config] = await Promise.all([
    listInvoices({ kind: "all" }),
    countJobsAwaitingInvoice(),
    invoiceConfiguration(),
  ]);

  return (
    <>
      <AdminNav userName={user.name} current="invoices" />

      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-2xl font-extrabold text-navy-900">Invoices</h1>
          {awaiting > 0 && (
            <Link
              href="/admin/jobs?status=completed"
              className="text-sm font-bold text-flame-600 hover:underline"
            >
              {awaiting} completed{" "}
              {awaiting === 1 ? "job has" : "jobs have"} no invoice
            </Link>
          )}
        </div>

        {config.missing.length > 0 && (
          <div
            role="alert"
            className="mt-4 rounded-2xl border-2 border-flame-500 bg-flame-400/10 p-5"
          >
            <h2 className="text-sm font-extrabold text-navy-900">
              Invoices cannot be issued yet
            </h2>
            <p className="mt-1 text-sm text-navy-800">
              Nothing about the business is invented by this application. These
              are still empty: <strong>{config.missing.join(", ")}</strong>.
              Drafts can be prepared in the meantime.
            </p>
            <Link
              href="/admin/settings"
              className="mt-3 inline-block rounded-xl bg-flame-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-flame-600"
            >
              Business details
            </Link>
          </div>
        )}

        {!config.storageReady && (
          <p
            role="alert"
            className="mt-4 rounded-2xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
          >
            Document storage is not available, so no PDF can be kept.{" "}
            {config.storageRequirement}
          </p>
        )}

        {invoices.length === 0 ? (
          <div className="mt-6 rounded-2xl border-2 border-dashed border-navy-300 bg-white p-8 text-center">
            <h2 className="text-lg font-extrabold text-navy-900">
              No invoices yet
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-navy-700">
              An invoice is raised from a completed job — open the job and use
              &ldquo;Raise an invoice&rdquo;.
            </p>
            <Link
              href="/admin/jobs"
              className="mt-5 inline-block rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600"
            >
              Open jobs
            </Link>
          </div>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-2xl border-2 border-navy-200 bg-white">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead className="border-b-2 border-navy-200 text-xs font-bold uppercase tracking-wide text-navy-600">
                <tr>
                  <th className="px-4 py-3">Number</th>
                  <th className="px-4 py-3">Payer</th>
                  <th className="px-4 py-3">Job</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3">Raised</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr
                    key={invoice.id}
                    className="border-b border-navy-100 last:border-0"
                  >
                    <td className="px-4 py-3 font-bold text-navy-900">
                      <Link
                        href={`/admin/invoices/${invoice.id}`}
                        className="hover:underline"
                      >
                        {invoice.number ?? "Draft"}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-navy-800">
                      {invoice.payerName ?? "—"}
                      {invoice.organisationName && (
                        <span className="block text-xs text-navy-600">
                          {invoice.organisationName}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-navy-700">
                      {invoice.jobReference ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <InvoiceStatusPill status={invoice.status} />
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-navy-900">
                      {formatPence(invoice.totalPence)}
                    </td>
                    <td className="px-4 py-3 text-navy-700">
                      {invoice.createdAt.toLocaleDateString("en-GB")}
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
