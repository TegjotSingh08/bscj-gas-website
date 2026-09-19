import type { Metadata } from "next";
import Link from "next/link";

import { requireAgent } from "@/lib/auth/session";
import { listInvoices } from "@/lib/invoices/invoices";
import { formatPence } from "@/lib/invoices/model";
import { PortalNav } from "../PortalNav";

export const metadata: Metadata = {
  title: "Invoices",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * The agency's own invoices.
 *
 * Read-only, and only what has been issued. A draft is BSCJ's working document
 * and a voided one was withdrawn; neither appears here, and the filter is in
 * the query rather than in this page — `listInvoices` narrows by the scope it
 * is given, so a mistake in this file cannot widen it.
 *
 * The PDF is reached through the one authenticated document route, which
 * re-derives the permission from the row for every request. There is no signed
 * link and no public URL.
 */
export default async function PortalInvoicesPage() {
  const { user, organisationName, scope } = await requireAgent();
  const invoices = await listInvoices(scope);

  return (
    <>
      <PortalNav
        organisationName={organisationName}
        userName={user.name}
        current="invoices"
      />

      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-extrabold text-navy-900">Invoices</h1>
        <p className="mt-2 text-sm text-navy-700">
          Everything BSCJ has invoiced {organisationName} for.
        </p>

        {invoices.length === 0 ? (
          <div className="mt-6 rounded-2xl border-2 border-dashed border-navy-300 bg-white p-8 text-center">
            <h2 className="text-lg font-extrabold text-navy-900">
              Nothing invoiced yet
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-navy-700">
              An invoice appears here once the work is done and it has been
              issued.
            </p>
          </div>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-2xl border-2 border-navy-200 bg-white">
            <table className="w-full min-w-[42rem] text-left text-sm">
              <thead className="border-b-2 border-navy-200 text-xs font-bold uppercase tracking-wide text-navy-600">
                <tr>
                  <th className="px-4 py-3">Number</th>
                  <th className="px-4 py-3">Job</th>
                  <th className="px-4 py-3">Issued</th>
                  <th className="px-4 py-3">Due</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3" />
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
                        href={`/portal/invoices/${invoice.id}`}
                        className="hover:underline"
                      >
                        {invoice.number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-navy-700">
                      {invoice.jobReference ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-navy-700">
                      {invoice.issuedAt?.toLocaleDateString("en-GB") ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-navy-700">
                      {invoice.dueDate ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-navy-900">
                      {formatPence(invoice.totalPence)}
                    </td>
                    <td className="px-4 py-3 text-navy-700">
                      {invoice.paidOn ? `Paid ${invoice.paidOn}` : "Outstanding"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {invoice.documentId && (
                        <a
                          href={`/api/documents/${invoice.documentId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-bold text-flame-600 hover:underline"
                        >
                          PDF
                        </a>
                      )}
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
