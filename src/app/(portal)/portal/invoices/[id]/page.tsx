import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAgent } from "@/lib/auth/session";
import { loadInvoice } from "@/lib/invoices/invoices";
import { formatPence } from "@/lib/invoices/model";
import { PortalNav } from "../../PortalNav";

export const metadata: Metadata = {
  title: "Invoice",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * One invoice, as the agency sees it.
 *
 * `loadInvoice` decides from the scope: another organisation's invoice, a
 * draft, and a voided one all come back null and land on the same 404. Three
 * different answers would turn an id into a probe for which invoices exist.
 *
 * There is no action on this page. An agency reads an invoice and downloads
 * it; issuing, correcting and recording payment are BSCJ's, and an agency
 * carries `invoice:read` and never `invoice:write`.
 */
export default async function PortalInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, organisationName, scope } = await requireAgent();
  const { id } = await params;

  const invoice = await loadInvoice(scope, id);
  if (!invoice) notFound();

  return (
    <>
      <PortalNav
        organisationName={organisationName}
        userName={user.name}
        current="invoices"
      />

      <main className="mx-auto max-w-3xl px-4 py-8">
        <Link
          href="/portal/invoices"
          className="text-sm font-bold text-navy-600 hover:text-navy-900"
        >
          ← All invoices
        </Link>

        <h1 className="mt-2 text-2xl font-extrabold text-navy-900">
          {invoice.number}
        </h1>
        {invoice.propertyLine && (
          <p className="mt-1 text-sm text-navy-700">
            For work at {invoice.propertyLine}
            {invoice.jobReference && <> · job {invoice.jobReference}</>}
          </p>
        )}

        <section className="mt-6 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <table className="w-full text-left text-sm">
            <thead className="border-b-2 border-navy-200 text-xs font-bold uppercase tracking-wide text-navy-600">
              <tr>
                <th className="py-2">Description</th>
                <th className="py-2 text-right">Qty</th>
                <th className="py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line) => (
                <tr key={line.id} className="border-b border-navy-100">
                  <td className="py-2 text-navy-900">{line.description}</td>
                  <td className="py-2 text-right text-navy-700">
                    {line.quantity}
                  </td>
                  <td className="py-2 text-right font-bold text-navy-900">
                    {formatPence(line.totalPence)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} className="py-2 text-right font-bold">
                  Total
                </td>
                <td className="py-2 text-right text-lg font-extrabold text-navy-900">
                  {formatPence(invoice.totalPence)}
                </td>
              </tr>
            </tfoot>
          </table>

          <dl className="mt-4 grid gap-2 border-t-2 border-navy-100 pt-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
                Issued
              </dt>
              <dd className="text-navy-900">
                {invoice.issuedAt?.toLocaleDateString("en-GB") ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
                Due
              </dt>
              <dd className="text-navy-900">{invoice.dueDate ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
                Payment
              </dt>
              <dd className="text-navy-900">
                {invoice.paidOn
                  ? `Received ${invoice.paidOn}`
                  : "Not yet recorded"}
              </dd>
            </div>
          </dl>

          {invoice.documentId && (
            <a
              href={`/api/documents/${invoice.documentId}`}
              target="_blank"
              rel="noreferrer"
              className="mt-5 inline-block rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600"
            >
              Download the invoice
            </a>
          )}
        </section>
      </main>
    </>
  );
}
