"use client";

import { useActionState } from "react";

import { createOwnerAction, type ActionState } from "../actions";
import { Field, submitClass } from "../form-parts";

/**
 * Adding the agency's first user.
 *
 * **No password field.** It used to have two, typed by the administrator, who
 * then had to get the password to the agency somehow — and every "somehow" is
 * a password sitting in a text message or an inbox. The account is created
 * without one and an expiring, single-use invitation goes out; the person
 * chooses their own, and nobody at BSCJ ever sees it.
 */
export function NewOwnerForm({ organisationId }: { organisationId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createOwnerAction,
    {},
  );

  return (
    <form action={action} className="mt-4">
      <input type="hidden" name="organisationId" value={organisationId} />

      {state.message && (
        <p
          role="status"
          className="mb-4 rounded-xl border-2 border-navy-200 bg-navy-50 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {state.message}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="name" label="Full name" required error={state.errors?.name} />
        <Field
          name="email"
          label="Email"
          type="email"
          required
          autoComplete="off"
          error={state.errors?.email}
        />
      </div>

      <p className="mt-3 text-xs text-navy-600">
        Check the address carefully — the invitation goes there and nowhere
        else. It carries no password: they choose their own, and it stops
        working once used or after 14 days.
      </p>

      <button type="submit" disabled={pending} className={submitClass}>
        {pending ? "Creating…" : "Create user and invite"}
      </button>
    </form>
  );
}
