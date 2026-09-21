"use client";

import { useActionState, useState } from "react";

import {
  createLandlordAction,
  updateLandlordAction,
  type ActionState,
} from "../portfolio/actions";
import { Field, Notice, primaryClass, secondaryClass } from "../portfolio/form-parts";

/** A new landlord. The organisation comes from the session, never from here. */
export function NewLandlordForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createLandlordAction,
    {},
  );

  return (
    <form action={action} className="mt-4">
      {state.message && <Notice tone="error">{state.message}</Notice>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="name" label="Name" required error={state.errors?.name} />
        <Field name="company" label="Company" error={state.errors?.company} />
        <Field name="email" label="Email" type="email" error={state.errors?.email} />
        <Field name="phone" label="Phone" error={state.errors?.phone} />
      </div>
      <button type="submit" disabled={pending} className={`mt-4 ${primaryClass}`}>
        {pending ? "Saving…" : "Add landlord"}
      </button>
    </form>
  );
}

export function EditLandlordForm({
  landlordId,
  landlord,
}: {
  landlordId: string;
  landlord: {
    name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
  };
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateLandlordAction,
    {},
  );
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={secondaryClass}>
        Edit landlord
      </button>
    );
  }

  return (
    <form action={action} className="mt-2">
      {/* Untrusted: the server pairs it with the session's organisation. */}
      <input type="hidden" name="landlordId" value={landlordId} />
      {state.message && (
        <Notice tone={state.message === "Saved." ? "info" : "error"}>
          {state.message}
        </Notice>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="name" label="Name" required defaultValue={landlord.name} error={state.errors?.name} />
        <Field name="company" label="Company" defaultValue={landlord.company ?? ""} error={state.errors?.company} />
        <Field name="email" label="Email" type="email" defaultValue={landlord.email ?? ""} error={state.errors?.email} />
        <Field name="phone" label="Phone" defaultValue={landlord.phone ?? ""} error={state.errors?.phone} />
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
