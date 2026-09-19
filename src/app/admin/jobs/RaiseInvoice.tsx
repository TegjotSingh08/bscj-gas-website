"use client";

import { useActionState } from "react";

import { createDraftAction, type ActionState } from "../invoices/actions";

/**
 * Raising an invoice from the job it is for.
 *
 * One button, because there is nothing to decide here: the draft is built from
 * what the job already holds, and every choice — the payer, the lines, the
 * charges — is made on the draft afterwards, where the figures are on screen.
 *
 * It is offered only for completed work. Invoicing a job that has not happened
 * is not something this application has been asked to do, and the lifecycle
 * already records when it did.
 */
export function RaiseInvoice({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createDraftAction,
    {},
  );

  return (
    <form action={action} className="mt-3">
      <input type="hidden" name="jobId" value={jobId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600 disabled:opacity-60"
      >
        {pending ? "Raising…" : "Raise an invoice"}
      </button>

      {state.error && (
        <p
          role="alert"
          className="mt-2 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {state.error}
        </p>
      )}
    </form>
  );
}
