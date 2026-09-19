"use client";

import { useActionState } from "react";

import {
  assignEngineerAction,
  unassignEngineerAction,
  type AssignState,
} from "./actions";

/**
 * Allocating the work.
 *
 * The page decides whether the controls appear at all — using the same rules
 * the action enforces, so a button that is shown and an action that is
 * permitted cannot drift apart — and this only renders them. Whatever the
 * form sends, the action re-reads the job and makes its own decision.
 */
export function AssignEngineer({
  jobId,
  engineers,
  assignedEngineerId,
  canAssign,
  canUnassign,
  refusal,
}: {
  jobId: string;
  engineers: { id: string; name: string }[];
  assignedEngineerId: string | null;
  canAssign: boolean;
  canUnassign: boolean;
  refusal: string | null;
}) {
  const [state, action, pending] = useActionState<AssignState, FormData>(
    assignEngineerAction,
    {},
  );
  const [offState, offAction, offPending] = useActionState<AssignState, FormData>(
    unassignEngineerAction,
    {},
  );

  const message = state.message ?? offState.message;
  const error = state.error ?? offState.error;

  if (!canAssign && !canUnassign) {
    return (
      <p className="mt-2 text-sm text-navy-700">
        {refusal ?? "This job cannot be allocated."}
      </p>
    );
  }

  return (
    <div className="mt-3">
      {canAssign && (
        <form action={action} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="jobId" value={jobId} />
          <div className="min-w-[14rem] flex-1">
            <label
              htmlFor="engineerId"
              className="block text-xs font-bold uppercase tracking-wide text-navy-600"
            >
              {assignedEngineerId ? "Move this job to" : "Allocate to"}
            </label>
            <select
              id="engineerId"
              name="engineerId"
              required
              defaultValue=""
              className="mt-1 w-full rounded-xl border-2 border-navy-200 bg-white px-3 py-2 text-sm font-semibold text-navy-900 focus:border-flame-500"
            >
              <option value="" disabled>
                Choose an engineer…
              </option>
              {engineers
                .filter((engineer) => engineer.id !== assignedEngineerId)
                .map((engineer) => (
                  <option key={engineer.id} value={engineer.id}>
                    {engineer.name}
                  </option>
                ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-flame-500 px-5 py-2.5 text-sm font-extrabold text-navy-900 hover:bg-flame-400 disabled:opacity-60"
          >
            {pending ? "Saving…" : assignedEngineerId ? "Move" : "Allocate"}
          </button>
        </form>
      )}

      {engineers.length === 0 && canAssign && (
        <p className="mt-2 text-sm font-semibold text-flame-600">
          There are no active engineer accounts to allocate this to.
        </p>
      )}

      {canUnassign && (
        <form action={offAction} className="mt-3">
          <input type="hidden" name="jobId" value={jobId} />
          <button
            type="submit"
            disabled={offPending}
            className="rounded-xl border-2 border-navy-300 bg-white px-4 py-2 text-sm font-bold text-navy-900 hover:border-flame-500 disabled:opacity-60"
          >
            {offPending ? "Saving…" : "Take the engineer off this job"}
          </button>
        </form>
      )}

      {message && (
        <p role="status" className="mt-2 text-sm font-semibold text-navy-900">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm font-semibold text-flame-600">
          {error}
        </p>
      )}
    </div>
  );
}
