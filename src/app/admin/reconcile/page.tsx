import type { Metadata } from "next";
import Link from "next/link";

import { requireAdmin } from "@/lib/auth/session";
import { readReconcileQueue } from "@/lib/ops/reconcile";
import { ReconcileRunner } from "./ReconcileRunner";

export const metadata: Metadata = {
  title: "Reconciliation",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * What an external service could not finish.
 *
 * Postgres cannot make a Google Calendar write or an email send part of its
 * transaction, so every one of them records its **intent** durably and its
 * **outcome** separately. This is where the gap between the two is visible,
 * and — the part that matters — closable. A queue that could only be read
 * would be a list of problems with no button.
 *
 * Nothing here is customer-facing and nothing here is indexed. References and
 * idempotency keys are opaque labels; no name, address or contact detail
 * appears on this page.
 */
export default async function ReconcilePage() {
  await requireAdmin();
  const queue = await readReconcileQueue();

  const nothingOutstanding =
    queue.awaitingCalendarSync.length === 0 &&
    queue.awaitingCalendarCleanup.length === 0 &&
    queue.unpersistedBookings.length === 0 &&
    queue.notifications.pending === 0 &&
    queue.notifications.failed === 0;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <p className="text-xs font-bold uppercase tracking-wider text-flame-600">
        BSCJ Admin
      </p>
      <h1 className="mt-1 text-2xl font-extrabold text-navy-900 sm:text-3xl">
        Reconciliation
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-navy-700">
        Appointments whose calendar entry has not been written, calendar entries
        left behind by a change of time, and bookings that exist in the calendar
        but were never recorded here. Running the sweep writes what should
        already have been written. It never creates a second appointment and
        never sends a customer anything.
      </p>

      <ReconcileRunner />

      {/*
        Shown whenever the store could not be read, not only when everything
        else happens to be empty. It used to sit inside the "nothing
        outstanding" branch, so a page with any other queue on it reported
        unrecorded bookings as absent when they were merely unknown — which is
        the one thing this page exists not to do.
      */}
      {!queue.unpersistedListed && (
        <p
          role="alert"
          className="mt-6 rounded-2xl border-2 border-flame-500 bg-flame-400/10 px-5 py-4 text-sm font-semibold text-navy-900"
        >
          The reservation store could not be listed. Bookings that were never
          recorded here are <strong>unknown</strong> rather than absent — this
          page cannot tell you there are none.
        </p>
      )}

      {nothingOutstanding ? (
        <p className="mt-6 rounded-2xl border-2 border-navy-200 bg-white px-5 py-4 text-sm font-semibold text-navy-900">
          {queue.unpersistedListed
            ? "Nothing outstanding."
            : "Nothing outstanding that this page can see."}
        </p>
      ) : (
        <div className="mt-8 grid gap-5">
          <Queue
            title="Appointments not yet in the calendar"
            note="The slot stays reserved while this is outstanding, so nobody else is offered it."
            rows={queue.awaitingCalendarSync.map((job) => job.reference)}
          />
          <Queue
            title="Calendar entries to remove"
            note="A time was changed and the entry it replaced is still in the diary."
            rows={queue.awaitingCalendarCleanup.map((job) => job.reference)}
          />
          <Queue
            title="Bookings not recorded here"
            note="The appointment exists in the calendar and the customer has their confirmation. Only our own record is missing."
            rows={queue.unpersistedBookings}
          />
          <NotificationQueue notifications={queue.notifications} />
        </div>
      )}

      <p className="mt-8 text-sm">
        <Link href="/admin" className="font-bold text-flame-600 underline">
          Back to the dashboard
        </Link>
      </p>
    </main>
  );
}

/**
 * The email outbox, by state.
 *
 * "Queued" and "given up" are separated because they need different actions,
 * and a missing address is called out by name: it is a deployment gap that
 * would otherwise read as an ordinary failure and be retried forever.
 */
function NotificationQueue({
  notifications,
}: {
  notifications: { pending: number; failed: number; missingRecipient: number };
}) {
  if (notifications.pending === 0 && notifications.failed === 0) return null;

  return (
    <section className="rounded-2xl border-2 border-navy-200 bg-white p-5">
      <h2 className="text-sm font-extrabold text-navy-900">
        Messages not yet sent ({notifications.pending + notifications.failed})
      </h2>
      <p className="mt-1 text-xs text-navy-600">
        Tenant invitations, appointment confirmations and late-booking alerts.
        A message is only ever described as <em>accepted by the provider</em> —
        nothing here knows whether it arrived.
      </p>
      <ul className="mt-3 grid gap-1 text-sm text-navy-800">
        <li>{notifications.pending} queued, waiting to be sent</li>
        <li>{notifications.failed} given up on — these need a person</li>
        {notifications.missingRecipient > 0 && (
          <li className="font-bold text-flame-600">
            {notifications.missingRecipient} cannot be sent: no address is
            configured for that recipient
          </li>
        )}
      </ul>
    </section>
  );
}

function Queue({
  title,
  note,
  rows,
}: {
  title: string;
  note: string;
  rows: string[];
}) {
  if (rows.length === 0) return null;

  return (
    <section className="rounded-2xl border-2 border-navy-200 bg-white p-5">
      <h2 className="text-sm font-extrabold text-navy-900">
        {title} ({rows.length})
      </h2>
      <p className="mt-1 text-xs text-navy-600">{note}</p>
      <ul className="mt-3 grid gap-1">
        {rows.map((row) => (
          <li key={row} className="font-mono text-xs text-navy-800">
            {row}
          </li>
        ))}
      </ul>
    </section>
  );
}
