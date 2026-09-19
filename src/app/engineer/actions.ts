"use server";

import { revalidatePath } from "next/cache";

import { requireEngineer } from "@/lib/auth/session";
import { completeWork, startWork } from "@/lib/jobs/work-actions";
import { uploadCertificate } from "@/lib/documents/certificates";

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

// ---------------------------------------------------------------------------
// The certificate
// ---------------------------------------------------------------------------

/**
 * Uploading the generated PDF against the job.
 *
 * The file arrives as multipart form data. Nothing about it is trusted: the
 * bytes are read on the server, checked against what a PDF actually looks
 * like, and stored before a single row is written. The job, the engineer's
 * right to it and the job's state are all re-derived in
 * `documents/certificates.ts`.
 *
 * Uploading does **not** release anything. It puts a file in front of an
 * administrator, and that is all it does.
 */
export type UploadState = { message?: string; error?: string };

export async function uploadCertificateAction(
  _previous: UploadState,
  form: FormData,
): Promise<UploadState> {
  const session = await requireEngineer();

  const jobId = String(form.get("jobId") ?? "");
  if (!jobId) return { error: "No job was named." };

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose the certificate PDF to upload." };
  }

  /*
    Read once, into memory. A certificate is a one-page PDF and the size cap
    is checked again from the bytes; streaming would buy nothing here and
    would make the "store before recording" ordering harder to be sure of.
  */
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { error: "That file could not be read. Try choosing it again." };
  }

  const result = await uploadCertificate({
    session,
    jobId,
    bytes,
    filename: file.name,
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(`/engineer/jobs/${jobId}`);
  revalidatePath(`/admin/jobs/${jobId}`);
  return { message: result.message };
}
