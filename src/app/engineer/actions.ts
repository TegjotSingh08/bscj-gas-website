"use server";

import { revalidatePath } from "next/cache";

import { requireEngineer } from "@/lib/auth/session";
import { completeWork, startWork } from "@/lib/jobs/work-actions";

/**
 * On site, and done.
 *
 * A server action is a public HTTP endpoint with a generated name, so both of
 * these begin with `requireEngineer()` against a verified session. That guard
 * answers "is this the right kind of user for this surface"; whether this
 * *particular* job is theirs is answered in `work-actions.ts`, from the row,
 * along with whether the move is legal at all.
 *
 * The form sends a job id and — for completion — a note. It does not send a
 * status, a time, or who it is from: every one of those is derived on the
 * server, and the times are the server's clock rather than the phone's.
 */

export type WorkState = { message?: string; error?: string };

export async function startWorkAction(
  _previous: WorkState,
  form: FormData,
): Promise<WorkState> {
  const session = await requireEngineer();

  const jobId = String(form.get("jobId") ?? "");
  if (!jobId) return { error: "No job was named." };

  const result = await startWork({ session, jobId });
  if (!result.ok) return { error: result.error };

  revalidatePath(`/engineer/jobs/${jobId}`);
  revalidatePath("/engineer");
  revalidatePath(`/admin/jobs/${jobId}`);
  return { message: result.message };
}

export async function completeWorkAction(
  _previous: WorkState,
  form: FormData,
): Promise<WorkState> {
  const session = await requireEngineer();

  const jobId = String(form.get("jobId") ?? "");
  if (!jobId) return { error: "No job was named." };

  const result = await completeWork({
    session,
    jobId,
    notes: form.get("notes"),
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(`/engineer/jobs/${jobId}`);
  revalidatePath("/engineer");
  revalidatePath(`/admin/jobs/${jobId}`);
  return { message: result.message };
}
