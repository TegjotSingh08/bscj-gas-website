import type { Metadata } from "next";
import Link from "next/link";

import { requireAdmin } from "@/lib/auth/session";
import { readReconcileQueue } from "@/lib/ops/reconcile";
import {
  LEASE_SECONDS,
  listOutstandingNotifications,
} from "@/lib/notifications/outbox";
import { queueStateOf } from "@/lib/notifications/queue-state";
import {
  listOutstandingRenewals,
  type OutstandingRenewals,
  type RenewalCursor,
} from "@/lib/compliance/outstanding";
import { ReconcileRunner } from "./ReconcileRunner";
import { MessageQueue, type QueueRow } from "./MessageQueue";
import { StalledSubmissions } from "./StalledSubmissions";
import { listStalledSubmissions } from "@/lib/documents/certificate-drafts";
import { summariseReconcile } from "./summary";

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
export default async function ReconcilePage({
  searchParams,
}: {
  /*
    Where a previous traversal stopped. The renewals walk is bounded, and a
    bound that could not be continued past would be a bound that hides work.
  */
  searchParams: Promise<{ afterIssuedAt?: string; afterCertificate?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const after: RenewalCursor | null =
    params.afterIssuedAt && params.afterCertificate
      ? {
          issuedAt: params.afterIssuedAt,
          certificateId: params.afterCertificate,
        }
      : null;
  const queue = await readReconcileQueue();

  /*
    Every message still owed, row by row. The counts above answer "is anything
    wrong"; this answers "what, and what do I do about it" — which is what the
    pilot's green dashboard over an undrained queue could not.
  */
  /*
    Certificates released whose renewal did not land. Derived from the records —
    an issued certificate with no active position pointing at it — so it
    survives a refresh, a closed tab and a different administrator tomorrow.
    The release's own response could not.
  */
  const renewals = await listOutstandingRenewals(after ? { after } : {});

  /*
    **Null is not zero.** A failed query used to fall through `?.length ?? 0`
    into "nothing outstanding", which is the single most dangerous sentence
    this page can print: it reports the one state it does not know as the one
    state that needs no action. Unknown gets its own alert, and it withholds
    the reassurance.
  */
  /*
    Certificate submissions that claimed a job and never finished. Derived
    from the rows, like everything else here, so it is still true after a
    refresh and for whoever opens this page tomorrow.
  */
  const stalled = await listStalledSubmissions();

  const now = new Date();
  const outstanding = await listOutstandingNotifications();
  const messageRows: QueueRow[] = (outstanding ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    recipient: row.recipient,
    jobId: row.jobId,
    jobReference: row.jobReference,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString().slice(0, 16).replace("T", " "),
    queueState: queueStateOf(
      {
        state: row.state as "pending" | "failed",
        attempts: row.attempts,
        lastError: row.lastError,
        updatedAt: row.updatedAt,
      },
      { leaseSeconds: LEASE_SECONDS, now },
    ),
  }));

  const { nothingOutstanding, everythingKnown } = summariseReconcile({
    renewals,
    continued: after !== null,
    messagesReadable: outstanding !== null,
    reservationsListed: queue.unpersistedListed,
    counts: {
      stalledSubmissions: stalled?.length ?? 0,
      awaitingCalendarSync: queue.awaitingCalendarSync.length,
      awaitingCalendarCleanup: queue.awaitingCalendarCleanup.length,
      unpersistedBookings: queue.unpersistedBookings.length,
      pendingNotifications: queue.notifications.pending,
      failedNotifications: queue.notifications.failed,
    },
  });

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

      {outstanding === null && (
        <p
          role="alert"
          className="mt-6 rounded-2xl border-2 border-flame-500 bg-flame-400/10 px-5 py-4 text-sm font-semibold text-navy-900"
        >
          The message queue could not be read. Messages still owed are{" "}
          <strong>unknown</strong> rather than none — this page cannot tell you
          the queue is empty.
        </p>
      )}

      {stalled === null && (
        <p
          role="alert"
          className="mt-6 rounded-2xl border-2 border-flame-500 bg-flame-400/10 px-5 py-4 text-sm font-semibold text-navy-900"
        >
          Certificate submissions could not be read. Records an engineer began
          sending and did not finish are <strong>unknown</strong> rather than
          none.
        </p>
      )}

      {renewals === null && (
        <p
          role="alert"
          className="mt-6 rounded-2xl border-2 border-flame-500 bg-flame-400/10 px-5 py-4 text-sm font-semibold text-navy-900"
        >
          The compliance records could not be read. Certificates released
          without their renewal are <strong>unknown</strong> rather than none —
          this page cannot tell you there are no repairs outstanding.
        </p>
      )}

      {nothingOutstanding ? (
        <p className="mt-6 rounded-2xl border-2 border-navy-200 bg-white px-5 py-4 text-sm font-semibold text-navy-900">
          {everythingKnown
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
          {renewals && (
            <OutstandingRenewals renewals={renewals} continued={after !== null} />
          )}
          <StalledSubmissions rows={stalled ?? []} />
          <MessageQueue rows={messageRows} />
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
 * Certificates released whose renewal did not move.
 *
 * The release and the compliance write cannot be one statement — the cycle has
 * to point at the certificate's id, which does not exist until the certificate
 * is inserted — so this state is genuinely reachable. It is derived from the
 * rows rather than remembered, which is what makes it still here after a
 * refresh, and the fix is on the job: one idempotent button.
 *
 * **It renders when the answer is incomplete, not only when it is non-empty.**
 * The traversal behind it is bounded, and a bound reached in silence would
 * hide exactly what this section exists to show. So an incomplete answer says
 * so and offers the continuation, even with nothing to list.
 */
function OutstandingRenewals({
  renewals,
  continued,
}: {
  renewals: OutstandingRenewals;
  /** This page began at a cursor, so it covers only part of the ordering. */
  continued: boolean;
}) {
  const { rows, stoppedBecause, cursor, examined } = renewals;

  /*
    An empty, finished, **first** page is genuinely nothing to show. An empty
    finished *continuation* is not: it means "nothing after that position",
    and disappearing would leave the reader believing they had seen the
    whole list. So a continuation always renders, if only to say what it
    covered and offer the way back.
  */
  if (rows.length === 0 && stoppedBecause === "exhausted" && !continued) {
    return null;
  }

  const continueHref = cursor
    ? `/admin/reconcile?afterIssuedAt=${encodeURIComponent(cursor.issuedAt)}&afterCertificate=${encodeURIComponent(cursor.certificateId)}`
    : null;

  return (
    <section className="rounded-2xl border-2 border-flame-500 bg-flame-400/5 p-5">
      <h2 className="text-sm font-extrabold text-navy-900">
        Certificates released without their renewal ({rows.length}
        {stoppedBecause === "exhausted" ? "" : " so far"})
      </h2>

      {continued && (
        <p
          role="status"
          className="mt-2 rounded-xl border-2 border-navy-300 bg-white px-4 py-3 text-xs leading-relaxed text-navy-800"
        >
          <strong>This is a continuation.</strong> It covers only certificates
          issued after the point the previous page stopped at. Anything earlier
          was not looked at here, so reaching the end of this list does{" "}
          <strong>not</strong> mean there is nothing outstanding.{" "}
          <Link
            href="/admin/reconcile"
            className="font-bold text-flame-600 underline"
          >
            Back to the start
          </Link>
          .
        </p>
      )}
      {rows.length > 0 && (
        <p className="mt-1 text-xs leading-relaxed text-navy-700">
          Each of these is a released certificate whose property&rsquo;s
          next-due date did not move — the second write did not land. The
          document is genuinely released; only the renewal is missing. Open the
          job and press
          <span className="font-bold">
            {" "}
            Update the renewal from this certificate
          </span>
          , which is safe to press at any time.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li key={row.certificateId} className="text-sm">
              <Link
                href={`/admin/jobs/${row.jobId}`}
                className="font-bold text-navy-900 underline"
              >
                {row.jobReference}
              </Link>
              <span className="text-navy-700">
                {" "}
                — {row.houseOrName}, {row.postcode} · certificate{" "}
                {row.certificateNumber} v{row.version}, due {row.nextDueDate}
              </span>
            </li>
          ))}
        </ul>
      )}

      {rows.length === 0 && stoppedBecause === "exhausted" && (
        <p className="mt-3 text-sm font-semibold text-navy-900">
          No repairs after that point. Earlier ones, if any, are still on the
          pages before this.
        </p>
      )}

      {stoppedBecause !== "exhausted" && continueHref && (
        <p
          role="status"
          className="mt-4 rounded-xl border-2 border-navy-200 bg-white px-4 py-3 text-xs leading-relaxed text-navy-800"
        >
          {stoppedBecause === "limit"
            ? `This is a full page of repairs. ${examined.toLocaleString("en-GB")} certificates were examined to find them, and there may be more behind these.`
            : `The search stopped after examining ${examined.toLocaleString("en-GB")} certificates, before reaching the end. There may be more repairs beyond this point — this section has not ruled them out.`}{" "}
          <Link
            href={continueHref}
            className="font-bold text-flame-600 underline"
          >
            Continue from here
          </Link>
          .
        </p>
      )}
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
