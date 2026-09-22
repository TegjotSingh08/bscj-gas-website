"use client";

import { useActionState } from "react";
import Link from "next/link";

import { releaseSubmissionAction } from "./actions";
import type { RetryState } from "./actions";

/**
 * Certificate submissions that claimed a job and never finished.
 *
 * **Why this is on the reconciliation page.** It is the same shape as
 * everything else here: an intent recorded durably, an outcome that never
 * arrived, and a gap only a person can close. A submission takes its claim
 * before it stores the PDF, so a process that dies in between leaves a claim
 * with nothing under it — and until it is cleared, the engineer holding it is
 * told their record is already being sent.
 *
 * Most of these clear themselves: the engineer's own retry takes the claim
 * back once the lease has passed. This is for the ones that do not, because
 * the engineer has finished for the day, and the alternative would be somebody
 * running SQL.
 */
export function StalledSubmissions({
  rows,
}: {
  rows: { jobId: string; reference: string; startedAt: Date | null }[];
}) {
  if (rows.length === 0) return null;

  return (
    <section className="rounded-2xl border-2 border-flame-500 bg-flame-400/5 p-5">
      <h2 className="text-sm font-extrabold text-navy-900">
        Certificate submissions that did not finish ({rows.length})
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-navy-700">
        Each of these started sending a gas safety record and never completed —
        a lost connection, or a phone that went to sleep mid-send. Releasing it
        lets the engineer send that record again.{" "}
        <strong>Nothing is deleted.</strong> If the record did reach us, it is
        already in the review list above and releasing this leaves it there.
      </p>
      <ul className="mt-3 space-y-3">
        {rows.map((row) => (
          <Row key={row.jobId} row={row} />
        ))}
      </ul>
    </section>
  );
}

function Row({
  row,
}: {
  row: { jobId: string; reference: string; startedAt: Date | null };
}) {
  const [state, action, pending] = useActionState<RetryState, FormData>(
    releaseSubmissionAction,
    {},
  );

  return (
    <li className="rounded-xl border-2 border-navy-200 bg-white px-4 py-3">
      <p className="text-sm">
        <Link
          href={`/admin/jobs/${row.jobId}`}
          className="font-bold text-navy-900 underline"
        >
          {row.reference}
        </Link>
        <span className="text-navy-700">
          {" "}
          — started{" "}
          {row.startedAt
            ? row.startedAt.toLocaleString("en-GB", {
                dateStyle: "medium",
                timeStyle: "short",
              })
            : "at an unrecorded time"}
        </span>
      </p>

      {state.message && (
        <p role="status" className="mt-2 text-sm font-bold text-navy-900">
          {state.message}
        </p>
      )}
      {state.error && (
        <p role="alert" className="mt-2 text-sm font-bold text-flame-600">
          {state.error}
        </p>
      )}

      {!state.message && (
        <form action={action} className="mt-2">
          <input type="hidden" name="jobId" value={row.jobId} />
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl border-2 border-navy-300 bg-white px-4 py-2 text-sm font-bold text-navy-900 hover:border-flame-500 disabled:opacity-60"
          >
            {pending ? "Releasing…" : "Release it so the engineer can resend"}
          </button>
        </form>
      )}
    </li>
  );
}
