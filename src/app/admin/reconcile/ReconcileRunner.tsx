"use client";

import { useActionState } from "react";

import { runReconciliationAction, type ReconcileState } from "./actions";

/**
 * The button that actually finishes the work.
 *
 * A queue that can only be looked at is a list of things nobody can do
 * anything about, which is why this exists at all rather than a read-only
 * page. The sweep is bounded, so a long backlog is worked a batch at a time
 * and the page can simply be run again.
 */
export function ReconcileRunner() {
  const [state, action, pending] = useActionState<ReconcileState, FormData>(
    () => runReconciliationAction(),
    {},
  );

  return (
    <form action={action} className="mt-5">
      <button
        type="submit"
        disabled={pending}
        className="rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600 disabled:opacity-60"
      >
        {pending ? "Working…" : "Run reconciliation now"}
      </button>

      {state.error && (
        <p
          role="alert"
          className="mt-4 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {state.error}
        </p>
      )}

      {state.report && (
        <dl
          role="status"
          className="mt-4 grid gap-2 rounded-xl border-2 border-navy-200 bg-navy-50 px-4 py-3 text-sm text-navy-800 sm:grid-cols-2"
        >
          <Line
            label="Calendar writes"
            value={`${state.report.calendarSync.synced} done, ${state.report.calendarSync.failed} still failing`}
          />
          <Line
            label="Old events removed"
            value={`${state.report.calendarCleanup.cleaned} of ${state.report.calendarCleanup.considered}`}
          />
          <Line
            label="Bookings recorded"
            value={
              state.report.bookingRecovery.listed
                ? `${state.report.bookingRecovery.recovered} of ${state.report.bookingRecovery.considered}`
                : "store could not be listed"
            }
          />
          <Line
            label="Alerts accepted"
            value={
              /*
                "Accepted by the provider" is the furthest thing we know. It is
                not a delivery receipt and is never described as one.
              */
              `${state.report.notifications.accepted} of ${state.report.notifications.considered} accepted by the provider`
            }
          />
        </dl>
      )}
    </form>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
        {label}
      </dt>
      <dd className="mt-0.5 font-semibold text-navy-900">{value}</dd>
    </div>
  );
}
