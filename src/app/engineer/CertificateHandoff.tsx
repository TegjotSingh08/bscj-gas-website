import Link from "next/link";

import { UploadCertificate } from "./UploadCertificate";
import type { PendingDocument } from "@/lib/documents/certificates";
import type { JobCertificate } from "@/lib/documents/certificates";

/**
 * The gas safety record, from the job.
 *
 * **What this replaced.** Four numbered steps: download a file of the
 * customer's details, open the generator, import the file, then come back and
 * upload the PDF. Every one of them was a thing to remember while standing in
 * somebody's hallway, and every certificate left a document full of a
 * customer's name and address in the device's Downloads folder.
 *
 * It is now one button. The generator opens against this job, fills in what
 * the application already knows, keeps the draft on the server, and submits
 * the finished PDF straight into the same review queue the upload fed. No
 * file is downloaded and nothing is imported.
 *
 * **What has not changed, deliberately.** Submitting is not issuing. The
 * record goes to the office as *awaiting review*; an administrator opens it,
 * reads it and releases it, and only then is anybody emailed or a renewal
 * date moved. The wording below says so in as many words, because an engineer
 * who believes the certificate has gone out will not chase it.
 *
 * **Manual upload is kept, and kept secondary.** A record prepared somewhere
 * else — on a laptop, in the standalone generator, on a job that was not in
 * the application — still needs a way in. It is behind a disclosure rather
 * than in the way of the thing almost everybody wants.
 */
export function CertificateHandoff({
  jobId,
  reference,
  pending,
  released,
  storageRequirement,
  draft,
}: {
  jobId: string;
  reference: string;
  /** Uploaded or submitted and waiting for the office. */
  pending: PendingDocument[];
  /** Already released, so the engineer can see it went through. */
  released: JobCertificate[];
  /** Set when documents cannot be stored yet; says what is missing. */
  storageRequirement: string | null;
  /** Whether a record is part-written, so the button says the right thing. */
  draft: { exists: boolean; submittedAt: Date | null } | null;
}) {
  const resuming = Boolean(draft?.exists) && !draft?.submittedAt;
  const submitted = Boolean(draft?.submittedAt);

  return (
    <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
      <h2 className="text-sm font-extrabold uppercase tracking-wide text-navy-600">
        Gas safety record
      </h2>

      {storageRequirement ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          Records cannot be saved yet. {storageRequirement} Keep the PDF safe
          and send it to the office the way you do now.
        </p>
      ) : (
        <>
          {submitted ? (
            <p
              role="status"
              className="mt-3 rounded-xl border-2 border-trust-500 bg-trust-50 px-4 py-3 text-sm font-semibold text-navy-900"
            >
              Submitted and waiting for the office to review it. It is not
              issued yet — nobody has been emailed.
            </p>
          ) : (
            <p className="mt-2 text-sm leading-relaxed text-navy-800">
              {resuming
                ? "You have a record part-written for this job. It is saved on the office system, not on this phone, so it is here whichever device you pick up."
                : "Opens the record with this property, the customer and your own details already filled in. The readings, the outcomes, the date and the number are yours to enter."}
            </p>
          )}

          <a
            href={`/engineer/certificate?job=${encodeURIComponent(jobId)}`}
            className="mt-3 block rounded-xl bg-flame-500 px-5 py-4 text-center text-base font-extrabold text-navy-900 hover:bg-flame-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy-900"
          >
            {submitted
              ? "Open the record again"
              : resuming
                ? "Continue draft"
                : "Create gas safety record"}
          </a>

          <p className="mt-2 text-xs leading-relaxed text-navy-600">
            Saving keeps your work. <strong>Submit for review</strong> sends it
            to the office — it does not issue the certificate and emails
            nobody.
          </p>
        </>
      )}

      {pending.length > 0 && (
        <section className="mt-4 rounded-xl bg-navy-50 px-4 py-3">
          <h3 className="text-xs font-bold uppercase tracking-wide text-navy-600">
            Waiting for the office
          </h3>
          <ul className="mt-2 grid gap-2 text-sm">
            {pending.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-baseline gap-2">
                <a
                  href={`/api/documents/${doc.id}`}
                  target="_blank"
                  rel="noopener"
                  className="font-bold text-flame-600 underline"
                >
                  {doc.filename}
                </a>
                <span className="text-xs text-navy-600">
                  {(doc.sizeBytes / 1024).toFixed(0)} KB · {" "}
                  {doc.uploadedAt.toLocaleString("en-GB", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-navy-600">
            Not issued yet. An administrator has to read it first.
          </p>
        </section>
      )}

      {released.length > 0 && (
        <section className="mt-4 rounded-xl bg-trust-50 px-4 py-3">
          <h3 className="text-xs font-bold uppercase tracking-wide text-trust-600">
            Issued
          </h3>
          <ul className="mt-2 grid gap-1 text-sm text-navy-800">
            {released.map((cert) => (
              <li key={cert.id}>
                <strong className="font-extrabold">
                  {cert.certificateNumber}
                </strong>
                {cert.version > 1 && ` (version ${cert.version})`} ·{" "}
                {cert.status === "issued" ? "current" : "superseded"}
                {cert.documentId && (
                  <>
                    {" · "}
                    <a
                      href={`/api/documents/${cert.documentId}`}
                      target="_blank"
                      rel="noopener"
                      className="font-bold text-flame-600 underline"
                    >
                      open
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        The way in for a record made somewhere else. Closed by default: it is
        the exception now, and an upload control sitting open next to the main
        button is an invitation to go back to carrying files about.
      */}
      {!storageRequirement && (
        <details className="mt-4 rounded-xl border-2 border-navy-200 bg-navy-50 px-4 py-3">
          <summary className="cursor-pointer text-sm font-bold text-navy-900">
            Prepared a PDF somewhere else? Upload it instead
          </summary>
          <p className="mt-2 text-xs leading-relaxed text-navy-600">
            For a record written in the standalone generator or on a laptop.
            It goes to the office for review in exactly the same way.
          </p>
          <UploadCertificate jobId={jobId} uploadedCount={pending.length} />
        </details>
      )}

      <p className="mt-4 text-xs leading-relaxed text-navy-600">
        <Link href="/engineer" className="font-bold text-flame-600 underline">
          Back to today
        </Link>
      </p>

      <p className="sr-only">
        Reference {reference}. The record is authorised against this job and
        your account; it is not available from the reference alone.
      </p>
    </section>
  );
}
