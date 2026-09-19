"use client";

import { useActionState, useState } from "react";

import {
  discardDraftAction,
  issueInvoiceAction,
  markPaidAction,
  resendInvoiceAction,
  sendInvoiceAction,
  voidInvoiceAction,
  type ActionState,
} from "./actions";
import type { IssueBlocker } from "@/lib/invoices/model";
import type {
  InvoiceRecipientAddress,
  QueuedInvoiceEmail,
} from "@/lib/invoices/delivery";

/**
 * The controls that change an invoice's state.
 *
 * Each is its own form and its own action, so a failure in one does not clear
 * another, and none of them is nested inside another — a `<form>` inside a
 * `<form>` is dropped by the browser and the inner button silently becomes a
 * submit for the outer one. That exact fault cost a debugging session on the
 * certificate screen (§20.f); it is not repeated here.
 */

const field =
  "mt-1 w-full rounded-xl border-2 border-navy-200 bg-white px-3 py-2 text-sm font-semibold text-navy-900 focus:border-flame-500";

function Feedback({ state }: { state: ActionState }) {
  if (state.error) {
    return (
      <p
        role="alert"
        className="mt-2 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
      >
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p
        role="status"
        className="mt-2 rounded-xl border-2 border-navy-200 bg-navy-50 px-4 py-3 text-sm font-semibold text-navy-900"
      >
        {state.message}
      </p>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

/**
 * Issuing, behind a typed confirmation.
 *
 * Not a second button. Issuing draws a number that is never reused, freezes
 * the document and makes it visible to the agency, and typing the word is the
 * cheapest way to make that a decision rather than a click.
 *
 * The blockers are listed rather than summarised, so somebody chasing a
 * missing setting is told all of them at once.
 */
export function IssueInvoice({
  invoiceId,
  blockers,
  warnings,
}: {
  invoiceId: string;
  blockers: IssueBlocker[];
  warnings: string[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    issueInvoiceAction,
    {},
  );

  if (blockers.length > 0) {
    return (
      <div className="rounded-2xl border-2 border-flame-500 bg-flame-400/10 p-4">
        <h3 className="text-sm font-extrabold text-navy-900">
          This cannot be issued yet
        </h3>
        <ul className="mt-2 grid gap-2 text-sm text-navy-800">
          {blockers.map((blocker) => (
            <li key={blocker.code}>
              {blocker.message}
              {blocker.fields && blocker.fields.length > 0 && (
                <>
                  {" "}
                  <span className="font-bold">
                    Still empty: {blocker.fields.join(", ")}.
                  </span>{" "}
                  <a href="/admin/settings" className="font-bold underline">
                    Business details
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <form action={action} className="rounded-2xl border-2 border-navy-200 p-4">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <h3 className="text-sm font-extrabold text-navy-900">Issue this invoice</h3>
      <p className="mt-1 text-sm text-navy-700">
        A number is allocated, the business details and the payer are frozen
        onto it, and the PDF is stored. It cannot be edited afterwards — a
        correction is a void and a new invoice.
      </p>

      {warnings.length > 0 && (
        <p
          role="alert"
          className="mt-2 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {warnings.join(" ")}
        </p>
      )}

      <label
        htmlFor="confirm"
        className="mt-3 block text-xs font-bold uppercase tracking-wide text-navy-600"
      >
        Type ISSUE to confirm
      </label>
      <input id="confirm" name="confirm" autoComplete="off" className={field} />

      <button
        type="submit"
        disabled={pending}
        className="mt-3 rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600 disabled:opacity-60"
      >
        {pending ? "Issuing…" : "Issue invoice"}
      </button>

      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Approving a send, to addresses that are shown.
 *
 * Roles are what the queue carries; the resolved address is what is on screen,
 * because "email the agency" is not something anybody can check.
 *
 * The retry control for each earlier attempt is a **sibling** of this form,
 * not a child — see the note at the top of this file.
 */
export function SendInvoice({
  invoiceId,
  recipients,
  history,
}: {
  invoiceId: string;
  recipients: InvoiceRecipientAddress[];
  history: QueuedInvoiceEmail[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    sendInvoiceAction,
    {},
  );
  const [resendState, resendAction] = useActionState<ActionState, FormData>(
    resendInvoiceAction,
    {},
  );

  const sendable = recipients.filter((r) => r.address);

  return (
    <div className="rounded-2xl border-2 border-navy-200 p-4">
      <h3 className="text-sm font-extrabold text-navy-900">
        Email the invoice
      </h3>
      <p className="mt-1 text-sm text-navy-700">
        The exact PDF that was issued is attached. Nothing is sent until you
        choose a recipient, and nothing is sent by this button — it goes into
        the outbox and out on the next run.
      </p>

      {sendable.length === 0 ? (
        <p className="mt-2 text-sm font-semibold text-flame-600">
          No email address is on file for anybody who could receive this.
        </p>
      ) : (
        <>
          <form action={action} id={`send-${invoiceId}`} className="mt-3">
            <input type="hidden" name="invoiceId" value={invoiceId} />
            <button
              type="submit"
              disabled={pending}
              className="rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600 disabled:opacity-60"
            >
              {pending ? "Queueing…" : "Queue for the selected recipients"}
            </button>
            <Feedback state={state} />
          </form>

          {/*
            The checkboxes belong to the form above, joined by the `form`
            attribute rather than by nesting — so each retry control below can
            be its own form without any of them ending up inside another.
          */}
          <ul className="mt-3 grid gap-2">
            {sendable.map((recipient) => {
              const attempts = history.filter(
                (row) => row.recipient === recipient.recipient,
              );
              const latest = attempts[attempts.length - 1];

              return (
                <li
                  key={recipient.recipient}
                  className="rounded-xl bg-navy-50 p-3 text-sm"
                >
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      name="recipient"
                      value={recipient.recipient}
                      form={`send-${invoiceId}`}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-bold text-navy-900">
                        {recipient.label}
                      </span>
                      <br />
                      <span className="text-navy-700">{recipient.address}</span>
                    </span>
                  </label>

                  {latest && (
                    <p className="mt-2 text-xs text-navy-700">
                      Last attempt: <strong>{latest.state}</strong>
                      {latest.recipientAddress && (
                        <> to {latest.recipientAddress}</>
                      )}
                      {latest.approval && <> (approval {latest.approval})</>}
                      {latest.lastError && <> — {latest.lastError}</>}
                      {latest.addressStale && (
                        <>
                          {" "}
                          <strong className="text-flame-600">
                            Approved for an address that is no longer the one on
                            file.
                          </strong>
                        </>
                      )}
                    </p>
                  )}

                  {latest && latest.state !== "pending" && (
                    <form action={resendAction} className="mt-2">
                      <input type="hidden" name="invoiceId" value={invoiceId} />
                      <input
                        type="hidden"
                        name="recipient"
                        value={recipient.recipient}
                      />
                      <button
                        type="submit"
                        className="rounded-lg border-2 border-navy-200 px-3 py-1.5 text-xs font-bold text-navy-900 hover:border-flame-500"
                      >
                        Approve again for the address above
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
          <Feedback state={resendState} />
        </>
      )}

      {history.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide text-navy-600">
            Every send ever approved ({history.length})
          </summary>
          <ul className="mt-2 grid gap-1 text-xs text-navy-700">
            {history.map((row) => (
              <li key={row.id}>
                {row.createdAt.toLocaleString("en-GB")} — {row.recipient} ·{" "}
                {row.recipientAddress ?? "resolved at send"} · {row.state}
                {row.approval ? ` · approval ${row.approval}` : ""}
                {row.lastError ? ` · ${row.lastError}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/**
 * Recording a payment.
 *
 * BSCJ takes no payments through this application. This is somebody stating
 * that money arrived, on a date they give — which is why the date is typed
 * rather than defaulted to today, and why the note is free text that nothing
 * parses.
 */
export function MarkPaid({ invoiceId }: { invoiceId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    markPaidAction,
    {},
  );

  return (
    <form action={action} className="rounded-2xl border-2 border-navy-200 p-4">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <h3 className="text-sm font-extrabold text-navy-900">Record a payment</h3>
      <p className="mt-1 text-sm text-navy-700">
        Nothing here takes a payment. This records that one arrived.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label
            htmlFor="paidOn"
            className="block text-xs font-bold uppercase tracking-wide text-navy-600"
          >
            Date the payment arrived
          </label>
          <input id="paidOn" name="paidOn" type="date" className={field} />
          {state.errors?.paidOn && (
            <p role="alert" className="mt-1 text-xs font-bold text-flame-600">
              {state.errors.paidOn}
            </p>
          )}
        </div>
        <div>
          <label
            htmlFor="paidNote"
            className="block text-xs font-bold uppercase tracking-wide text-navy-600"
          >
            Note (optional)
          </label>
          <input
            id="paidNote"
            name="paidNote"
            placeholder="Bank transfer, reference…"
            className={field}
          />
          {state.errors?.note && (
            <p role="alert" className="mt-1 text-xs font-bold text-flame-600">
              {state.errors.note}
            </p>
          )}
        </div>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="mt-3 rounded-xl bg-navy-900 px-6 py-3 text-sm font-bold text-white hover:bg-navy-800 disabled:opacity-60"
      >
        {pending ? "Recording…" : "Mark as paid"}
      </button>

      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Void and discard
// ---------------------------------------------------------------------------

/**
 * Voiding.
 *
 * Behind a disclosure, because it is rarely the right answer and should not sit
 * next to the buttons that are. The reason is required and stays on the record;
 * the number stays with the voided invoice and is never reused.
 */
export function VoidInvoice({ invoiceId }: { invoiceId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    voidInvoiceAction,
    {},
  );
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm font-bold text-flame-600 hover:underline"
      >
        Void this invoice
      </button>
    );
  }

  return (
    <form action={action} className="rounded-2xl border-2 border-flame-500 p-4">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <h3 className="text-sm font-extrabold text-navy-900">Void this invoice</h3>
      <p className="mt-1 text-sm text-navy-700">
        It keeps its number and its PDF and stops being owed. The job can then
        be invoiced again. This is how an issued invoice is corrected — it is
        never edited.
      </p>

      <label
        htmlFor="reason"
        className="mt-3 block text-xs font-bold uppercase tracking-wide text-navy-600"
      >
        Why
      </label>
      <textarea id="reason" name="reason" rows={2} className={field} />
      {state.errors?.reason && (
        <p role="alert" className="mt-1 text-xs font-bold text-flame-600">
          {state.errors.reason}
        </p>
      )}

      <div className="mt-3 flex gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600 disabled:opacity-60"
        >
          {pending ? "Voiding…" : "Void it"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-xl border-2 border-navy-200 px-6 py-3 text-sm font-bold text-navy-900"
        >
          Keep it
        </button>
      </div>

      <Feedback state={state} />
    </form>
  );
}

/** Deleting a draft that never drew a number. */
export function DiscardDraft({ invoiceId }: { invoiceId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    discardDraftAction,
    {},
  );

  return (
    <form action={action}>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <button
        type="submit"
        disabled={pending}
        className="text-sm font-bold text-flame-600 hover:underline disabled:opacity-60"
      >
        {pending ? "Discarding…" : "Discard this draft"}
      </button>
      <Feedback state={state} />
    </form>
  );
}
