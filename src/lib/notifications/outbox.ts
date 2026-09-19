import "server-only";

import { and, eq, inArray, lt, notInArray } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  activities,
  agentOrganisations,
  jobs,
  outboundEmails,
  properties,
} from "@/lib/db/schema";
import { bookingConfig } from "@/lib/booking/config";
import { productFor, isProductId } from "@/lib/booking/products";
import {
  renderLateBookingAgentEmail,
  renderLateBookingInternalEmail,
  type LateBookingFacts,
} from "@/lib/email/late-booking";
import {
  internalNotificationRecipient,
  sendOutboxEmail,
} from "@/lib/email/send";
import type { DeadlineSource } from "@/lib/scheduling/deadline";

/**
 * Intent recorded durably; delivery attempted separately.
 *
 * The same shape as every other external call in this application, for the
 * same reason: Postgres cannot make an HTTP request part of its transaction.
 * A row in `outbound_email` is written **in the batch that records the
 * appointment**, so the decision to tell somebody survives whatever happens to
 * the sending. Nothing about a notification can undo a confirmed appointment.
 *
 * **Three states, and they mean different things.**
 *
 * - `pending` — queued. Nobody has been told yet, and it will be retried.
 * - `sent` — **the provider accepted it.** That is all it means. It is not a
 *   delivery receipt, it is not proof anybody read it, and it must never be
 *   reported as either.
 * - `failed` — attempted `MAX_ATTEMPTS` times and given up. Terminal, and it
 *   needs a person.
 *
 * `cancelled` is the fourth and is not a failure: the appointment changed
 * under the notification before it went out, so telling anyone would have been
 * worse than telling nobody.
 */

export const LATE_BOOKING_KIND = "late-booking-exception";

/** Who a row is for. A role, never an address — see `recipientAddress`. */
export type OutboxRecipient = "agent" | "bscj";

export const OUTBOX_RECIPIENTS: OutboxRecipient[] = ["agent", "bscj"];

/** Bounded retry. Beyond this a person is needed, not another attempt. */
export const MAX_ATTEMPTS = 5;

/** How many rows one drain takes on. */
export const OUTBOX_BATCH_LIMIT = 25;

/**
 * The key a row is unique on.
 *
 * It carries the **appointment**, not just the job, which is what makes a
 * reschedule a different notification rather than a duplicate of the old one —
 * and what lets a stale row be recognised by comparing the key against the
 * appointment the job now holds.
 */
export function lateBookingKey(
  jobId: string,
  appointmentStart: Date,
  recipient: OutboxRecipient,
): string {
  return `${LATE_BOOKING_KIND}:${jobId}:${appointmentStart.toISOString()}:${recipient}`;
}

/** The appointment a key was written for, or null if it is not one of ours. */
export function appointmentFromKey(key: string): Date | null {
  const parts = key.split(":");
  // kind : jobId : <ISO instant, which itself contains colons> : recipient
  if (parts.length < 4 || parts[0] !== LATE_BOOKING_KIND) return null;
  const iso = parts.slice(2, -1).join(":");
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The rows for one late booking, ready to go into the caller's batch.
 *
 * Returned rather than written, so they land in the **same transaction** as
 * the appointment they describe. `onConflictDoNothing` is the caller's to add:
 * a tenant who submits twice must not queue two of each.
 */
export function lateBookingRows(input: {
  jobId: string;
  appointmentStart: Date;
}): { jobId: string; kind: string; recipient: string; idempotencyKey: string }[] {
  return OUTBOX_RECIPIENTS.map((recipient) => ({
    jobId: input.jobId,
    kind: LATE_BOOKING_KIND,
    recipient,
    idempotencyKey: lateBookingKey(input.jobId, input.appointmentStart, recipient),
  }));
}

/**
 * Stands down anything queued for an appointment this job no longer has.
 *
 * Called when an appointment moves. A notification that has not gone out yet
 * describes a time that is no longer true, and sending it would tell an agency
 * about a visit that is not going to happen. Only `pending` rows are touched —
 * something already accepted by the provider cannot be recalled, and pretending
 * otherwise by rewriting its state would be a lie in the record.
 */
export async function cancelSupersededNotifications(
  jobId: string,
  keepAppointmentStart: Date | null,
): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const keep = keepAppointmentStart
    ? OUTBOX_RECIPIENTS.map((r) => lateBookingKey(jobId, keepAppointmentStart, r))
    : [];

  try {
    const cancelled = await db
      .update(outboundEmails)
      .set({
        state: "cancelled",
        lastError: "superseded_by_appointment_change",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outboundEmails.jobId, jobId),
          eq(outboundEmails.kind, LATE_BOOKING_KIND),
          eq(outboundEmails.state, "pending"),
          /*
            Everything except the rows for the appointment being kept.

            `notInArray`, not a disjunction of inequalities: "key ≠ A OR key ≠
            B" is true of *every* key, because no key can equal both. Written
            that way it cancelled the notifications it had just queued.
          */
          ...(keep.length
            ? [notInArray(outboundEmails.idempotencyKey, keep)]
            : []),
        ),
      )
      .returning({ id: outboundEmails.id });

    return cancelled.length;
  } catch {
    // The row stays `pending` and the drain will recognise it as stale from
    // its key. Cancelling here is the fast path, not the guarantee.
    return 0;
  }
}

