"use client";

import { useActionState } from "react";

import { setPasswordAction, type AccountActionState } from "../actions";

/**
 * The password form.
 *
 * **It carries no identifier.** No user id, no email, no token — the account
 * is named by the httpOnly cookie the server already holds, which is what
 * makes "set somebody else's password" not a request this form can express,
 * whatever is typed into it or posted directly at the action.
 *
 * `autoComplete="new-password"` on both fields so a password manager offers to
 * generate and save one rather than filling in the old one.
 */

const fieldClass =
  "mt-1.5 w-full rounded-xl border-2 border-navy-200 bg-white px-4 py-3 text-base text-navy-900 focus:border-flame-500 focus:outline-none";

export function SetPasswordForm({
  isInvitation,
  minLength,
}: {
  isInvitation: boolean;
  minLength: number;
}) {
  const [state, action, pending] = useActionState<AccountActionState, FormData>(
    setPasswordAction,
    {},
  );

  return (
    <form action={action} className="mt-6">
      {state.error && (
        <p
          role="alert"
          className="mb-4 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {state.error}
        </p>
      )}

      <div>
        <label
          htmlFor="password"
          className="block text-sm font-bold text-navy-900"
        >
          {isInvitation ? "Password" : "New password"}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          required
          className={fieldClass}
        />
      </div>

      <div className="mt-4">
        <label
          htmlFor="passwordConfirm"
          className="block text-sm font-bold text-navy-900"
        >
          Repeat it
        </label>
        <input
          id="passwordConfirm"
          name="passwordConfirm"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          required
          className={fieldClass}
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="mt-6 w-full rounded-xl bg-flame-500 px-6 py-4 text-base font-bold text-white hover:bg-flame-600 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save password"}
      </button>
    </form>
  );
}
