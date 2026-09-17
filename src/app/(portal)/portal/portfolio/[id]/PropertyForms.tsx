"use client";

import { useActionState, useState } from "react";

import {
  replaceTenancyAction,
  setComplianceAction,
  updatePropertyAction,
  type ActionState,
} from "../actions";
import { Field, Notice, fieldClass, primaryClass, secondaryClass } from "../form-parts";

/**
 * The editable parts of a property.
 *
 * Each form carries the property id in a hidden field. That id is untrusted —
 * the server uses it in a `WHERE` alongside the session's organisation, so one
 * belonging to another agency matches nothing and comes back as "Not found".
 */

export function EditPropertyForm({
  propertyId,
  property,
}: {
  propertyId: string;
  property: {
    houseOrName: string;
    street: string;
    town: string | null;
    postcode: string;
    accessNotes: string | null;
  };
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updatePropertyAction,
    {},
  );
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={secondaryClass}>
        Edit address
      </button>
    );
  }

  return (
    <form action={action} className="mt-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      {state.message && (
        <Notice tone={state.message === "Saved." ? "info" : "error"}>
          {state.message}
        </Notice>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="houseOrName"
          label="House number or name"
          required
          defaultValue={property.houseOrName}
          error={state.errors?.houseOrName}
        />
        <Field
          name="street"
          label="Street"
          required
          defaultValue={property.street}
          error={state.errors?.street}
        />
        <Field name="town" label="Town" defaultValue={property.town ?? ""} />
        <Field
          name="postcode"
          label="Postcode"
          required
          defaultValue={property.postcode}
          error={state.errors?.postcode}
        />
      </div>

      <div className="mt-4">
        <label htmlFor="accessNotes" className="block text-sm font-bold text-navy-900">
          Access notes
        </label>
        <textarea
          id="accessNotes"
          name="accessNotes"
          rows={2}
          defaultValue={property.accessNotes ?? ""}
          className={fieldClass}
        />
      </div>

      <div className="mt-4 flex gap-3">
        <button type="submit" disabled={pending} className={primaryClass}>
          {pending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={secondaryClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Replacing the tenancy.
 *
 * Deliberately worded as a replacement rather than an edit, because that is
 * what it does: the current tenancy is closed and a new one starts. The
 * previous record is kept, so "who did we contact last year" stays answerable.
 */
export function TenancyForm({
  propertyId,
  hasCurrent,
}: {
  propertyId: string;
  hasCurrent: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    replaceTenancyAction,
    {},
  );
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={secondaryClass}>
        {hasCurrent ? "Change tenant" : "Add tenant"}
      </button>
    );
  }

  return (
    <form action={action} className="mt-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      {state.message && <Notice>{state.message}</Notice>}

      {hasCurrent && (
        <p className="mb-4 rounded-xl bg-navy-50 px-4 py-3 text-sm text-navy-700">
          The current tenancy will be closed and kept in the history. Leave every
          field blank to record that the property is now empty.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="tenantName" label="Name" error={state.errors?.tenantName} />
        <Field
          name="tenantPhone"
          label="Mobile"
          hint="A mobile, so we can send a scheduling link."
          error={state.errors?.tenantPhone}
        />
        <Field
          name="tenantEmail"
          label="Email"
          type="email"
          error={state.errors?.tenantEmail}
        />
        <Field
          name="tenancyStartedOn"
          label="Tenancy started"
          type="date"
          error={state.errors?.tenancyStartedOn}
        />
      </div>

      <div className="mt-4 flex gap-3">
        <button type="submit" disabled={pending} className={primaryClass}>
          {pending ? "Saving…" : hasCurrent ? "Replace tenancy" : "Add tenant"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={secondaryClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ComplianceForm({
  propertyId,
  dueDate,
}: {
  propertyId: string;
  dueDate: string | null;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    setComplianceAction,
    {},
  );
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={secondaryClass}>
        {dueDate ? "Update certificate date" : "Record certificate date"}
      </button>
    );
  }

  return (
    <form action={action} className="mt-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      {state.message && <Notice>{state.message}</Notice>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="certificateExpiry"
          label="Expires"
          type="date"
          required
          defaultValue={dueDate ?? ""}
          error={state.errors?.certificateExpiry}
        />
        <Field
          name="lastInspection"
          label="Last inspected"
          type="date"
          hint="Only if you have it."
          error={state.errors?.lastInspection}
        />
      </div>

      <div className="mt-4 flex gap-3">
        <button type="submit" disabled={pending} className={primaryClass}>
          {pending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={secondaryClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}
