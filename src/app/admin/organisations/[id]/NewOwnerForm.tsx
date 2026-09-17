"use client";

import { useActionState } from "react";

import { createOwnerAction, type ActionState } from "../actions";
import { Field, submitClass } from "../form-parts";

/**
 * Adding the agency's first user.
 *
 * The administrator types the password and communicates it to the agency
 * themselves. Nothing is generated, nothing is displayed back, and nothing is
 * emailed — it goes straight to `hashPassword` on the server and the plain
 * value never leaves that call.
 *
 * A single-use invitation link is the better shape and is V2.9. This is the
 * honest minimum until then, rather than a password mailed in plain text.
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
        <Field
          name="password"
          label="Initial password"
          type="password"
          required
          autoComplete="new-password"
          error={state.errors?.password}
        />
        <Field
          name="passwordConfirm"
          label="Repeat password"
          type="password"
          required
          autoComplete="new-password"
          error={state.errors?.passwordConfirm}
        />
      </div>

      <p className="mt-2 text-xs text-navy-600">
        At least 12 characters. Give it to the agency yourself — it is never
        shown again and never emailed.
      </p>

      <button type="submit" disabled={pending} className={submitClass}>
        {pending ? "Creating…" : "Create owner"}
      </button>
    </form>
  );
}
