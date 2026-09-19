import "server-only";

import { and, eq, inArray, lt, notInArray, or } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  activities,
  agentOrganisations,
  jobs,
  outboundEmails,
  properties,
  schedulingTokens,
  tenancies,
} from "@/lib/db/schema";
import { bookingConfig } from "@/lib/booking/config";
import { business } from "@/lib/business";
import { productFor, isProductId } from "@/lib/booking/products";
import {
  renderLateBookingAgentEmail,
  renderLateBookingInternalEmail,
  type LateBookingFacts,
} from "@/lib/email/late-booking";
import {
  renderTenantAppointmentEmail,
  renderTenantInvitationEmail,
} from "@/lib/email/tenant-scheduling";
import {
  internalNotificationRecipient,
  sendOutboxEmail,
} from "@/lib/email/send";
import { createSchedulingToken } from "@/lib/scheduling/token";
import type { DeadlineSource } from "@/lib/scheduling/deadline";
import {
  appointmentFromKey,
  APPOINTMENT_SCOPED_KINDS,
  confirmationKey,
  lateBookingKey,
  LATE_BOOKING_RECIPIENTS,
  OUTBOX_KINDS,
  type OutboxRecipient,
} from "./kinds";

export * from "./kinds";

/**
 * Intent recorded durably; delivery attempted separately.
 *
 * The same shape as every other external call here, for the same reason:
 * Postgres cannot make an HTTP request part of its transaction. A row in
 * `outbound_email` is written **in the batch that records the thing it
 * describes**, so the decision to tell somebody survives whatever happens to
 * the sending. Nothing about a notification can undo a job or an appointment.
 *
 * **Three states, and they mean different things.**
 *
 * - `pending` — queued. Nobody has been told yet, and it will be retried.
 * - `sent` — **the provider accepted it.** That is all it means. Not a
 *   delivery receipt, not proof anybody read it, and never reported as either.
 * - `failed` — attempted `MAX_ATTEMPTS` times and given up. Terminal; it needs
 *   a person.
 *
 * `cancelled` is the fourth and is not a failure: the thing the message
 * described changed underneath it, so telling anyone would have been worse
 * than telling nobody.
 */

/** Bounded retry. Beyond this a person is needed, not another attempt. */
export const MAX_ATTEMPTS = 5;

/** How many rows one pass takes on. */
export const OUTBOX_BATCH_LIMIT = 25;

/**
 * How long a claimed row is left alone.
 *
 * **The conditional claim is not enough on its own.** It stops two workers
 * that read the *same* attempt count, but a worker starting a second later
 * reads the count the first one just wrote, claims from there, and sends the
 * same message again — which is exactly what happened: two invitations, two
 * links, one intent. Comparing attempt counts hid it, because both workers
 * incremented perfectly.
 *
 * So a claim also takes a lease. `updated_at` is moved to now, and a row that
 * recently moved is not considered. A worker arriving mid-send sees the lease
 * and walks past.
 *
 * It doubles as retry backoff — a failed attempt waits one window before
 * another is made — and as crash recovery: a process that dies holding a row
 * loses its lease and the row becomes eligible again on its own.
 */
export const LEASE_SECONDS = 120;

const ALL_KINDS: string[] = [
  OUTBOX_KINDS.invitation,
  OUTBOX_KINDS.confirmation,
  OUTBOX_KINDS.lateBooking,
];

/** The statuses from which a tenant may still act on an invitation link. */
const INVITABLE = ["tenant_outreach", "awaiting_tenant", "scheduled"];

// ---------------------------------------------------------------------------
// Standing down what is no longer true
// ---------------------------------------------------------------------------

/**
 * Cancels anything queued about an appointment this job no longer has.
 *
 * Called when an appointment moves. An unsent message describing a time that
 * is no longer true would tell a tenant or an agency about a visit that is not
 * going to happen. **Only `pending` rows are touched** — something already
 * accepted by the provider cannot be recalled, and rewriting its state to
 * pretend otherwise would be a lie in the record.
 *
 * Invitations are deliberately left alone: an invitation is about a job rather
 * than a time, so a change of time does not make one wrong.
 */
