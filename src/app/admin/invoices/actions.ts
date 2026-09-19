"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth/session";
import {
  createInvoiceDraft,
  discardInvoiceDraft,
  issueInvoice,
  markInvoicePaid,
  updateInvoiceDraft,
  voidInvoice,
  type InvoiceResult,
} from "@/lib/invoices/invoices";
import {
  queueInvoiceEmail,
  requeueInvoiceEmail,
} from "@/lib/invoices/delivery";
import { MAX_LINES, type LineInput } from "@/lib/invoices/model";

/**
 * The invoice mutations, as server actions.
 *
 * Every one of these is a public HTTP endpoint with a generated name, so each
 * starts with `requireAdmin()` against a verified session **before it looks at
 * anything in the form**. The library functions then re-check the capability
 * and the scope from the session they are given, so a mistake here is caught
 * there rather than becoming a hole.
 *
 * The form is a transport, never an authority. It carries descriptions,
 * quantities, unit prices and a chosen payer; it does not carry a total, a
 * status, an invoice number or a job ownership claim, and nothing here would
 * read one if it did.
 */

export type ActionState = {
  message?: string;
  error?: string;
  errors?: Record<string, string>;
};

/*
  Nothing but async functions is exported from this file.

  A `"use server"` module may only export server actions; exporting a constant
  alongside them fails the whole module at runtime with "can only export async
  functions" — which the production build does not catch, because the rule is
  enforced when the actions loader evaluates the module. A shared empty state
  belongs in the component that needs one.
*/

function toState(result: InvoiceResult): ActionState {
  return result.ok
    ? { message: result.message }
    : { error: result.error, errors: result.errors };
}

function refresh(invoiceId?: string) {
  revalidatePath("/admin/invoices");
  if (invoiceId) revalidatePath(`/admin/invoices/${invoiceId}`);
}

/**
 * Raising a draft from a job.
 *
 * Redirects to the draft on success, because the next thing anybody wants is
 * to read it. A failure stays where it was and says why — most often that the
 * job already has an invoice nobody voided.
 */
export async function createDraftAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAdmin();

  const jobId = String(form.get("jobId") ?? "");
  if (!jobId) return { error: "No job was named." };

  const result = await createInvoiceDraft({ session, jobId });

  if (!result.ok) return toState(result);

  revalidatePath(`/admin/jobs/${jobId}`);
  refresh();
  redirect(`/admin/invoices/${result.invoiceId}`);
}

/**
 * Reading the lines back off the form.
 *
 * Indexed fields rather than a JSON blob, so the browser posts something a
 * person can read in a network log and the server parses something with a
 * shape. Anything past `MAX_LINES` is ignored here and refused again in
 * `validateLines` — the limit exists in one place and is enforced in two.
 */
function linesFrom(form: FormData): LineInput[] {
  const lines: LineInput[] = [];

  for (let index = 0; index < MAX_LINES; index++) {
    const description = form.get(`line-${index}-description`);
    if (description === null) continue;

    // A line emptied on screen is a line removed, not an error.
    if (String(description).trim() === "") continue;

    lines.push({
      description,
      quantity: form.get(`line-${index}-quantity`),
      unitPrice: form.get(`line-${index}-unitPrice`),
    });
  }

  return lines;
}

export async function saveDraftAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAdmin();

  const invoiceId = String(form.get("invoiceId") ?? "");
  if (!invoiceId) return { error: "No invoice was named." };

  const result = await updateInvoiceDraft({
    session,
    invoiceId,
    lines: linesFrom(form),
    payerId: form.get("payerId"),
    billingAddressText: form.get("billingAddress"),
    billingPostcode: form.get("billingPostcode"),
  });

  refresh(invoiceId);
  return toState(result);
}

export async function discardDraftAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAdmin();

  const invoiceId = String(form.get("invoiceId") ?? "");
  if (!invoiceId) return { error: "No invoice was named." };

  const result = await discardInvoiceDraft({ session, invoiceId });
  if (!result.ok) return toState(result);

  refresh();
  redirect("/admin/invoices");
}

/**
 * Issuing.
 *
 * The confirmation is a typed word rather than a second button, for the same
 * reason releasing a certificate asks somebody to open the PDF first: issuing
 * allocates a number, freezes the document and makes it visible to the agency,
 * and none of that is undoable by pressing back.
 */
export async function issueInvoiceAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAdmin();

  const invoiceId = String(form.get("invoiceId") ?? "");
  if (!invoiceId) return { error: "No invoice was named." };

  const confirm = String(form.get("confirm") ?? "").trim().toUpperCase();
  if (confirm !== "ISSUE") {
    return {
      error: "Type ISSUE to confirm. Nothing was issued.",
      errors: { confirm: "Type ISSUE." },
    };
  }

  const result = await issueInvoice({ session, invoiceId });
  refresh(invoiceId);
  return toState(result);
}

export async function markPaidAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAdmin();

  const invoiceId = String(form.get("invoiceId") ?? "");
  if (!invoiceId) return { error: "No invoice was named." };

  const result = await markInvoicePaid({
    session,
    invoiceId,
    paidOn: form.get("paidOn"),
    note: form.get("paidNote"),
  });

  refresh(invoiceId);
  return toState(result);
}

export async function voidInvoiceAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAdmin();

  const invoiceId = String(form.get("invoiceId") ?? "");
  if (!invoiceId) return { error: "No invoice was named." };

  const result = await voidInvoice({
    session,
    invoiceId,
    reason: form.get("reason"),
  });

  refresh(invoiceId);
  return toState(result);
}

/**
 * Approving a send.
 *
 * The recipients are roles; the screen showed the resolved address beside each
 * one before anybody ticked a box, and the address is frozen onto the queue
 * row here. Nothing is sent by this action — the outbox owns delivery.
 */
export async function sendInvoiceAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAdmin();

  const invoiceId = String(form.get("invoiceId") ?? "");
  if (!invoiceId) return { error: "No invoice was named." };

  const result = await queueInvoiceEmail({
    session,
    invoiceId,
    recipients: form.getAll("recipient").map(String),
  });

  refresh(invoiceId);
  return toState(result);
}

export async function resendInvoiceAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAdmin();

  const invoiceId = String(form.get("invoiceId") ?? "");
  if (!invoiceId) return { error: "No invoice was named." };

  const result = await requeueInvoiceEmail({
    session,
    invoiceId,
    recipient: form.get("recipient"),
  });

  refresh(invoiceId);
  return toState(result);
}
