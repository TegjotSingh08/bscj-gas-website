import "server-only";

import { asc, eq } from "drizzle-orm";

import { recordAudit } from "@/lib/audit/record";
import { assertCan } from "@/lib/auth/roles";
import type { Session } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import {
  activities,
  agentOrganisations,
  customers,
  invoices,
  jobs,
  outboundEmails,
} from "@/lib/db/schema";
import {
  invoiceApprovalFromKey,
  invoiceRows,
  OUTBOX_KINDS,
  type OutboxRecipient,
} from "@/lib/notifications/kinds";
import { isIssued, type InvoiceStatus } from "./model";
import type { InvoiceResult } from "./invoices";

/**
 * Emailing an issued invoice.
 *
 * Structurally the same as certificate delivery, because the problem is the
 * same one and §20.f paid for the lesson:
 *
 * - **A retry** is the worker trying one intent again. Same row, same
 *   payload, same provider key — which is exactly what makes retrying after
 *   an ambiguous outcome safe.
 * - **A re-approval** is a person deciding to send to the address as it now
 *   stands. It inserts a **new row** with the next approval number, produces
 *   a **new key**, and leaves the earlier row exactly as it was. What was
 *   attempted to the old address is history: an email that may well have
 *   arrived, and rewriting the row would hide it.
 *
 * Nothing is queued for an invoice that is not issued, and the approved
 * address is frozen onto the row at the moment the administrator ticks the
 * box — so an edit to the agency's record between approval and the outbox run
 * cannot silently redirect an invoice.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_FOUND = "That invoice could not be found.";
const NO_DATABASE = "The database is not available.";

/**
 * Who an invoice may be emailed to.
 *
 * The **payer** first, because they are the one who owes it, and the agency
 * when the work came through one. A tenant is deliberately absent: a tenant
 * reaches this system through a scheduling link, which has never been an
 * identity, and a tenant has no business receiving somebody else's bill.
 * Neither does an engineer.
 */
export const INVOICE_RECIPIENTS = ["customer", "agent"] as const;
export type InvoiceRecipient = (typeof INVOICE_RECIPIENTS)[number];

export function isInvoiceRecipient(value: unknown): value is InvoiceRecipient {
  return (
    typeof value === "string" &&
    (INVOICE_RECIPIENTS as readonly string[]).includes(value)
  );
}

export type InvoiceRecipientAddress = {
  recipient: InvoiceRecipient;
  label: string;
  address: string | null;
};

/**
 * The addresses those roles resolve to, right now.
 *
 * Shown before anybody sends, because "email the agency" is not something a
 * person can check and `lettings@example.com` is.
 */
export async function invoiceRecipientAddresses(
  invoiceId: string,
): Promise<InvoiceRecipientAddress[]> {
  const db = getDb();
  if (!db || !UUID.test(invoiceId)) return [];

  const [row] = await db
    .select({
      payerName: customers.name,
      payerCompany: customers.company,
      payerEmail: customers.email,
      organisationName: agentOrganisations.name,
      organisationEmail: agentOrganisations.email,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.billingCustomerId))
    .leftJoin(agentOrganisations, eq(agentOrganisations.id, invoices.agentOrganisationId))
    .where(eq(invoices.id, invoiceId))
    .limit(1);

  if (!row) return [];

  const out: InvoiceRecipientAddress[] = [];
  if (row.payerName) {
    out.push({
      recipient: "customer",
      label: `Payer — ${row.payerCompany ?? row.payerName}`,
      address: row.payerEmail ?? null,
    });
  }
  if (row.organisationName) {
    out.push({
      recipient: "agent",
      label: `Agency — ${row.organisationName}`,
      address: row.organisationEmail ?? null,
    });
  }
  return out;
}

export type QueuedInvoiceEmail = {
  id: string;
  recipient: string;
  recipientAddress: string | null;
  state: string;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
  approval: number | null;
  /** True when the address on file has moved on from the one approved. */
  addressStale: boolean;
};

/**
 * Everything ever queued for this invoice, oldest first.
 *
 * The whole history, including rows that failed. An administrator deciding
 * whether to approve a send again needs to see that one already went to the
 * old address — otherwise "it never arrived" and "it arrived somewhere else"
 * look identical.
 */