export async function cancelSupersededNotifications(
  jobId: string,
  keepAppointmentStart: Date | null,
): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const keep = keepAppointmentStart
    ? [
        confirmationKey(jobId, keepAppointmentStart),
        ...LATE_BOOKING_RECIPIENTS.map((r) =>
          lateBookingKey(jobId, keepAppointmentStart, r),
        ),
      ]
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
          inArray(outboundEmails.kind, APPOINTMENT_SCOPED_KINDS),
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
    // The row stays `pending` and the worker recognises it as stale from its
    // key. Cancelling here is the fast path, not the guarantee.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

export type DrainReport = {
  considered: number;
  /** Claimed by this worker. Lower than `considered` when another took them. */
  claimed: number;
  /** Accepted by the provider. Not delivered — accepted. */
  accepted: number;
  /** Stood down because what they described changed underneath them. */
  cancelled: number;
  /** Still queued: waiting for the calendar, or for another attempt. */
  stillQueued: number;
  /** Given up on after `MAX_ATTEMPTS`. Needs a person. */
  failed: number;
  /** Could not be sent because no address is configured for the recipient. */
  missingRecipient: number;
};

const EMPTY: DrainReport = {
  considered: 0,
  claimed: 0,
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
  if (!db) return { ...EMPTY };

  const report: DrainReport = { ...EMPTY };

  let rows: {
    id: string;
    jobId: string | null;
    kind: string;
    recipient: string;
    idempotencyKey: string;
    attempts: number;
  }[];

  try {
    rows = await db
      .select({
        id: outboundEmails.id,
        jobId: outboundEmails.jobId,
        kind: outboundEmails.kind,
        recipient: outboundEmails.recipient,
        idempotencyKey: outboundEmails.idempotencyKey,
        attempts: outboundEmails.attempts,
      })
      .from(outboundEmails)
      .where(
        and(
          inArray(outboundEmails.kind, ALL_KINDS),
          eq(outboundEmails.state, "pending"),
          lt(outboundEmails.attempts, MAX_ATTEMPTS),
          /*
            Never attempted, or its lease has run out.

            The first branch keeps a freshly queued message from waiting a
            lease window to go out — nothing holds it, so nothing needs to
            expire. Two workers arriving together both match it and the
            conditional claim below decides between them.

            The second branch is what makes a row in flight invisible.
          */
          or(
            eq(outboundEmails.attempts, 0),
            lt(
              outboundEmails.updatedAt,
              new Date(Date.now() - LEASE_SECONDS * 1000),
            ),
          )!,
        ),
      )
      .limit(limit);
  } catch {
    return report;
  }

  report.considered = rows.length;

  for (const row of rows) {
    try {
      /*
        One worker per intent.

        Two workers reading the same page of the queue both see this row. The
        claim is a conditional update on the attempt count each of them read,
        so exactly one wins and the other moves on — without a lease column, a
        lock table or a migration.

        The attempt is counted **before** the send, on purpose. If the process
        dies between the provider accepting and the row being updated, the
        attempt is already spent, so an ambiguous outcome costs one retry
        rather than becoming an unbounded loop. Resend's own idempotency key
        (see `sendOutboxEmail`) is what stops that retry becoming a second
        email.

        The claim also moves `updated_at`, which takes the lease. Between them,
        a worker that read the same row before this one cannot claim it, and a
        worker that arrives after cannot even see it.
      */
      if (!(await claim(db, row))) continue;
      report.claimed += 1;

      const outcome = await deliverRow({ ...row, attempts: row.attempts + 1 });
      report[outcome] += 1;
    } catch {
      // A row that blew up keeps its spent attempt and stays pending, rather
      // than being marked failed on the strength of an error nobody has seen.
      report.stillQueued += 1;
    }
  }

  return report;
}

