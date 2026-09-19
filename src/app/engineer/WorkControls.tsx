"use client";

import { useActionState } from "react";

import {
  completeWorkAction,
  startWorkAction,
  type WorkState,
} from "./actions";
import { MAX_COMPLETION_NOTE } from "@/lib/jobs/work";

/**
 * The two buttons that matter.
 *
 * Deliberately one at a time. The page renders whichever of them the job is
 * actually ready for — from the same pure rules the write enforces — so
 * there is never a choice to get wrong at a front door, and "done" cannot be
 * pressed on a job that was never started.
 *
 * Completion is terminal and is the only thing on this surface that cannot be
 * undone, so it asks for a moment's confirmation and offers the note in the
 * same breath rather than afterwards, when the engineer is already in the van.
 */

export function StartWork({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState<WorkState, FormData>(
    startWorkAction,
    {},
  );

  return (
    <form action={action}>
      <input type="hidden" name="jobId" value={jobId} />
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-2xl bg-flame-500 px-6 py-5 text-lg font-extrabold text-navy-900 hover:bg-flame-400 disabled:opacity-60"
      >
        {pending ? "Saving…" : "I’m on site"}
      </button>
      <Feedback state={state} />
    </form>
  );
}

export function CompleteWork({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState<WorkState, FormData>(
    completeWorkAction,
    {},
  );

  return (
    <form action={action}>
      <input type="hidden" name="jobId" value={jobId} />

      <label
        htmlFor="notes"
        className="block text-sm font-bold text-navy-900"
      >
        What did you find? <span className="font-normal text-navy-600">(optional)</span>
      </label>
      <textarea
        id="notes"
        name="notes"
        rows={4}
        maxLength={MAX_COMPLETION_NOTE}
        placeholder="Anything worth recording about the visit."
        className="mt-1 w-full rounded-xl border-2 border-navy-200 bg-white px-3 py-2 text-base text-navy-900 focus:border-flame-500"
      />
      <p className="mt-1 text-xs text-navy-600">
        Kept on the job. It is not a certificate and is not sent to anybody.
      </p>

      <button
        type="submit"
        disabled={pending}
        className="mt-3 w-full rounded-2xl bg-navy-900 px-6 py-5 text-lg font-extrabold text-white hover:bg-navy-800 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Work is done"}
      </button>
      <p className="mt-2 text-xs text-navy-600">
        This finishes the job. It cannot be undone from here.
      </p>
      <Feedback state={state} />
    </form>
  );
}

function Feedback({ state }: { state: WorkState }) {
  return (
    <>
      {state.message && (
        <p role="status" className="mt-3 text-sm font-bold text-navy-900">
          {state.message}
        </p>
      )}
      {state.error && (
        <p role="alert" className="mt-3 text-sm font-bold text-flame-600">
          {state.error}
        </p>
      )}
    </>
  );
}
