"use client";

import { useActionState, useRef, useState } from "react";

import { uploadCertificateAction, type UploadState } from "./actions";
import { MAX_DOCUMENT_BYTES } from "@/lib/documents/validate";

/**
 * Putting the finished PDF against the job.
 *
 * The size is checked here as a courtesy — an engineer on a 4G connection
 * should not upload nine megabytes to be told no — and again on the server,
 * from the bytes, which is the check that counts. A limit enforced only in
 * a browser is not a limit.
 *
 * It deliberately does not say "done" or "issued". An upload is a file put
 * in front of an administrator, and the wording says exactly that, because
 * an engineer who believes the certificate has gone out will not chase it.
 */
export function UploadCertificate({
  jobId,
  uploadedCount,
}: {
  jobId: string;
  uploadedCount: number;
}) {
  const [state, action, pending] = useActionState<UploadState, FormData>(
    uploadCertificateAction,
    {},
  );
  const [tooBig, setTooBig] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form action={action} className="mt-3">
      <input type="hidden" name="jobId" value={jobId} />

      <label
        htmlFor="certificateFile"
        className="block text-sm font-bold text-navy-900"
      >
        The certificate PDF
      </label>
      <input
        ref={inputRef}
        id="certificateFile"
        name="file"
        type="file"
        accept="application/pdf,.pdf"
        required
        onChange={(event) => {
          const file = event.target.files?.[0];
          setChosen(file ? file.name : null);
          setTooBig(
            file && file.size > MAX_DOCUMENT_BYTES
              ? `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`
              : null,
          );
        }}
        className="mt-1 block w-full rounded-xl border-2 border-navy-200 bg-white px-3 py-3 text-base text-navy-900 file:mr-3 file:rounded-lg file:border-0 file:bg-navy-100 file:px-4 file:py-2 file:text-sm file:font-bold file:text-navy-900 focus:border-flame-500"
      />
      {chosen && !tooBig && (
        <p className="mt-1 text-xs text-navy-600">Ready to upload: {chosen}</p>
      )}
      {tooBig && (
        <p role="alert" className="mt-1 text-sm font-bold text-flame-600">
          {tooBig}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || tooBig !== null}
        className="mt-3 w-full rounded-2xl bg-navy-900 px-6 py-4 text-base font-extrabold text-white hover:bg-navy-800 disabled:opacity-60"
      >
        {pending ? "Uploading…" : "Upload the certificate"}
      </button>

      <p className="mt-2 text-xs leading-relaxed text-navy-600">
        This sends it to the office for checking. It is not issued and nobody
        is emailed until an administrator has reviewed it.
        {uploadedCount > 0 && (
          <>
            {" "}
            <strong className="text-navy-800">
              {uploadedCount} already uploaded and waiting.
            </strong>{" "}
            Uploading again adds another — it does not replace it.
          </>
        )}
      </p>

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
    </form>
  );
}
