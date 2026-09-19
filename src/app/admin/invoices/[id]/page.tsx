import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/session";
import {
  eligiblePayers,
  loadInvoice,
  previewInvoice,
} from "@/lib/invoices/invoices";
import {
  invoiceRecipientAddresses,
  listInvoiceEmails,
} from "@/lib/invoices/delivery";
import {
  compareWithQuote,
  formatPence,
  isEditable,
  isIssued,
} from "@/lib/invoices/model";
import { AdminNav } from "../../AdminNav";
import { InvoiceEditor } from "../InvoiceEditor";
import {
  DiscardDraft,
  IssueInvoice,
  MarkPaid,
  SendInvoice,
  VoidInvoice,
} from "../InvoiceControls";
import { InvoiceStatusPill } from "../StatusPill";

export const metadata: Metadata = {
  title: "Invoice",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-b border-navy-100 py-2 last:border-0 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-navy-900 sm:col-span-2 sm:mt-0">
        {value ?? "—"}
      </dd>
    </div>
  );
}

/**
 * One invoice, and everything that can be done to it.
 *
 * The page changes shape with the status rather than showing every control
 * greyed out:
 *
 * - a **draft** gets the editor and the issue gate;
 * - an **issued** invoice gets the document, the email controls and the
 *   payment control, and the editor is gone entirely — there is no code path
 *   on this page that edits an issued invoice, not a disabled one;
 * - a **voided** one gets its reason and nothing else.
 *
 * The preview is rendered from the same `paintInvoice` call as the PDF, so
 * what is approved here is what is issued.
 */
