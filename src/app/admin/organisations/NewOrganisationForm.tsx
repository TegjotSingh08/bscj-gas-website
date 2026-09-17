"use client";

import { useActionState } from "react";

import { createOrganisationAction, type ActionState } from "./actions";
import { Field, fieldClass, submitClass } from "./form-parts";

/**
 * Opening an agency account.
 *
 * The validation shown here is a convenience. The action re-runs every rule
 * against the submitted form, so a browser that skips this gets exactly the
 * same answers — see `lib/organisations/validation.ts`.
 */
export function NewOrganisationForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createOrganisationAction,
    {},
  );

  return (
    <form action={action} className="mt-5">
      {state.message && (
        <p
          role="alert"
          className="mb-4 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {state.message}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="name"
          label="Agency name"
          required
          error={state.errors?.name}
        />
        <Field
          name="email"
          label="Contact email"
          type="email"
          required
          error={state.errors?.email}
        />
        <Field name="phone" label="Phone" error={state.errors?.phone} />
        <Field
          name="legalName"
          label="Legal entity"
          error={state.errors?.legalName}
        />
        <Field
          name="companyNumber"
          label="Company number"
          error={state.errors?.companyNumber}
        />
        <Field name="billingLine1" label="Billing address line 1" />
        <Field name="billingLine2" label="Billing address line 2" />
        <Field name="billingTown" label="Town" />
        <Field name="billingPostcode" label="Postcode" />
      </div>

      <div className="mt-4">
        <label htmlFor="notes" className="block text-sm font-bold text-navy-900">
          Internal notes
        </label>
        <textarea id="notes" name="notes" rows={3} className={fieldClass} />
        <p className="mt-1 text-xs text-navy-600">
          Never shown to the agency.
        </p>
      </div>

      <button type="submit" disabled={pending} className={submitClass}>
        {pending ? "Creating…" : "Create agency"}
      </button>
    </form>
  );
}
