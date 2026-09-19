import type { Metadata } from "next";

import { requireAdmin } from "@/lib/auth/session";
import { invoiceConfiguration } from "@/lib/invoices/invoices";
import { AdminNav } from "../AdminNav";
import { BusinessDetailsForm } from "./BusinessDetailsForm";

export const metadata: Metadata = {
  title: "Business details",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * The facts a person has to supply.
 *
 * This screen exists because of a rule rather than a feature: nothing in this
 * application invents who BSCJ is, what its payment terms are or where money
 * should be sent. Those are configuration, empty until somebody fills them in,
 * and until they are filled in no invoice can be issued.
 *
 * It is deliberately narrow — the fields an invoice needs, and nothing else.
 * The VAT position is shown and is **not** editable here: BSCJ is not
 * registered, the model supports registration in full, and switching it on is
 * a decision with a rate and a date that affects every document issued
 * afterwards.
 */
export default async function AdminSettingsPage() {
  const { user } = await requireAdmin();
  const config = await invoiceConfiguration();

  return (
    <>
      <AdminNav userName={user.name} current="settings" />

      <main className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="text-2xl font-extrabold text-navy-900">
          Business details
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-navy-700">
          What appears on an invoice. Each invoice takes a copy of these when it
          is issued, so changing them here never rewrites a document already in
          somebody&rsquo;s accounts.
        </p>

        {config.missing.length > 0 ? (
          <p
            role="alert"
            data-testid="settings-missing"
            className="mt-4 rounded-2xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
          >
            Invoices cannot be issued while these are empty:{" "}
            {config.missing.join(", ")}. Drafts can still be prepared.
          </p>
        ) : (
          <p
            data-testid="settings-complete"
            className="mt-4 rounded-2xl border-2 border-navy-200 bg-navy-50 px-4 py-3 text-sm font-semibold text-navy-900"
          >
            Everything an invoice needs is configured.
          </p>
        )}

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">VAT</h2>
          <p className="mt-1 text-sm text-navy-700">
            {config.vat.registered
              ? `Registered — ${config.vat.number}. VAT is charged and shown on every invoice.`
              : "Not registered. No VAT line, no VAT number and no mention of VAT appears on anything."}
          </p>
          <p className="mt-2 text-xs text-navy-600">
            Not editable here. Registering changes every document issued
            afterwards and needs a rate and a date, so it is a deliberate change
            rather than a checkbox.
          </p>
        </section>

        <BusinessDetailsForm
          identity={config.identity}
          terms={config.terms}
          missing={config.missing}
        />

        <section className="mt-6 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">
            Document storage
          </h2>
          <p className="mt-1 text-sm text-navy-700">
            {config.storageReady
              ? "Configured. Issued invoices and certificates are kept privately."
              : config.storageRequirement}
          </p>
        </section>
      </main>
    </>
  );
}