/**
 * Wins the row and takes its lease, or reports that somebody else did.
 *
 * Guarded on the attempt count the caller read, so two workers holding the
 * same reading cannot both win. `updated_at` moves as part of the same
 * statement, so a worker that reads *afterwards* does not consider the row at
 * all — see `LEASE_SECONDS`.
 */
async function claim(
  db: NonNullable<ReturnType<typeof getDb>>,
  row: { id: string; attempts: number },
): Promise<boolean> {
  const won = await db
    .update(outboundEmails)
    .set({ attempts: row.attempts + 1, updatedAt: new Date() })
    .where(
      and(
        eq(outboundEmails.id, row.id),
        eq(outboundEmails.state, "pending"),
        eq(outboundEmails.attempts, row.attempts),
      ),
    )
    .returning({ id: outboundEmails.id });

  return won.length > 0;
}

type RowOutcome =
  | "accepted"
  | "cancelled"
  | "stillQueued"
  | "failed"
  | "missingRecipient";

type LoadedJob = {
  job: typeof jobs.$inferSelect;
  property: typeof properties.$inferSelect;
  organisationName: string | null;
  organisationEmail: string | null;
  tenantEmail: string | null;
};

type ClaimedRow = {
  id: string;
  jobId: string | null;
  kind: string;
  recipient: string;
  idempotencyKey: string;
  attempts: number;
};

async function deliverRow(row: ClaimedRow): Promise<RowOutcome> {
  const db = getDb();
  if (!db || !row.jobId) return "stillQueued";

  const [found] = await db
    .select({
      job: jobs,
      property: properties,
      organisationName: agentOrganisations.name,
      organisationEmail: agentOrganisations.email,
      tenantEmail: tenancies.email,
    })
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .leftJoin(
      agentOrganisations,
      eq(agentOrganisations.id, jobs.agentOrganisationId),
    )
    .leftJoin(tenancies, eq(tenancies.id, jobs.tenancyId))
    .where(eq(jobs.id, row.jobId))
    .limit(1);

  if (!found) return stand(db, row.id, "job_missing");

  const loaded = found as LoadedJob;
  const { job } = loaded;

  // Called off, either way. Nothing about it is worth sending.
  if (job.cancelledAt || job.lifecycleStatus === "cancelled") {
    return stand(db, row.id, "job_cancelled");
  }
  if (!isProductId(job.productId)) return stand(db, row.id, "unknown_product");

  if (row.kind === OUTBOX_KINDS.invitation) {
    return deliverInvitation(db, row, loaded);
  }

  /*
    Everything else describes a **specific appointment**, so from here two
    things have to be true: the job still holds that appointment, and Google
    holds it too.
  */
  const intendedFor = appointmentFromKey(row.idempotencyKey);
  if (
    !job.appointmentStart ||
    !job.appointmentEnd ||
    !intendedFor ||
    job.appointmentStart.getTime() !== intendedFor.getTime()
  ) {
    return stand(db, row.id, "superseded_by_appointment_change");
  }

  /*
    Never ahead of the diary.

    Someone told "your appointment is Tuesday" before the event exists is one
    phone call from discovering it does not. The row stays queued — this is not
    a failure — and the attempt spent on claiming it is given back, because
    waiting is not trying.
  */
  if (job.calendarSyncState !== "synced") {
    await refund(db, row);
    return "stillQueued";
  }

  if (row.kind === OUTBOX_KINDS.confirmation) {
    return deliverConfirmation(db, row, loaded);
  }
  if (row.kind === OUTBOX_KINDS.lateBooking) {
    return deliverLateBooking(db, row, loaded);
  }

  return stand(db, row.id, "unknown_kind");
}

// ---------------------------------------------------------------------------
// The three messages
// ---------------------------------------------------------------------------

