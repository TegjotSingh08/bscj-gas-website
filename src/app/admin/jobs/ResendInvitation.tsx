"use client";

import { useActionState } from "react";

import { resendInvitationAction, type ResendState } from "./actions";

/**
 * The resend control.
 *
 * Deliberately a button that *queues* rather than one that sends: the outbox
 * is the only thing that talks to the provider, so a message raised here goes
 * through the same claiming, retry and staleness rules as every other. The
 * status of what it queued is the list beside it.
 */
export function ResendInvitation({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState<ResendState, FormData>(
    resendInvitationAction,
    {},
  );

  return (
    <form action={action} className="mt-3">
      <input type="hidden" name="jobId" value={jobId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-xl border-2 border-navy-300 bg-white px-4 py-2 text-sm font-bold text-navy-900 hover:border-flame-500 disabled:opacity-60"
      >
        {pending ? "Queueing…" : "Send the tenant their link again"}
      </button>

      {state.message && (
        <p role="status" className="mt-2 text-sm font-semibold text-navy-900">
          {state.message}
        </p>
      )}
      {state.error && (
        <p role="alert" className="mt-2 text-sm font-semibold text-flame-600">
          {state.error}
        </p>
      )}
    </form>
  );
}
