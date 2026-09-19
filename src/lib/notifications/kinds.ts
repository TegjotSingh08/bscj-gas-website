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
} as const;

export type OutboxKind = (typeof OUTBOX_KINDS)[keyof typeof OUTBOX_KINDS];

/** Who a row is for. A role, never an address — resolved at send time. */
export type OutboxRecipient = "tenant" | "agent" | "bscj";

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
  jobId: string;
  kind: string;
  recipient: string;
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
