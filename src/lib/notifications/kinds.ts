/**
 * What the outbox can be asked to send, and how each intent is keyed.
 *
 * Pure, and separate from the worker, so the code that *queues* an intent
 * (inside a job's own transaction) does not drag the email transport, the
 * Google client or the renderers in with it.
 *
 * Every key is unique on the thing that makes the intent distinct:
 *
 * - an **invitation** is keyed on the moment it was raised, so a deliberate
 *   resend is a new intent rather than a duplicate of the first;
 * - an **appointment confirmation** and a **late-booking alert** are keyed on
 *   the appointment, so a reschedule produces a new intent and a stale one can
 *   be recognised by comparing the key with the job's current appointment.
 */

export const OUTBOX_KINDS = {
  invitation: "tenant-scheduling-invitation",
  confirmation: "tenant-appointment-confirmation",
  lateBooking: "late-booking-exception",
  /*
    A released certificate, to one explicitly chosen recipient.

    Keyed on the certificate **version** and the recipient, so a corrected
    certificate is a new intent rather than a duplicate of the one already
    sent, and two recipients are two rows that succeed or fail apart.
  */
  certificate: "certificate-release",
  /*
    An issued invoice, to one explicitly chosen recipient.

    Keyed on the invoice and the recipient — an invoice has no versions, so
    there is nothing else to distinguish one send from another — plus the
    approval number, for the same reason the certificate key carries one: a
    corrected address is a *new* intent and must not be deduplicated away by
    the provider as a repeat of the message it already accepted.
  */
  invoice: "invoice-issue",
  /*
    Account access: an invitation, and a password reset.

    Both are about an **account**, not a job, and are the first kinds in this
    queue that are. They are here rather than sent inline for exactly the
    reason everything else is: an administrator opening an agency must not
    watch an email go out before the account exists, and must not be told the
    account failed because a mail provider was briefly unreachable.

    Each is keyed on the moment it was raised, like a tenant invitation and
    for the same reason: a second one is a deliberate act — a resend, or
    somebody asking again — not a duplicate to collapse.
  */
  accountInvitation: "account-invitation",
  passwordReset: "account-password-reset",
} as const;

export type OutboxKind = (typeof OUTBOX_KINDS)[keyof typeof OUTBOX_KINDS];

/**
 * The kinds that are about an account rather than a job.
 *
 * The worker branches on this **before** it tries to load a job, because
 * these rows deliberately have no `job_id` and never will.
 */
export const ACCOUNT_SCOPED_KINDS: OutboxKind[] = [
  OUTBOX_KINDS.accountInvitation,
  OUTBOX_KINDS.passwordReset,
];

/** Who a row is for. A role, never an address — resolved at send time. */
export type OutboxRecipient =
  | "tenant"
  | "agent"
  | "bscj"
  | "customer"
  /** The account holder themselves. The only address a credential may go to. */
  | "account";

/** The kinds whose message describes a specific appointment. */
export const APPOINTMENT_SCOPED_KINDS: OutboxKind[] = [
  OUTBOX_KINDS.confirmation,
  OUTBOX_KINDS.lateBooking,
];

export const LATE_BOOKING_RECIPIENTS: OutboxRecipient[] = ["agent", "bscj"];

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * An invitation, keyed on when it was raised.
 *
 * Two invitations for one job are a legitimate thing to want — the first was
 * never opened, the address was wrong, the tenant asked again — so the key
 * must not collapse them. It is the *resend control* that decides whether a
 * second one is warranted, not a unique index.
 */
export function invitationKey(jobId: string, issuedAt: Date): string {
  return `${OUTBOX_KINDS.invitation}:${jobId}:${issuedAt.toISOString()}`;
}

/**
 * A tenant's appointment confirmation.
 *
 * This shape predates the worker — `confirmTenantAppointment` has been writing
 * it since V2.3 — so it is kept exactly as it was rather than migrated to a
 * tidier one. A key in a unique index is not something to rewrite for looks.
 */
export function confirmationKey(jobId: string, appointmentStart: Date): string {
  return `appointment:${jobId}:${appointmentStart.toISOString()}`;
}