async function deliverInvitation(
  db: NonNullable<ReturnType<typeof getDb>>,
  row: ClaimedRow,
  loaded: LoadedJob,
): Promise<RowOutcome> {
  const { job, property } = loaded;

  /*
    An invitation is about a job, not a time, so it is eligible **before any
    appointment exists** — which is the whole point of it — and the calendar
    check above deliberately does not apply to it. A job that is finished has
    nothing to invite anybody to.
  */
  if (!INVITABLE.includes(job.lifecycleStatus)) {
    return stand(db, row.id, "job_not_schedulable");
  }

  const to = loaded.tenantEmail;
  if (!to) return await missing(db, row, "tenant_email_missing");

  /*
    A fresh token, minted for **this attempt**.

    The raw value of the one created with the job was never kept — only its
    hash is stored, which is what makes a leaked row useless — so a link cannot
    be reproduced from the database. It has to be minted again here.

    Earlier tokens are deliberately **not revoked**. A first attempt that timed
    out may well have arrived, and invalidating its link would break a message
    the tenant is already holding. They all point at the same job, they all
    expire on their own, and `accessByToken` accepts any of them.

    The plain value exists in this function and in the email body. It is never
    logged, never stored and never returned.
  */
  const minted = createSchedulingToken();
  await db.insert(schedulingTokens).values({
    jobId: job.id,
    tokenHash: minted.tokenHash,
    expiresAt: minted.expiresAt,
  });

  const product = productFor(job.productId);
  const email = renderTenantInvitationEmail({
    reference: job.reference,
    address: addressOf(property),
    postcode: property.postcode,
    productName: product.name,
    appointmentMinutes: product.durationMinutes,
    organisationName: loaded.organisationName,
    link: `${business.url}/schedule/${minted.token}`,
    expiresAt: minted.expiresAt,
    timeZone: bookingConfig.timeZone,
  });

  return finish(
    db,
    row,
    await sendOutboxEmail({
      kind: "tenant-invitation",
      to,
      email,
      reference: job.reference,
      // Each attempt is its own message: it carries a different link, so the
      // provider must not collapse it into the previous one.
      idempotencySuffix: `invite-${row.attempts}`,
    }),
  );
}

async function deliverConfirmation(
  db: NonNullable<ReturnType<typeof getDb>>,
  row: ClaimedRow,
  loaded: LoadedJob,
): Promise<RowOutcome> {
  const { job, property } = loaded;

  const to = loaded.tenantEmail;
  if (!to) return await missing(db, row, "tenant_email_missing");

  const product = productFor(job.productId);
  const email = renderTenantAppointmentEmail({
    reference: job.reference,
    address: addressOf(property),
    postcode: property.postcode,
    productName: product.name,
    appointmentStart: job.appointmentStart!,
    appointmentEnd: job.appointmentEnd!,
    appointmentMinutes: product.durationMinutes,
    organisationName: loaded.organisationName,
    timeZone: bookingConfig.timeZone,
  });

  return finish(
    db,
    row,
    await sendOutboxEmail({
      kind: "tenant-appointment",
      to,
      email,
      reference: job.reference,
      idempotencySuffix: "appointment",
    }),
  );
}

async function deliverLateBooking(
  db: NonNullable<ReturnType<typeof getDb>>,
  row: ClaimedRow,
  loaded: LoadedJob,
): Promise<RowOutcome> {
  const { job, property } = loaded;

  // A job whose exception was cleared by a reschedule into the deadline has
  // nothing to announce.
  if (!job.deadlineExceptionAt) {
    return stand(db, row.id, "exception_cleared");
  }

  const recipient = row.recipient as OutboxRecipient;
  const to =
    recipient === "agent"
      ? loaded.organisationEmail
      : internalNotificationRecipient();

  if (!to) {
    return await missing(
      db,
      row,
      recipient === "agent" ? "agent_email_missing" : "bscj_email_missing",
    );
  }

  /*
    The deadline **as it was when the tenant accepted it**, not as it is now.
    An agent who moves the date afterwards must not change what the tenant was
    warned about.
  */
  const recorded = await readException(db, job.id, job.appointmentStart!);
  if (!recorded) return stand(db, row.id, "exception_detail_missing");

  const facts: LateBookingFacts = {
    reference: job.reference,
    address: addressOf(property),
    postcode: property.postcode,
    productName: productFor(job.productId).name,
    organisationName: loaded.organisationName,
    deadlineDate: recorded.deadlineDate,
    deadlineSource: recorded.deadlineSource,
    requestedBy: recorded.requestedBy,
    certificateDueBy: recorded.certificateDueBy,
    appointmentStart: job.appointmentStart!,
    appointmentEnd: job.appointmentEnd!,
    acknowledgedAt: recorded.acknowledgedAt,
    timeZone: bookingConfig.timeZone,
  };

  const email =
    recipient === "agent"
      ? renderLateBookingAgentEmail(facts)
      : renderLateBookingInternalEmail(facts);

  return finish(
    db,
    row,
    await sendOutboxEmail({
      kind:
        recipient === "agent" ? "late-booking-agent" : "late-booking-internal",
      to,
      email,
      reference: job.reference,
      idempotencySuffix: recipient,
    }),
  );
}

