"use client";

import { useActionState } from "react";
import Link from "next/link";

import { retryNotificationAction, type RetryState } from "./actions";
import {
  QUEUE_STATE_EXPLANATION,
  QUEUE_STATE_LABELS,
  canRetry,
  describeError,
  type QueueState,
} from "@/lib/notifications/queue-state";

/**
 * Every message still owed, one row each, with what to do about it.
 *
 * The pilot's actual failure was a green dashboard over an undrained queue: the
 * counts were there, the reason was not, and the only way to find out was a
 * browser console. Counts answer "is anything wrong"; this answers "what, and
 * what do I do".
 *
 * **No address appears here.** The job reference identifies the work and the
 * recipient is a role. An operational screen does not need anybody's email
 * address to be useful, and putting one on it makes a page that then has to be
 * protected as personal data.
 */

export type QueueRow = {
  id: string;
  kind: string;
  recipient: string | null;
  jobId: string | null;
  jobReference: string | null;
  queueState: QueueState;
  attempts: number;
  lastError: string | null;
  createdAt: string;
};

const KIND_LABELS: Record<string, string> = {
  "tenant-scheduling-invitation": "Invitation to book",
  "tenant-appointment-confirmation": "Appointment confirmation",
  "late-booking-exception": "Late-booking alert",
  "certificate-release": "Certificate",
  "invoice-issue": "Invoice",
  "account-invitation": "Account invitation",
  "account-password-reset": "Password reset",
};

const STATE_TONE: Record<QueueState, string> = {
  queued: "border-navy-200 bg-white",
  attempting: "border-navy-300 bg-navy-50",
  retrying: "border-navy-300 bg-white",
  needs_information: "border-flame-500 bg-flame-400/10",
  accepted: "border-navy-100 bg-white",
  failed: "border-flame-500 bg-flame-400/10",
  cancelled: "border-navy-100 bg-white",
};

export function MessageQueue({ rows }: { rows: QueueRow[] }) {
  if (rows.length === 0) return null;

  const needingAPerson = rows.filter(
    (row) => row.queueState === "failed" || row.queueState === "needs_information",
  ).length;

  return (
    <section className="rounded-2xl border-2 border-navy-200 bg-white p-5">
      <h2 className="text-sm font-extrabold text-navy-900">
        Messages not yet sent ({rows.length})
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-navy-600">
        Tenant invitations, appointment confirmations, certificates, invoices and
        account messages. A message is only ever described as{" "}
        <em>accepted by the email provider</em> — nothing here knows whether it
        arrived in anybody&rsquo;s inbox.
        {needingAPerson > 0 && (
          <>
            {" "}
            <span className="font-bold text-flame-600">
              {needingAPerson} need a person.
            </span>
          </>
        )}
      </p>

      <ul className="mt-4 space-y-3">
        {rows.map((row) => (
          <QueueRowItem key={row.id} row={row} />
        ))}
      </ul>
    </section>
  );
}

function QueueRowItem({ row }: { row: QueueRow }) {
  const [state, action, pending] = useActionState<RetryState, FormData>(
    retryNotificationAction,
    {},
  );

  const reason = describeError(row.lastError);

  return (
    <li className={`rounded-xl border-2 p-4 ${STATE_TONE[row.queueState]}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-navy-900">
            {KIND_LABELS[row.kind] ?? row.kind}
            {row.recipient ? ` → ${row.recipient}` : null}
          </p>
          <p className="mt-0.5 text-xs text-navy-600">
            {row.jobId && row.jobReference ? (
              <Link
                href={`/admin/jobs/${row.jobId}`}
                className="font-bold text-navy-900 underline"
              >
                {row.jobReference}
              </Link>
            ) : (
              "Not about a job"
            )}
            {" · queued "}
            {row.createdAt}
            {row.attempts > 0
              ? ` · ${row.attempts} attempt${row.attempts === 1 ? "" : "s"}`
              : " · not yet attempted"}
          </p>
        </div>

        <span className="rounded-lg border-2 border-current px-2 py-0.5 text-xs font-bold text-navy-900">
          {QUEUE_STATE_LABELS[row.queueState]}
        </span>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-navy-700">
        {QUEUE_STATE_EXPLANATION[row.queueState]}
      </p>

      {reason && (
        <p className="mt-2 rounded-lg border-2 border-navy-200 bg-white px-3 py-2 text-xs text-navy-800">
          <span className="font-bold">Last reason: </span>
          {reason}
        </p>
      )}

      {state.error && (
        <p
          role="alert"
          className="mt-2 rounded-lg border-2 border-flame-500 bg-flame-400/10 px-3 py-2 text-xs font-semibold text-navy-900"
        >
          {state.error}
        </p>
      )}
      {state.message && (
        <p
          role="status"
          className="mt-2 rounded-lg border-2 border-navy-200 bg-navy-50 px-3 py-2 text-xs font-semibold text-navy-900"
        >
          {state.message}
        </p>
      )}

      {/*
        Offered only for a message that has genuinely given up. A queued one is
        going to be tried again on its own; one waiting for an address would
        land in exactly the same place, and a control that cannot work is worse
        than none.
      */}
      {canRetry(row.queueState) && !state.message && (
        <form action={action} className="mt-3">
          <input type="hidden" name="id" value={row.id} />
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg border-2 border-navy-300 bg-white px-3 py-1.5 text-xs font-bold text-navy-900 hover:border-navy-600 disabled:opacity-60"
          >
            {pending ? "Putting it back…" : "Try sending it again"}
          </button>
        </form>
      )}
    </li>
  );
}