export default async function AdminInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAdmin();
  const { user, scope } = session;
  const { id } = await params;

  const invoice = await loadInvoice(scope, id);
  if (!invoice) notFound();

  const [preview, payers, recipients, history] = await Promise.all([
    previewInvoice({ session, invoiceId: id }),
    invoice.primaryJobId ? eligiblePayers(invoice.primaryJobId) : [],
    invoiceRecipientAddresses(id),
    listInvoiceEmails(id),
  ]);

  const editable = isEditable(invoice.status);
  const issued = isIssued(invoice.status);
  const comparison = compareWithQuote(invoice.quotedTotalPence, invoice.totalPence);

  return (
    <>
      <AdminNav userName={user.name} current="invoices" />

      <main className="mx-auto max-w-6xl px-4 py-8">
        <Link
          href="/admin/invoices"
          className="text-sm font-bold text-navy-600 hover:text-navy-900"
        >
          ← All invoices
        </Link>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-extrabold text-navy-900">
            {invoice.number ?? "Draft invoice"}
          </h1>
          <InvoiceStatusPill status={invoice.status} />
        </div>

        {invoice.jobReference && invoice.primaryJobId && (
          <p className="mt-1 text-sm text-navy-700">
            For job{" "}
            <Link
              href={`/admin/jobs/${invoice.primaryJobId}`}
              className="font-bold hover:underline"
            >
              {invoice.jobReference}
            </Link>
            {invoice.propertyLine && <> — {invoice.propertyLine}</>}
          </p>
        )}

        {invoice.status === "void" && (
          <p
            role="alert"
            className="mt-4 rounded-2xl border-2 border-navy-300 bg-navy-50 px-4 py-3 text-sm font-semibold text-navy-900"
          >
            Voided {invoice.voidedAt?.toLocaleString("en-GB")}. Reason:{" "}
            {invoice.voidReason}. The number stays with it and is never reused.
          </p>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
          {/* -- Left: the work ------------------------------------------ */}
          <div>
            {editable ? (
              <section className="rounded-2xl border-2 border-navy-200 bg-white p-5">
                <h2 className="text-sm font-extrabold text-navy-900">
                  Edit this draft
                </h2>
                <p className="mt-1 text-sm text-navy-700">
                  Prefilled from what the job was booked and priced at. Nothing
                  has been re-priced against today&rsquo;s figures.
                </p>
                <InvoiceEditor
                  invoiceId={invoice.id}
                  lines={invoice.lines}
                  payers={payers}
                  payerId={invoice.payerId}
                  billingAddress={invoice.billingAddress.lines.join("\n")}
                  billingPostcode={invoice.billingAddress.postcode ?? ""}
                  quotedTotalPence={invoice.quotedTotalPence}
                />
              </section>
            ) : (
              <section className="rounded-2xl border-2 border-navy-200 bg-white p-5">
                <h2 className="text-sm font-extrabold text-navy-900">
                  What was charged
                </h2>
                <table className="mt-3 w-full text-left text-sm">
                  <thead className="border-b-2 border-navy-200 text-xs font-bold uppercase tracking-wide text-navy-600">
                    <tr>
                      <th className="py-2">Description</th>
                      <th className="py-2 text-right">Qty</th>
                      <th className="py-2 text-right">Unit</th>
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
                        <td className="py-2 text-right text-navy-700">
                          {formatPence(line.unitPricePence)}
                        </td>
                        <td className="py-2 text-right font-bold text-navy-900">
                          {formatPence(line.totalPence)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3} className="py-2 text-right font-bold">
                        Total
                      </td>
                      <td
                        className="py-2 text-right text-lg font-extrabold text-navy-900"
                        data-testid="issued-total"
                      >
                        {formatPence(invoice.totalPence)}
                      </td>
                    </tr>
                  </tfoot>
                </table>

                <p className="mt-3 text-xs text-navy-600">
                  An issued invoice is never edited. Correcting one means
                  voiding it and raising another.
                </p>
              </section>
            )}

            <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
              <h2 className="text-sm font-extrabold text-navy-900">Record</h2>
              <dl className="mt-2">
                <Row label="Payer" value={invoice.payerCompany ?? invoice.payerName} />
                <Row label="Payer email" value={invoice.payerEmail} />
                <Row
                  label="Billing address"
                  value={
                    invoice.billingAddress.lines.length > 0 ? (
                      <>
                        {invoice.billingAddress.lines.join(", ")}
                        {invoice.billingAddress.postcode && (
                          <>, {invoice.billingAddress.postcode}</>
                        )}
                      </>
                    ) : (
                      <span className="font-bold text-flame-600">
                        Not on file — it has to be entered, not taken from the
                        property.
                      </span>
                    )
                  }
                />
                <Row label="Service address" value={invoice.propertyLine} />
                <Row label="Agency" value={invoice.organisationName} />
                <Row
                  label="Job was quoted"
                  value={
                    invoice.quotedTotalPence === null
                      ? null
                      : formatPence(invoice.quotedTotalPence)
                  }
                />
                {comparison?.adjusted && (
                  <Row
                    label="Adjustment"
                    value={
                      <span className="font-bold text-flame-600">
                        {comparison.differencePence > 0 ? "+" : ""}
                        {formatPence(comparison.differencePence)} against the
                        quote. The job&rsquo;s own price is unchanged.
                      </span>
                    }
                  />
                )}
                <Row
                  label="Issued"
                  value={
                    invoice.issuedAt
                      ? `${invoice.issuedAt.toLocaleString("en-GB")}${
                          invoice.issuedByName ? ` by ${invoice.issuedByName}` : ""
                        }`
                      : null
                  }
                />
                <Row label="Due" value={invoice.dueDate} />
                <Row
                  label="Payment recorded"
                  value={
                    invoice.paidOn
                      ? `${invoice.paidOn}${invoice.paidNote ? ` — ${invoice.paidNote}` : ""}`
                      : null
                  }
                />
                <Row
                  label="VAT"
                  value={
                    invoice.vatRegistered
                      ? `${formatPence(invoice.vatPence)} (${invoice.vatNumber})`
                      : "Not registered — no VAT is charged or mentioned"
                  }
                />
              </dl>
            </section>
          </div>

          {/* -- Right: the document and the controls -------------------- */}
          <div className="grid gap-4">
            <section className="rounded-2xl border-2 border-navy-200 bg-white p-4">
              <h2 className="text-sm font-extrabold text-navy-900">
                {issued ? "The issued document" : "Preview"}
              </h2>
              <p className="mt-1 text-xs text-navy-600">
                Drawn from the same instructions as the PDF, so this is the page
                that is issued.
              </p>

              {preview && (
                <>
                  {preview.warnings.length > 0 && (
                    <p
                      role="alert"
                      className="mt-2 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-3 py-2 text-xs font-semibold text-navy-900"
                    >
                      {preview.warnings.join(" ")}
                    </p>
                  )}
                  <div
                    data-testid="invoice-preview"
                    className="mt-3 overflow-hidden rounded-xl border-2 border-navy-200"
                    dangerouslySetInnerHTML={{ __html: preview.svg }}
                  />
                </>
              )}

              {invoice.documentId && (
                <a
                  href={`/api/documents/${invoice.documentId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-block rounded-xl border-2 border-navy-200 px-4 py-2 text-sm font-bold text-navy-900 hover:border-flame-500"
                >
                  Open the stored PDF
                </a>
              )}
            </section>

            {editable && preview && (
              <IssueInvoice
                invoiceId={invoice.id}
                blockers={preview.blockers}
                warnings={preview.warnings}
              />
            )}

            {issued && (
              <SendInvoice
                invoiceId={invoice.id}
                recipients={recipients}
                history={history}
              />
            )}

            {(invoice.status === "issued" || invoice.status === "sent") && (
              <MarkPaid invoiceId={invoice.id} />
            )}

            {invoice.status !== "void" && (
              <div className="rounded-2xl border-2 border-navy-200 bg-white p-4">
                {editable && !invoice.number ? (
                  <DiscardDraft invoiceId={invoice.id} />
                ) : (
                  <VoidInvoice invoiceId={invoice.id} />
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