export async function listInvoiceEmails(
  invoiceId: string,
): Promise<QueuedInvoiceEmail[]> {
  const db = getDb();
  if (!db || !UUID.test(invoiceId)) return [];

  const rows = await db
    .select({
      id: outboundEmails.id,
      recipient: outboundEmails.recipient,
      recipientAddress: outboundEmails.recipientAddress,
      state: outboundEmails.state,
      attempts: outboundEmails.attempts,
      lastError: outboundEmails.lastError,
      sentAt: outboundEmails.sentAt,
      createdAt: outboundEmails.createdAt,
      idempotencyKey: outboundEmails.idempotencyKey,
    })
    .from(outboundEmails)
    .where(eq(outboundEmails.kind, OUTBOX_KINDS.invoice))
    .orderBy(asc(outboundEmails.createdAt));

  const mine = rows.filter((row) =>
    row.idempotencyKey.startsWith(`${OUTBOX_KINDS.invoice}:${invoiceId}:`),
  );

  const current = await invoiceRecipientAddresses(invoiceId);

  return mine.map((row) => ({
    id: row.id,
    recipient: row.recipient,
    recipientAddress: row.recipientAddress,
    state: row.state,
    attempts: row.attempts,
    lastError: row.lastError,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
    approval: invoiceApprovalFromKey(row.idempotencyKey),
    addressStale:
      row.recipientAddress !== null &&
      current.find((c) => c.recipient === row.recipient)?.address !== row.recipientAddress,
  }));
}

type InvoiceForSending = {
  id: string;
  status: InvoiceStatus;
  number: string | null;
  primaryJobId: string | null;
  agentOrganisationId: string | null;
  documentId: string | null;
  reference: string | null;
};

async function loadForSending(
  db: NonNullable<ReturnType<typeof getDb>>,
  invoiceId: string,
): Promise<InvoiceForSending | null> {
  const [row] = await db
    .select({
      id: invoices.id,
      status: invoices.status,
      number: invoices.number,
      primaryJobId: invoices.primaryJobId,
      agentOrganisationId: invoices.agentOrganisationId,
      documentId: invoices.documentId,
      reference: jobs.reference,
    })
    .from(invoices)
    .leftJoin(jobs, eq(jobs.id, invoices.primaryJobId))
    .where(eq(invoices.id, invoiceId))
    .limit(1);

  return row ? ({ ...row, status: row.status as InvoiceStatus } as InvoiceForSending) : null;
}

/**
 * Queueing the message, to recipients somebody chose.
 *
 * Queued, not sent. The outbox owns delivery with its claiming, its lease and
 * its bounded retries, so a provider outage is a row to retry rather than a
 * lost intent — and pressing the button twice cannot send twice, because the
 * key is unique on the invoice, the recipient and the approval.
 */
export async function queueInvoiceEmail(input: {
  session: Session;
  invoiceId: string;
  recipients: unknown;
}): Promise<InvoiceResult> {
  const { session, invoiceId } = input;
  assertCan(session.user.role, "invoice:write");
  assertCan(session.user.role, "message:write");
  if (session.scope.kind !== "all") return { ok: false, error: NOT_FOUND };

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!UUID.test(invoiceId)) return { ok: false, error: NOT_FOUND };

  const chosen = Array.isArray(input.recipients) ? input.recipients : [];
  const recipients = [...new Set(chosen.filter(isInvoiceRecipient))];
  if (recipients.length === 0) {
    return { ok: false, error: "Choose at least one recipient." };
  }

  const invoice = await loadForSending(db, invoiceId);
  if (!invoice) return { ok: false, error: NOT_FOUND };

  if (!isIssued(invoice.status)) {
    return {
      ok: false,
      error: "Only an issued invoice can be emailed. Issue it first.",
    };
  }
  if (!invoice.documentId || !invoice.primaryJobId) {
    return {
      ok: false,
      error: "That invoice has no stored document. Nothing was queued.",
    };
  }

  // Refuse before queueing if an address is missing: a row that can only ever
  // fail is noise on the reconciliation page.
  const addresses = await invoiceRecipientAddresses(invoiceId);
  const missing = recipients.filter(
    (r) => !addresses.find((a) => a.recipient === r)?.address,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      error: `No email address is on file for: ${missing.join(", ")}. Nothing was queued.`,
    };
  }

  const rows = invoiceRows({
    jobId: invoice.primaryJobId,
    invoiceId: invoice.id,
    recipients: recipients.map((recipient) => ({
      recipient: recipient as OutboxRecipient,
      address: addresses.find((a) => a.recipient === recipient)!.address!,
    })),
  });

  let queued = 0;
  for (const row of rows) {
    try {
      const inserted = await db
        .insert(outboundEmails)
        .values(row)
        .onConflictDoNothing()
        .returning({ id: outboundEmails.id });
      queued += inserted.length;
    } catch {
      // One recipient failing to queue must not lose the others.
    }
  }

  if (queued === 0) {
    return {
      ok: false,
      error: "Already queued for those recipients. Nothing was queued twice.",
    };
  }

  try {
    await db.insert(activities).values({
      jobId: invoice.primaryJobId,
      agentOrganisationId: invoice.agentOrganisationId,
      kind: "invoice.email_queued",
      actor: `user:${session.user.id}`,
      // The roles chosen and the number. Never the addresses.
      detail: { recipients, number: invoice.number },
    });
  } catch {
    /* ignored */
  }

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "invoice.email_queued",
    subjectType: "invoice",
    subjectId: invoice.id,
    detail: { number: invoice.number, reference: invoice.reference, recipients },
  });

  return {
    ok: true,
    message: `Queued for ${queued} recipient${queued === 1 ? "" : "s"}. It goes out on the next run of the outbox.`,
  };
}