export type DrainReport = {
  considered: number;
  /** Accepted by the provider. Not delivered — accepted. */
  accepted: number;
  /** Stood down because the appointment changed underneath them. */
  cancelled: number;
  /** Still queued: waiting for the calendar, or for another attempt. */
  stillQueued: number;
  /** Given up on after `MAX_ATTEMPTS`. Needs a person. */
  failed: number;
  /** Rows that could not be sent because no address is configured. */
  missingRecipient: number;
};

const EMPTY: DrainReport = {
  considered: 0,
  accepted: 0,
  cancelled: 0,
  stillQueued: 0,
  failed: 0,
  missingRecipient: 0,
};

/**
 * One bounded pass over the outbox.
 *
 * Never throws. Every outcome is recorded on the row it belongs to, so a
 * partial pass leaves the rest of the queue exactly as it found it.
 */
export async function drainOutbox(
  limit = OUTBOX_BATCH_LIMIT,
): Promise<DrainReport> {
  const db = getDb();
  if (!db) return EMPTY;

  const report: DrainReport = { ...EMPTY };

  let rows: {
    id: string;
    jobId: string | null;
    recipient: string;
    idempotencyKey: string;
    attempts: number;
  }[];

  try {
    rows = await db
      .select({
        id: outboundEmails.id,
        jobId: outboundEmails.jobId,
        recipient: outboundEmails.recipient,
        idempotencyKey: outboundEmails.idempotencyKey,
        attempts: outboundEmails.attempts,
      })
      .from(outboundEmails)
      .where(
        and(
          eq(outboundEmails.kind, LATE_BOOKING_KIND),
          eq(outboundEmails.state, "pending"),
          lt(outboundEmails.attempts, MAX_ATTEMPTS),
        ),
      )
      .limit(limit);
  } catch {
    return report;
  }

  report.considered = rows.length;

  for (const row of rows) {
    try {
      const outcome = await deliverRow(row);
      report[outcome] += 1;
    } catch {
      // A row that blew up is left `pending` for the next pass rather than
      // being marked failed on the strength of an error nobody has seen.
      report.stillQueued += 1;
    }
  }

  return report;
}

type RowOutcome =
  | "accepted"
  | "cancelled"
  | "stillQueued"
  | "failed"
  | "missingRecipient";

