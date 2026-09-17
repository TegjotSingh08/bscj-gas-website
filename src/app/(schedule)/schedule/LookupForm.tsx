"use client";

import { useActionState } from "react";

import { lookupJobAction, type LookupState } from "./actions";

const fieldClass =
  "mt-1.5 w-full rounded-xl border-2 border-navy-200 bg-white px-4 py-3 text-base text-navy-900 focus:border-flame-500 focus:outline-none";

/**
 * Finding an appointment by hand.
 *
 * Every failure says the same thing, because the server answers every failure
 * the same way. See `actions.ts`.
 */
export function LookupForm({ hadProblem }: { hadProblem: boolean }) {
  const [state, action, pending] = useActionState<LookupState, FormData>(
    lookupJobAction,
    { failed: hadProblem },
  );

  return (
    <form action={action} className="mt-6">
      {state.failed && (
        <p
          role="alert"
          className="mb-4 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          We could not find an appointment with those details. Please check the
          reference and postcode on your letter.
        </p>
      )}

      <div>
        <label htmlFor="reference" className="block text-sm font-bold text-navy-900">
          Reference
        </label>
        <input
          id="reference"
          name="reference"
          required
          autoComplete="off"
          placeholder="BSCJ-XXXXXX"
          className={fieldClass}
        />
      </div>

      <div className="mt-4">
        <label htmlFor="postcode" className="block text-sm font-bold text-navy-900">
          Property postcode
        </label>
        <input
          id="postcode"
          name="postcode"
          required
          autoComplete="postal-code"
          className={fieldClass}
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="mt-6 w-full rounded-xl bg-flame-500 px-6 py-4 text-base font-bold text-white hover:bg-flame-600 disabled:opacity-60"
      >
        {pending ? "Checking…" : "Find my appointment"}
      </button>
    </form>
  );
}