/**
 * Approving a send again, to the address as it now stands.
 *
 * **A new intent, not a retry of the old one.** The earlier row is left
 * exactly as it was — including its error and the address it was approved
 * for — and a new row is inserted with the next approval number, which gives
 * it a new key and therefore a new provider key. Reusing the key would have
 * the provider recognise it as the message it already accepted and quietly
 * send nothing, so the corrected address would never hear.
 *
 * Refused while a send for that recipient is still pending: adding a second
 * intent beside one in flight is how somebody receives two invoices.
 */
export async function requeueInvoiceEmail(input: {
  session: Session;
  invoiceId: string;
  recipient: unknown;
}): Promise<InvoiceResult> {
  const { session, invoiceId } = input;
  assertCan(session.user.role, "invoice:write");
  assertCan(session.user.role, "message:write");
  if (session.scope.kind !== "all") return { ok: false, error: NOT_FOUND };

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!UUID.test(invoiceId)) return { ok: false, error: NOT_FOUND };
  if (!isInvoiceRecipient(input.recipient)) {
    return { ok: false, error: "That is not a recipient." };
  }
  const recipient = input.recipient;

  const invoice = await loadForSending(db, invoiceId);
  if (!invoice) return { ok: false, error: NOT_FOUND };
  if (!isIssued(invoice.status)) {
    return { ok: false, error: "Only an issued invoice can be emailed." };
  }
  if (!invoice.documentId || !invoice.primaryJobId) {
    return { ok: false, error: "That invoice has no stored document." };
  }

  const existing = (await listInvoiceEmails(invoiceId)).filter(
    (row) => row.recipient === recipient,
  );

  if (existing.some((row) => row.state === "pending")) {
    return {
      ok: false,
      error:
        "A send to that recipient is still waiting to go out. Let it finish before approving another.",
    };
  }
  if (existing.some((row) => row.state === "sent" && !row.addressStale)) {
    return {
      ok: false,
      error:
        "That recipient has already been sent this invoice at the address on file.",
    };
  }

  const addresses = await invoiceRecipientAddresses(invoiceId);
  const address = addresses.find((a) => a.recipient === recipient)?.address;
  if (!address) {
    return {
      ok: false,
      error: "There is no email address on file for that recipient.",
    };
  }

  const nextApproval =
    existing.reduce((highest, row) => Math.max(highest, row.approval ?? 0), 0) + 1;

  const [row] = invoiceRows({
    jobId: invoice.primaryJobId,
    invoiceId: invoice.id,
    recipients: [
      { recipient: recipient as OutboxRecipient, address, approval: nextApproval },
    ],
  });

  try {
    const inserted = await db
      .insert(outboundEmails)
      .values(row!)
      .onConflictDoNothing()
      .returning({ id: outboundEmails.id });

    if (inserted.length === 0) {
      return { ok: false, error: "That send is already queued." };
    }
  } catch {
    return { ok: false, error: "That could not be queued." };
  }

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "invoice.email_reapproved",
    subjectType: "invoice",
    subjectId: invoice.id,
    detail: { number: invoice.number, recipient, approval: nextApproval },
  });

  return {
    ok: true,
    message: `Approved again for ${recipient}. It goes out on the next run of the outbox.`,
  };
}