async function deliverRow(row: {
  id: string;
  jobId: string | null;
  recipient: string;
  idempotencyKey: string;
  attempts: number;
}): Promise<RowOutcome> {
  const db = getDb();
  if (!db || !row.jobId) return "stillQueued";

  const [found] = await db
    .select({ job: jobs, property: properties, organisationName: agentOrganisations.name, organisationEmail: agentOrganisations.email })
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .leftJoin(
      agentOrganisations,
      eq(agentOrganisations.id, jobs.agentOrganisationId),
    )
    .where(eq(jobs.id, row.jobId))
    .limit(1);

  if (!found) return stand(db, row.id, "job_missing");

  const { job, property } = found;
  const intendedFor = appointmentFromKey(row.idempotencyKey);

  /*
    Stale, in either direction: the appointment moved, or the job was called
    off. Either way the message would describe a visit that is not happening.
  */
  if (
    job.cancelledAt ||
    job.lifecycleStatus === "cancelled" ||
    !job.appointmentStart ||
    !job.appointmentEnd ||
    !intendedFor ||
    job.appointmentStart.getTime() !== intendedFor.getTime()
  ) {
    return stand(db, row.id, "superseded_by_appointment_change");
  }

  /*
    Never ahead of the diary.

    An agency told "your tenant booked Tuesday" before the event exists is one
    phone call away from discovering it does not. The row stays queued — this
    is not a failure and must not consume an attempt — and the calendar
    reconciliation that runs alongside this will resolve it.
  */
  if (job.calendarSyncState !== "synced") return "stillQueued";

  // The exception must still be recorded. A job whose exception was cleared by
  // a reschedule into the deadline has nothing to announce.
  if (!job.deadlineExceptionAt) {
    return stand(db, row.id, "exception_cleared");
  }

  const recipient = row.recipient as OutboxRecipient;
  const to =
    recipient === "agent"
      ? found.organisationEmail
      : internalNotificationRecipient();

  if (!to) {
    /*
      A deployment gap, and it has to be *visible*. The attempt is counted so
      it cannot spin forever, and the reason is recorded so the admin page can
      say which address is missing rather than "failed".
    */
    return await record(
      db,
      row,
      "failed_attempt",
      recipient === "agent" ? "agent_email_missing" : "bscj_email_missing",
    ).then(() => "missingRecipient" as const);
  }

  if (!isProductId(job.productId)) {
    return stand(db, row.id, "unknown_product");
  }

  /*
    The deadline **as it was when the tenant accepted it**, not as it is now.

    An agent who moves `complete_by_date` after the fact must not change what
    the tenant was warned about, and the email must not silently re-describe a
    past decision against a newer date. The exception's own timeline entry is
    the frozen record, so that is what is read.
  */
  const recorded = await readException(db, job.id, job.appointmentStart);
  if (!recorded) return stand(db, row.id, "exception_detail_missing");

  const facts: LateBookingFacts = {
    reference: job.reference,
    address: [property.houseOrName, property.street, property.town]
      .filter(Boolean)
      .join(", "),
    postcode: property.postcode,
    productName: productFor(job.productId).name,
    organisationName: found.organisationName,
    deadlineDate: recorded.deadlineDate,
    deadlineSource: recorded.deadlineSource,
    requestedBy: recorded.requestedBy,
    certificateDueBy: recorded.certificateDueBy,
    appointmentStart: job.appointmentStart,
    appointmentEnd: job.appointmentEnd,
    acknowledgedAt: recorded.acknowledgedAt,
    timeZone: bookingConfig.timeZone,
  };

  const email =
    recipient === "agent"
      ? renderLateBookingAgentEmail(facts)
      : renderLateBookingInternalEmail(facts);

  const result = await sendOutboxEmail({
    kind: recipient === "agent" ? "late-booking-agent" : "late-booking-internal",
    to,
    email,
    reference: job.reference,
    idempotencySuffix: recipient,
  });

  if (result.status === "sent") {
    await db
      .update(outboundEmails)
      .set({
        state: "sent",
        sentAt: new Date(),
        attempts: row.attempts + 1,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(outboundEmails.id, row.id));
    return "accepted";
  }

  const reason =
    result.status === "not_configured" ? "transport_not_configured" : result.reason;
  await record(db, row, "failed_attempt", reason);
  return row.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "stillQueued";
}

/** The kind of timeline entry a recorded exception writes. */
export const DEADLINE_EXCEPTION_KIND = "appointment.deadline_exception";

export type RecordedException = {
  deadlineDate: string;
  deadlineSource: DeadlineSource;
  requestedBy: string | null;
  certificateDueBy: string | null;
  acknowledgedAt: Date;
};

/**
 * Reads the frozen exception for one appointment.
 *
 * Matched on the appointment as well as the job, so a job that has been late
 * twice describes each occasion with the facts that applied to it.
 */
export async function readException(
  db: NonNullable<ReturnType<typeof getDb>>,
  jobId: string,
  appointmentStart: Date,
): Promise<RecordedException | null> {
  const rows = await db
    .select({ detail: activities.detail })
    .from(activities)
    .where(
      and(
        eq(activities.jobId, jobId),
        eq(activities.kind, DEADLINE_EXCEPTION_KIND),
      ),
    )
    .limit(20);

  for (const row of rows) {
    const parsed = parseException(row.detail, appointmentStart);
    if (parsed) return parsed;
  }
  return null;
}

/** Validates rather than casts: a malformed entry must not become an email. */
export function parseException(
  detail: unknown,
  appointmentStart: Date,
): RecordedException | null {
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as Record<string, unknown>;

  if (typeof d.appointmentStart !== "string") return null;
  const when = new Date(d.appointmentStart);
  if (Number.isNaN(when.getTime())) return null;
  if (when.getTime() !== appointmentStart.getTime()) return null;

  if (typeof d.deadlineDate !== "string") return null;
  const source = d.deadlineSource;
  if (source !== "requested" && source !== "certificate" && source !== "both") {
    return null;
  }

  const acknowledgedAt =
    typeof d.acknowledgedAt === "string" ? new Date(d.acknowledgedAt) : null;
  if (!acknowledgedAt || Number.isNaN(acknowledgedAt.getTime())) return null;

  return {
    deadlineDate: d.deadlineDate,
    deadlineSource: source,
    requestedBy: typeof d.requestedBy === "string" ? d.requestedBy : null,
    certificateDueBy:
      typeof d.certificateDueBy === "string" ? d.certificateDueBy : null,
    acknowledgedAt,
  };
}

async function stand(
  db: NonNullable<ReturnType<typeof getDb>>,
  id: string,
  reason: string,
): Promise<RowOutcome> {
  await db
    .update(outboundEmails)
    .set({ state: "cancelled", lastError: reason, updatedAt: new Date() })
    .where(eq(outboundEmails.id, id));
  return "cancelled";
}

async function record(
  db: NonNullable<ReturnType<typeof getDb>>,
  row: { id: string; attempts: number },
  _kind: "failed_attempt",
  reason: string,
): Promise<void> {
  const attempts = row.attempts + 1;
  await db
    .update(outboundEmails)
    .set({
      attempts,
      lastError: reason,
      state: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      updatedAt: new Date(),
    })
    .where(eq(outboundEmails.id, row.id));
}

/** What is outstanding, for the admin view. Counts only, no addresses. */
export async function readOutboxSummary(): Promise<{
  pending: number;
  failed: number;
  missingRecipient: number;
}> {
  const db = getDb();
  if (!db) return { pending: 0, failed: 0, missingRecipient: 0 };

  try {
    const rows = await db
      .select({
        state: outboundEmails.state,
        lastError: outboundEmails.lastError,
      })
      .from(outboundEmails)
      .where(
        and(
          eq(outboundEmails.kind, LATE_BOOKING_KIND),
          inArray(outboundEmails.state, ["pending", "failed"]),
        ),
      );

    return {
      pending: rows.filter((r) => r.state === "pending").length,
      failed: rows.filter((r) => r.state === "failed").length,
      missingRecipient: rows.filter((r) =>
        (r.lastError ?? "").endsWith("_email_missing"),
      ).length,
    };
  } catch {
    return { pending: 0, failed: 0, missingRecipient: 0 };
  }
}

/**
 * The recorded exception for a job's current appointment, for the job views.
 *
 * Returns what the tenant was actually warned about, frozen at the moment they
 * accepted it — not a recomputation against today's dates, which could quietly
 * re-describe a past decision.
 */
export async function fetchRecordedException(
  jobId: string,
  appointmentStart: Date | null,
): Promise<RecordedException | null> {
  const db = getDb();
  if (!db || !appointmentStart) return null;
  try {
    return await readException(db, jobId, appointmentStart);
  } catch {
    return null;
  }
}

/** Every notification queued for one job's current appointment, for the views. */
export async function fetchNotificationStates(
  jobId: string,
): Promise<{ recipient: string; state: string; attempts: number; lastError: string | null }[]> {
  const db = getDb();
  if (!db) return [];
  try {
    return await db
      .select({
        recipient: outboundEmails.recipient,
        state: outboundEmails.state,
        attempts: outboundEmails.attempts,
        lastError: outboundEmails.lastError,
      })
      .from(outboundEmails)
      .where(
        and(
          eq(outboundEmails.jobId, jobId),
          eq(outboundEmails.kind, LATE_BOOKING_KIND),
        ),
      )
      .limit(20);
  } catch {
    return [];
  }
}
