"use client";

import { useActionState } from "react";

import { saveBusinessDetailsAction, type SettingsState } from "./actions";
import type {
  BusinessIdentity,
  InvoiceTerms,
} from "@/lib/settings/business-identity";

/**
 * The business details form.
 *
 * Fields required before an invoice may be issued are marked as such, and the
 * marking comes from `missingInvoiceIdentityFields` rather than from a list
 * typed here — one place decides what is required, and this screen reports it.
 *
 * Nothing is prefilled with an example. The placeholders are deliberately
 * shapes rather than values: a placeholder that looks like a real company name
 * is one somebody will eventually save by accident.
 */

const field =
  "mt-1 w-full rounded-xl border-2 border-navy-200 bg-white px-3 py-2 text-sm font-semibold text-navy-900 focus:border-flame-500";

function Field({
  id,
  label,
  hint,
  required,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-xs font-bold uppercase tracking-wide text-navy-600"
      >
        {label}
        {required && (
          <span className="ml-2 rounded-full bg-flame-400/20 px-2 py-0.5 text-[10px] font-bold text-flame-700">
            Required to issue
          </span>
        )}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-navy-600">{hint}</p>}
    </div>
  );
}

export function BusinessDetailsForm({
  identity,
  terms,
  missing,
}: {
  identity: BusinessIdentity;
  terms: InvoiceTerms;
  missing: string[];
}) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(
    saveBusinessDetailsAction,
    {},
  );

  const required = (name: string) => missing.includes(name);

  return (
    <form action={action} className="mt-6 grid gap-6">
      {state.error && (
        <p
          role="alert"
          className="rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {state.error}
        </p>
      )}
      {state.message && (
        <p
          role="status"
          className="rounded-xl border-2 border-navy-200 bg-navy-50 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {state.message}
        </p>
      )}

      <fieldset className="rounded-2xl border-2 border-navy-200 bg-white p-5">
        <legend className="px-2 text-sm font-extrabold text-navy-900">
          Who is issuing
        </legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="displayName"
            label="Trading name, as printed"
            required={required("displayName")}
            hint="The large name at the top of the invoice."
          >
            <input
              id="displayName"
              name="displayName"
              defaultValue={identity.displayName ?? ""}
              className={field}
            />
          </Field>

          <Field
            id="legalName"
            label="Legal entity"
            required={required("legalName")}
            hint="The entity that is actually contracting. It may differ from the trading name, and is expected to change."
          >
            <input
              id="legalName"
              name="legalName"
              defaultValue={identity.legalName ?? ""}
              className={field}
            />
          </Field>

          <Field id="tradingName" label="Alternative trading name">
            <input
              id="tradingName"
              name="tradingName"
              defaultValue={identity.tradingName ?? ""}
              className={field}
            />
          </Field>

          <Field id="companyNumber" label="Company number">
            <input
              id="companyNumber"
              name="companyNumber"
              defaultValue={identity.companyNumber ?? ""}
              className={field}
            />
          </Field>

          <Field
            id="addressLines"
            label="Address"
            required={required("addressLines")}
            hint="One line per line."
          >
            <textarea
              id="addressLines"
              name="addressLines"
              rows={3}
              defaultValue={identity.addressLines.join("\n")}
              className={field}
            />
          </Field>

          <div className="grid gap-4">
            <Field id="postcode" label="Postcode" required={required("postcode")}>
              <input
                id="postcode"
                name="postcode"
                defaultValue={identity.postcode ?? ""}
                className={field}
              />
            </Field>
            <Field id="gasSafeNumber" label="Gas Safe registration">
              <input
                id="gasSafeNumber"
                name="gasSafeNumber"
                defaultValue={identity.gasSafeNumber ?? ""}
                className={field}
              />
            </Field>
          </div>

          <Field id="phone" label="Telephone, as printed">
            <input
              id="phone"
              name="phone"
              defaultValue={identity.phone ?? ""}
              className={field}
            />
          </Field>

          <Field
            id="email"
            label="Email, as printed"
            required={required("email")}
          >
            <input
              id="email"
              name="email"
              type="email"
              defaultValue={identity.email ?? ""}
              className={field}
            />
          </Field>

          <Field id="website" label="Website">
            <input
              id="website"
              name="website"
              defaultValue={identity.website ?? ""}
              className={field}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-2xl border-2 border-navy-200 bg-white p-5">
        <legend className="px-2 text-sm font-extrabold text-navy-900">
          The three lines under the name
        </legend>
        <p className="text-sm text-navy-700">
          Optional, and empty by default. The existing invoice layout has room
          for them; nothing is printed that has not been typed here.
        </p>

        <div className="mt-4 grid gap-4">
          <Field id="tagline" label="Tagline">
            <input
              id="tagline"
              name="tagline"
              defaultValue={identity.tagline ?? ""}
              className={field}
            />
          </Field>
          <Field
            id="qualifications"
            label="Qualifications"
            hint="Printed exactly as typed. Nothing here is checked against any register."
          >
            <input
              id="qualifications"
              name="qualifications"
              defaultValue={identity.qualifications ?? ""}
              className={field}
            />
          </Field>
          <Field
            id="serviceLines"
            label="Services strapline"
            hint="At most two lines; the layout has room for two."
          >
            <textarea
              id="serviceLines"
              name="serviceLines"
              rows={2}
              defaultValue={identity.serviceLines.join("\n")}
              className={field}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-2xl border-2 border-navy-200 bg-white p-5">
        <legend className="px-2 text-sm font-extrabold text-navy-900">
          Payment and wording
        </legend>

        <div className="grid gap-4">
          <Field
            id="paymentInstructions"
            label="How to pay"
            required={required("paymentInstructions")}
            hint="Printed in the footer, at most three lines. Bank details live here, not in the code."
          >
            <textarea
              id="paymentInstructions"
              name="paymentInstructions"
              rows={3}
              defaultValue={terms.paymentInstructions ?? ""}
              className={field}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="paymentTerms"
              label="Payment terms, as printed"
              required={required("paymentTerms")}
            >
              <input
                id="paymentTerms"
                name="paymentTerms"
                defaultValue={terms.paymentTerms ?? ""}
                className={field}
              />
            </Field>

            <Field
              id="paymentDueDays"
              label="Days to pay"
              hint="Optional. Leave empty and no due date is printed — nothing is assumed."
            >
              <input
                id="paymentDueDays"
                name="paymentDueDays"
                inputMode="numeric"
                defaultValue={terms.paymentDueDays ?? ""}
                className={field}
              />
            </Field>
          </div>

          <Field
            id="footerText"
            label="Footer wording"
            required={required("footerText")}
            hint="One line at the very bottom of the page."
          >
            <input
              id="footerText"
              name="footerText"
              defaultValue={identity.footerText ?? ""}
              className={field}
            />
          </Field>
        </div>
      </fieldset>

      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save business details"}
        </button>
      </div>
    </form>
  );
}