export function lateBookingKey(
  jobId: string,
  appointmentStart: Date,
  recipient: OutboxRecipient,
): string {
  return `${OUTBOX_KINDS.lateBooking}:${jobId}:${appointmentStart.toISOString()}:${recipient}`;
}

/**
 * The appointment a key was written for, or null if it names none.
 *
 * An ISO instant contains colons, so the timestamp is reassembled from the
 * middle of the key rather than taken as a single field.
 */
export function appointmentFromKey(key: string): Date | null {
  const parts = key.split(":");
  if (parts.length < 3) return null;

  let iso: string;
  if (parts[0] === OUTBOX_KINDS.lateBooking) {
    // kind : jobId : <instant> : recipient
    if (parts.length < 4) return null;
    iso = parts.slice(2, -1).join(":");
  } else if (parts[0] === "appointment") {
    // appointment : jobId : <instant>
    iso = parts.slice(2).join(":");
  } else {
    return null;
  }

  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Rows, returned rather than written
// ---------------------------------------------------------------------------

export type OutboxRow = {
  /** Null for the account-scoped kinds, which describe no job. */
  jobId: string | null;
  /** Set only for the account-scoped kinds. */
  appUserId?: string;
  kind: string;
  recipient: string;
  /** Frozen at queue time for the kinds a person approves. See the schema. */
  recipientAddress?: string;
  idempotencyKey: string;
};

/** The single row for an invitation. */
export function invitationRow(input: {
  jobId: string;
  issuedAt: Date;
}): OutboxRow {
  return {
    jobId: input.jobId,
    kind: OUTBOX_KINDS.invitation,
    recipient: "tenant",
    idempotencyKey: invitationKey(input.jobId, input.issuedAt),
  };
}

/** The two rows for a late booking: the agency, and BSCJ. */
export function lateBookingRows(input: {
  jobId: string;
  appointmentStart: Date;
}): OutboxRow[] {
  return LATE_BOOKING_RECIPIENTS.map((recipient) => ({
    jobId: input.jobId,
    kind: OUTBOX_KINDS.lateBooking,
    recipient,
    idempotencyKey: lateBookingKey(
      input.jobId,
      input.appointmentStart,
      recipient,
    ),
  }));
}

/**
 * A released certificate, keyed on the version, the recipient **and the
 * approval**.
 *
 * The approval number is what makes a re-approval a different message. It
 * has to be, because this key is also the provider's idempotency key: an
 * administrator who notices the address changed, corrects it and sends
 * again is asking for the document to reach a *different address*, and
 * reusing the key would have Resend recognise it as the message it already
 * accepted and quietly send nothing.
 *
 * So:
 *
 * - **A retry of the same intent** — the worker's own bounded attempts —
 *   keeps the same key and the same payload, which is what makes a retry
 *   after an ambiguous outcome safe.
 * - **A newly approved address** is a new approval number, a new row and a
 *   new key. The earlier row is left exactly as it was, because what was
 *   attempted to the old address is history and deleting it would hide an
 *   email that may well have arrived.
 */
export function certificateKey(
  certificateId: string,
  recipient: OutboxRecipient,
  approval = 1,
): string {
  return `${OUTBOX_KINDS.certificate}:${certificateId}:${recipient}:${approval}`;
}

/**
 * One row per recipient the administrator actually chose.
 *
 * The address is carried through and frozen on the row: it is the one the
 * administrator had in front of them when they ticked the box, and the
 * worker sends to that and nothing else. `approval` distinguishes a fresh
 * approval of a *different* address from a retry of the same intent — see
 * `certificateKey`.
 */
export function certificateRows(input: {
  jobId: string;
  certificateId: string;
  recipients: readonly {
    recipient: OutboxRecipient;
    address: string;
    /** 1 for the first approval, higher for a re-approval. */
    approval?: number;
  }[];
}): OutboxRow[] {
  return input.recipients.map(({ recipient, address, approval }) => ({
    jobId: input.jobId,
    kind: OUTBOX_KINDS.certificate,
    recipient,
    recipientAddress: address,
    idempotencyKey: certificateKey(input.certificateId, recipient, approval ?? 1),
  }));
}

/** The certificate a key was written for, or null if it names none. */
export function certificateFromKey(key: string): string | null {
  const parts = key.split(":");
  // kind : certificateId : recipient : approval
  if (parts.length !== 4 || parts[0] !== OUTBOX_KINDS.certificate) return null;
  return parts[1] || null;
}

/** Which approval a key belongs to, so the next one can be numbered. */
export function approvalFromKey(key: string): number | null {
  const parts = key.split(":");
  if (parts.length !== 4 || parts[0] !== OUTBOX_KINDS.certificate) return null;
  const approval = Number.parseInt(parts[3], 10);
  return Number.isInteger(approval) && approval > 0 ? approval : null;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * An issued invoice, keyed on the invoice, the recipient and the approval.
 *
 * The same three-part shape as a certificate, and for the same reason: this
 * key is also the provider's idempotency key, so a **retry** of one intent
 * must keep it and a **re-approval** to a corrected address must not.
 *
 * An invoice has no version component because an issued invoice is never
 * reissued — correcting one is a void and a new invoice, which has its own
 * id and therefore its own keys.
 */
export function invoiceKey(
  invoiceId: string,
  recipient: OutboxRecipient,
  approval = 1,
): string {
  return `${OUTBOX_KINDS.invoice}:${invoiceId}:${recipient}:${approval}`;
}

/** One row per recipient the administrator actually chose. */
export function invoiceRows(input: {
  /**
   * Required. V2.8 issues per-job invoices only, and the worker needs the job
   * to describe the property the invoice is for. A consolidated invoice, when
   * it exists, will need a row shape that does not name one.
   */
  jobId: string;
  invoiceId: string;
  recipients: readonly {
    recipient: OutboxRecipient;
    address: string;
    /** 1 for the first approval, higher for a re-approval. */
    approval?: number;
  }[];
}): OutboxRow[] {
  return input.recipients.map(({ recipient, address, approval }) => ({
    jobId: input.jobId,
    kind: OUTBOX_KINDS.invoice,
    recipient,
    recipientAddress: address,
    idempotencyKey: invoiceKey(input.invoiceId, recipient, approval ?? 1),
  }));
}

/** The invoice a key was written for, or null if it names none. */
export function invoiceFromKey(key: string): string | null {
  const parts = key.split(":");
  // kind : invoiceId : recipient : approval
  if (parts.length !== 4 || parts[0] !== OUTBOX_KINDS.invoice) return null;
  return parts[1] || null;
}

/**
 * Which approval an invoice key belongs to, so the next one can be numbered.
 *
 * Separate from `approvalFromKey` rather than generalised, because that
 * function guards on the certificate kind and widening it would let a key of
 * one kind be read as the other — which is how a certificate's provider key
 * and an invoice's could collide.
 */
export function invoiceApprovalFromKey(key: string): number | null {
  const parts = key.split(":");
  if (parts.length !== 4 || parts[0] !== OUTBOX_KINDS.invoice) return null;
  const approval = Number.parseInt(parts[3], 10);
  return Number.isInteger(approval) && approval > 0 ? approval : null;
}

// ---------------------------------------------------------------------------
// Account access
// ---------------------------------------------------------------------------

/**
 * An invitation or a reset, keyed on the moment it was raised.
 *
 * Two of either for one account are a legitimate thing to want — the first was
 * never opened, the address was mistyped, somebody asked again — so the key
 * must not collapse them. What decides whether a second one is warranted is
 * the resend control and the rate limit, not a unique index.
 */
export function accountAccessKey(
  kind: OutboxKind,
  userId: string,
  issuedAt: Date,
): string {
  return `${kind}:${userId}:${issuedAt.toISOString()}`;
}

/**
 * The single row for an invitation or a reset.
 *
 * **No address is frozen onto it.** The recipient is resolved at send time
 * from the account itself, which is the only address an account credential may
 * ever go to — freezing one would mean a row could outlive a corrected email
 * and send a working link somewhere the account no longer is.
 */
export function accountAccessRow(input: {
  userId: string;
  kind: OutboxKind;
  issuedAt: Date;
}): OutboxRow {
  return {
    jobId: null,
    appUserId: input.userId,
    kind: input.kind,
    recipient: "account",
    idempotencyKey: accountAccessKey(input.kind, input.userId, input.issuedAt),
  };
}