// ---------------------------------------------------------------------------
// Recording outcomes
// ---------------------------------------------------------------------------

function addressOf(property: typeof properties.$inferSelect): string {
  return [property.houseOrName, property.street, property.town]
    .filter(Boolean)
    .join(", ");
}

async function finish(
  db: NonNullable<ReturnType<typeof getDb>>,
  row: { id: string; attempts: number },
  result: { status: string; reason?: string },
): Promise<RowOutcome> {
  if (result.status === "sent") {
    await db
      .update(outboundEmails)
      .set({
        state: "sent",
        sentAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(outboundEmails.id, row.id));
    return "accepted";
  }

  const reason =
    result.status === "not_configured"
      ? "transport_not_configured"
      : (result.reason ?? "unknown");

  await db
    .update(outboundEmails)
    .set({
      lastError: reason,
      state: row.attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      updatedAt: new Date(),
    })
    .where(eq(outboundEmails.id, row.id));

  return row.attempts >= MAX_ATTEMPTS ? "failed" : "stillQueued";
}

/**
 * A deployment gap, recorded by name.
 *
 * The attempt stays spent so it cannot spin forever, and the reason says which
 * address is missing rather than "failed" — a missing address is fixed in the
 * configuration, not by trying again.
 */
async function missing(
  db: NonNullable<ReturnType<typeof getDb>>,
  row: { id: string; attempts: number },
  reason: string,
): Promise<RowOutcome> {
  await db
    .update(outboundEmails)
    .set({
      lastError: reason,
      state: row.attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      updatedAt: new Date(),
    })
    .where(eq(outboundEmails.id, row.id));
  return "missingRecipient";
}

/** Waiting is not trying: the attempt spent on claiming is given back. */
async function refund(
  db: NonNullable<ReturnType<typeof getDb>>,
  row: { id: string; attempts: number },
): Promise<void> {
  await db
    .update(outboundEmails)
    .set({ attempts: row.attempts - 1, updatedAt: new Date() })
    .where(eq(outboundEmails.id, row.id));
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

// ---------------------------------------------------------------------------
// The frozen exception detail
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Reading the queue
// ---------------------------------------------------------------------------

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

export type JobNotification = {
  kind: string;
  recipient: string;
  state: string;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
};

/** Every message queued for one job. No addresses, no tokens. */
export async function fetchNotificationStates(
  jobId: string,
): Promise<JobNotification[]> {
  const db = getDb();
  if (!db) return [];
  try {
    return await db
      .select({
        kind: outboundEmails.kind,
        recipient: outboundEmails.recipient,
        state: outboundEmails.state,
        attempts: outboundEmails.attempts,
        lastError: outboundEmails.lastError,
        sentAt: outboundEmails.sentAt,
        createdAt: outboundEmails.createdAt,
      })
      .from(outboundEmails)
      .where(eq(outboundEmails.jobId, jobId))
      .limit(50);
  } catch {
    return [];
  }
}

/** Counts for the admin queue view. No addresses. */
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
          inArray(outboundEmails.kind, ALL_KINDS),
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
