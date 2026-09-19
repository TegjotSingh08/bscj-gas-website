"use client";

import { useActionState, useState } from "react";

import {
  queueCertificateEmailAction,
  releaseCertificateAction,
  requeueCertificateEmailAction,
  type ReleaseActionState,
} from "./actions";
import { MAX_CERTIFICATE_NUMBER } from "@/lib/documents/release";
import type {
  JobCertificate,
  PendingDocument,
  RecipientAddress,
} from "@/lib/documents/certificates";

/**
 * Reading a certificate, releasing it, and deciding who is told.
 *
 * Three deliberate frictions, and each is the point rather than an
 * oversight:
 *
 * 1. **The document has to be opened before the form will submit.** Not a
 *    real guarantee — nobody can be made to read — but "released" is a
 *    person's assertion that they looked, and a form that can be completed
 *    without the PDF ever being opened invites exactly that.
 * 2. **The number and both dates are typed.** They are read off the PDF.
 *    Nothing is prefilled, because a prefilled figure is one nobody checks,
 *    and no numbering scheme or renewal calculation exists here to prefill
 *    from.
 * 3. **The addresses are shown, not the roles.** "Email the agency" is not
 *    something anybody can check; `lettings@example.com` is.
 */

const field =
  "mt-1 w-full rounded-xl border-2 border-navy-200 bg-white px-3 py-2 text-sm font-semibold text-navy-900 focus:border-flame-500";

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-xs font-bold uppercase tracking-wide text-navy-600"
      >
        {label}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-navy-600">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs font-bold text-flame-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function ReleaseCertificate({
  jobId,
  document,
  isCorrection,
}: {
  jobId: string;
  document: PendingDocument;
  isCorrection: boolean;
}) {
  const [state, action, pending] = useActionState<ReleaseActionState, FormData>(
    releaseCertificateAction,
    {},
  );
  const [opened, setOpened] = useState(false);
  const errors = state.errors ?? {};

  return (
    <div className="rounded-xl border-2 border-navy-200 bg-navy-50 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-navy-900">{document.filename}</p>
        <p className="text-xs text-navy-600">
          {(document.sizeBytes / 1024).toFixed(0)} KB · uploaded by{" "}
          {document.uploadedByName ?? "an engineer"} ·{" "}
          {document.uploadedAt.toLocaleString("en-GB", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
      </div>

      <a
        href={`/api/documents/${document.id}`}
        target="_blank"
        rel="noopener"
        onClick={() => setOpened(true)}
        className="mt-3 inline-block rounded-xl bg-flame-500 px-5 py-2.5 text-sm font-extrabold text-navy-900 hover:bg-flame-400"
      >
        Open the PDF to review it
      </a>

      <form action={action} className="mt-4 grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="jobId" value={jobId} />
        <input type="hidden" name="documentId" value={document.id} />

        <Field
          id={`certificateNumber-${document.id}`}
          label="Certificate number"
          hint="Exactly as printed on the PDF."
          error={errors.certificateNumber}
        >
          <input
            id={`certificateNumber-${document.id}`}
            name="certificateNumber"
            type="text"
            required
            maxLength={MAX_CERTIFICATE_NUMBER}
            className={field}
          />
        </Field>

        <Field
          id={`inspectionDate-${document.id}`}
          label="Inspection date"
          hint="The day the inspection was carried out."
          error={errors.inspectionDate}
        >
          <input
            id={`inspectionDate-${document.id}`}
            name="inspectionDate"
            type="date"
            required
            className={field}
          />
        </Field>

        <Field
          id={`nextDueDate-${document.id}`}
          label="Next due date"
          hint="Read it off the PDF. Nothing here calculates it."
          error={errors.nextDueDate}
        >
          <input
            id={`nextDueDate-${document.id}`}
            name="nextDueDate"
            type="date"
            required
            className={field}
          />
        </Field>

        {isCorrection && (
          <Field
            id={`correctionReason-${document.id}`}
            label="What is being corrected"
            hint="This job already has an issued certificate. The existing one is kept and marked superseded."
            error={errors.correctionReason}
          >
            <input
              id={`correctionReason-${document.id}`}
              name="correctionReason"
              type="text"
              required
              maxLength={500}
              className={field}
            />
          </Field>
        )}

        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={pending || !opened}
            className="w-full rounded-xl bg-navy-900 px-5 py-3 text-sm font-extrabold text-white hover:bg-navy-800 disabled:opacity-50 sm:w-auto"
          >
            {pending
              ? "Releasing…"
              : isCorrection
                ? "Release as a correction"
                : "Release this certificate"}
          </button>
          {!opened && (
            <p className="mt-2 text-xs font-semibold text-navy-700">
              Open the PDF first. Releasing says you have read it.
            </p>
          )}
          <p className="mt-2 text-xs text-navy-600">
            Releasing makes it visible to the agency. Nobody is emailed until
            you choose to send it.
          </p>
        </div>
      </form>

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
    </div>
  );
}

/**
 * Choosing who gets told, with the addresses in front of you.
 *
 * Nothing is ticked by default. A recipient list that arrives pre-selected
 * is a list somebody sends without reading, and this is the step where a
 * document about somebody's property leaves the building.
 */
/** One recipient's delivery state, as the outbox records it. */
export type RecipientState = {
  recipient: string;
  /** The address that was approved, frozen when it was queued. */
  approvedAddress: string | null;
  state: string;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
};

/** Failure reasons that mean "somebody changed something", not "try again". */
const REVOKED: Record<string, string> = {
  approved_address_changed:
    "The address on file changed after this was approved, so it was not sent there. Check the address below and queue it again.",
  agency_deactivated: "That agency has been deactivated.",
  agency_no_longer_on_job: "That agency is no longer on this job.",
  customer_deactivated: "That customer has been deactivated.",
  attachment_too_large: "The PDF is too large to attach.",
  superseded_by_correction:
    "A correction was issued before this went out, so it was stood down. Send the current version.",
};

function StateLine({ state }: { state: RecipientState }) {
  if (state.state === "sent") {
    return (
      <span className="block text-xs font-bold text-trust-600">
        Accepted by the email provider
        {state.sentAt
          ? ` on ${state.sentAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`
          : ""}
        . Acceptance is not proof of delivery.
      </span>
    );
  }
  if (state.state === "pending") {
    return (
      <span className="block text-xs font-bold text-navy-700">
        Queued{state.attempts > 0 ? ` · ${state.attempts} attempt${state.attempts === 1 ? "" : "s"} so far` : ""} — it goes out on the next run of the outbox.
      </span>
    );
  }
  const explanation = state.lastError ? REVOKED[state.lastError] : null;
  return (
    <span className="block text-xs font-bold text-flame-600">
      {state.state === "failed" ? "Not sent" : "Stood down"}
      {explanation ? ` — ${explanation}` : state.lastError ? ` — ${state.lastError.replace(/_/g, " ")}` : ""}
    </span>
  );
}

/**
 * Trying one recipient again.
 *
 * Reuses the same queue row and its key, so the provider still sees one
 * message — and re-approves whatever address is on file now, which is the
 * address shown immediately above the button.
 */
function RetryRecipient({
  jobId,
  certificateId,
  recipient,
}: {
  jobId: string;
  certificateId: string;
  recipient: string;
}) {
  const [state, action, pending] = useActionState<ReleaseActionState, FormData>(
    requeueCertificateEmailAction,
    {},
  );
  return (
    <form action={action} className="mt-2">
      <input type="hidden" name="certificateId" value={certificateId} />
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="recipient" value={recipient} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border-2 border-navy-300 bg-white px-3 py-1.5 text-xs font-bold text-navy-900 hover:border-flame-500 disabled:opacity-60"
      >
        {pending ? "Queueing…" : "Queue again to the address above"}
      </button>
      {state.message && (
        <span role="status" className="ml-2 text-xs font-bold text-navy-900">
          {state.message}
        </span>
      )}
      {state.error && (
        <span role="alert" className="ml-2 text-xs font-bold text-flame-600">
          {state.error}
        </span>
      )}
    </form>
  );
}

export function SendCertificate({
  jobId,
  certificate,
  recipients,
  states,
}: {
  jobId: string;
  certificate: JobCertificate;
  recipients: RecipientAddress[];
  /** What the outbox says about each recipient, for this version. */
  states: RecipientState[];
}) {
  const [state, action, pending] = useActionState<ReleaseActionState, FormData>(
    queueCertificateEmailAction,
    {},
  );

  const stateFor = (recipient: string) =>
    states.find((s) => s.recipient === recipient) ?? null;

  const choosable = recipients.filter(
    (r) => r.address !== null && stateFor(r.recipient) === null,
  );

  /*
    The queue form is a **sibling** of the recipient list, not its parent,
    and the checkboxes join it with the `form` attribute.

    That is not a stylistic choice. Each retry control is itself a form,
    and an HTML form cannot contain another — a browser drops the inner
    one, so the retry button silently became a submit button for the queue
    form and did nothing at all. This shape keeps both working.
  */
  const queueId = `queue-${certificate.id}`;

  return (
    <div className="mt-3">
      <p className="text-xs font-bold uppercase tracking-wide text-navy-600">
        Send this certificate · version {certificate.version}
      </p>
      <p className="mt-1 text-xs text-navy-600">
        The PDF is attached, so a recipient without an account gets the
        document itself.
      </p>

      <form id={queueId} action={action}>
        <input type="hidden" name="certificateId" value={certificate.id} />
        <input type="hidden" name="jobId" value={jobId} />
      </form>

      {recipients.length === 0 ? (
        <p className="mt-2 text-sm text-navy-700">
          This job has nobody on file to send to.
        </p>
      ) : (
        <>
          <ul className="mt-2 grid gap-2">
            {recipients.map((r) => {
              const sent = stateFor(r.recipient);
              const retryable =
                sent !== null && (sent.state === "failed" || sent.state === "cancelled");
              return (
                <li key={r.recipient}>
                  <div className="rounded-xl border-2 border-navy-200 bg-white px-4 py-3">
                    <label className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        form={queueId}
                        name="recipients"
                        value={r.recipient}
                        disabled={r.address === null || sent !== null}
                        className="mt-1 h-5 w-5"
                      />
                      <span className="text-sm">
                        <span className="block font-bold text-navy-900">
                          {r.label}
                        </span>
                        {/* The actual address, before anything is sent. */}
                        {r.address ? (
                          <span className="block break-all font-mono text-xs text-navy-700">
                            {r.address}
                          </span>
                        ) : (
                          <span className="block text-xs font-bold text-flame-600">
                            No email address on file — cannot be sent.
                          </span>
                        )}
                        {sent && <StateLine state={sent} />}
                        {sent?.approvedAddress &&
                          r.address &&
                          sent.approvedAddress !== r.address && (
                            <span className="block break-all text-xs font-bold text-flame-600">
                              Approved for {sent.approvedAddress}, which is no
                              longer the address on file.
                            </span>
                          )}
                      </span>
                    </label>
                    {retryable && r.address && (
                      <RetryRecipient
                        jobId={jobId}
                        certificateId={certificate.id}
                        recipient={r.recipient}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {choosable.length > 0 && (
            <>
              <button
                type="submit"
                form={queueId}
                disabled={pending}
                className="mt-3 rounded-xl border-2 border-navy-300 bg-white px-5 py-2.5 text-sm font-bold text-navy-900 hover:border-flame-500 disabled:opacity-60"
              >
                {pending ? "Queueing…" : "Queue the email"}
              </button>
              <p className="mt-2 text-xs text-navy-600">
                The address is fixed when you queue it. If it changes
                afterwards, the send stops and says so rather than going
                somewhere you did not approve.
              </p>
            </>
          )}

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
        </>
      )}
    </div>
  );
}
