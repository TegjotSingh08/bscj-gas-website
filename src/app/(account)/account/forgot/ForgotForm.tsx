"use client";

import { useActionState } from "react";

import { requestResetAction, type AccountActionState } from "../actions";

const fieldClass =
  "mt-1.5 w-full rounded-xl border-2 border-navy-200 bg-white px-4 py-3 text-base text-navy-900 focus:border-flame-500 focus:outline-none";

/**
 * One field, and no possible error.
 *
 * There is deliberately no error state to render: the action redirects to the
 * confirmation whatever happened, because a form that can say "no such
 * account" is a form that enumerates accounts.
 */
export function ForgotForm() {
  const [, action, pending] = useActionState<AccountActionState, FormData>(
    requestResetAction,
    {},
  );

  return (
    <form action={action} className="mt-6">
      <label htmlFor="email" className="block text-sm font-bold text-navy-900">
        Email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="username"
        required
        className={fieldClass}
      />

      <button
        type="submit"
        disabled={pending}
        className="mt-6 w-full rounded-xl bg-flame-500 px-6 py-4 text-base font-bold text-white hover:bg-flame-600 disabled:opacity-60"
      >
        {pending ? "Sending…" : "Send me a link"}
      </button>
    </form>
  );
}
