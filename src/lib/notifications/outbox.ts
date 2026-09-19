import "server-only";

import { and, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  activities,
  agentOrganisations,
  appUsers,
  certificates,
  customers,
  documents,
  invoices,
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
import { renderCertificateReleaseEmail } from "@/lib/email/certificate-release";
import { renderInvoiceEmail } from "@/lib/email/invoice-issue";
import { formatPence, isIssued, type InvoiceStatus } from "@/lib/invoices/model";
import {
  internalNotificationRecipient,
  MAX_ATTACHMENT_BYTES,
  sendOutboxEmail,
} from "@/lib/email/send";
import { getDocument } from "@/lib/storage/documents";
import { createSchedulingToken } from "@/lib/scheduling/token";
import { issueCredential } from "@/lib/auth/credentials";
import { CREDENTIAL_LIFETIME_HOURS } from "@/lib/auth/credential-token";
import {
  renderAccountInvitationEmail,
  renderPasswordResetEmail,
} from "@/lib/email/account-access";
import type { DeadlineSource } from "@/lib/scheduling/deadline";
import {
  ACCOUNT_SCOPED_KINDS,
  appointmentFromKey,
  APPOINTMENT_SCOPED_KINDS,
  approvalFromKey,
  certificateFromKey,
  confirmationKey,
  invoiceApprovalFromKey,
  invoiceFromKey,
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
  OUTBOX_KINDS.certificate,
  OUTBOX_KINDS.invoice,
  OUTBOX_KINDS.accountInvitation,
  OUTBOX_KINDS.passwordReset,
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
    appUserId: string | null;
    kind: string;
    recipient: string;
    recipientAddress: string | null;
    idempotencyKey: string;
    attempts: number;
  }[];

  try {
    rows = await db
      .select({
        id: outboundEmails.id,
        jobId: outboundEmails.jobId,
        appUserId: outboundEmails.appUserId,
        kind: outboundEmails.kind,
        recipient: outboundEmails.recipient,
        recipientAddress: outboundEmails.recipientAddress,
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
  customerEmail: string | null;
};

type ClaimedRow = {
  id: string;
  jobId: string | null;
  /** Set for the account-scoped kinds, which carry no job. */
  appUserId: string | null;
  kind: string;
  recipient: string;
  /** Frozen at queue time for the kinds a person approves. */
  recipientAddress: string | null;
  idempotencyKey: string;
  attempts: number;
};

async function deliverRow(row: ClaimedRow): Promise<RowOutcome> {
  const db = getDb();
  if (!db) return "stillQueued";

  /*
    Account access is handled **before anything reaches for a job**, because
    these rows deliberately have none. Putting the branch here rather than
    inside the job loader is the difference between one queue that carries two
    shapes of intent and a worker that quietly parks every invitation as
    "still queued" forever — which is what the old `!row.jobId` guard below
    would have done to them.
  */
  if (ACCOUNT_SCOPED_KINDS.includes(row.kind as never)) {
    return deliverAccountAccess(db, row);
  }

  if (!row.jobId) return "stillQueued";

  const [found] = await db
    .select({
      job: jobs,
      property: properties,
      organisationName: agentOrganisations.name,
      organisationEmail: agentOrganisations.email,
      tenantEmail: tenancies.email,
      customerEmail: customers.email,
    })
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .leftJoin(
      agentOrganisations,
      eq(agentOrganisations.id, jobs.agentOrganisationId),
    )
    .leftJoin(tenancies, eq(tenancies.id, jobs.tenancyId))
    .leftJoin(customers, eq(customers.id, jobs.billingCustomerId))
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
    A certificate is about a **record**, not an appointment. It must not go
    through the calendar check below — the visit has happened, the event may
    long since have been tidied away, and waiting for `synced` would hold a
    certificate behind a diary entry nobody needs any more.
  */
  if (row.kind === OUTBOX_KINDS.certificate) {
    return deliverCertificate(db, row, loaded);
  }

  /*
    An invoice is about a **document**, not an appointment, for the same
    reason a certificate is: the work has happened, the diary entry may long
    since have been tidied away, and holding a bill behind a calendar event
    nobody needs any more would simply mean it never goes out.
  */
  if (row.kind === OUTBOX_KINDS.invoice) {
    return deliverInvoice(db, row, loaded);
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
// Account access
// ---------------------------------------------------------------------------

/**
 * An invitation, or a password reset.
 *
 * The only message in this queue that is about an **account** rather than a
 * job, and the only one that mints a credential as part of sending.
 *
 * Four things are re-checked here rather than trusted from the queue, because
 * minutes or hours may have passed since the row was written:
 *
 * - **The account still exists and is still live.** A user suspended between
 *   queueing and sending gets no link. So does one whose *organisation* was
 *   suspended, by the same rule the sign-in applies — an invitation to an
 *   account that cannot sign in is a link to a locked door.
 * - **The address, resolved now.** An account credential may only ever go to
 *   the account's own address, so nothing is frozen onto the row: a corrected
 *   email is used, and a stale one cannot be.
 * - **A reset is pointless for an account with no password yet.** It is stood
 *   down rather than sent, because the invitation is the credential that
 *   account needs and two different links would be a confusing way to say so.
 * - **An invitation is pointless once a password exists.** Also stood down:
 *   the account is set up, and what the person wants is a reset.
 *
 * A **fresh credential is minted for this attempt**, exactly as the tenant
 * invitation mints a fresh token — the raw value of any earlier one was never
 * kept, only its hash, so a link cannot be reproduced from the database.
 *
 * Earlier credentials are deliberately **not revoked**. A first attempt that
 * reported a timeout may well have arrived, and invalidating its link would
 * break a message somebody is already holding. Every one of them is
 * single-use, purpose-bound and expiring, and redeeming any one revokes the
 * rest in the same statement — so the bounded handful an exhausted retry can
 * produce costs nothing and strands nobody.
 */
async function deliverAccountAccess(
  db: NonNullable<ReturnType<typeof getDb>>,
  row: ClaimedRow,
): Promise<RowOutcome> {
  if (!row.appUserId) return stand(db, row.id, "account_missing");

  const [found] = await db
    .select({
      id: appUsers.id,
      email: appUsers.email,
      name: appUsers.name,
      isActive: appUsers.isActive,
      passwordSetAt: appUsers.passwordSetAt,
      organisationId: appUsers.agentOrganisationId,
      organisationIsActive: agentOrganisations.isActive,
    })
    .from(appUsers)
    .leftJoin(
      agentOrganisations,
      eq(agentOrganisations.id, appUsers.agentOrganisationId),
    )
    .where(eq(appUsers.id, row.appUserId))
    .limit(1);

  if (!found) return stand(db, row.id, "account_missing");
  if (!found.isActive) return stand(db, row.id, "account_suspended");
  if (found.organisationId && !found.organisationIsActive) {
    return stand(db, row.id, "organisation_suspended");
  }

  const isInvitation = row.kind === OUTBOX_KINDS.accountInvitation;

  if (isInvitation && found.passwordSetAt) {
    // Already set up. The invitation has been redeemed, or somebody else
    // resent one that has. Sending another would be a spare key.
    return stand(db, row.id, "account_already_set_up");
  }
  if (!isInvitation && !found.passwordSetAt) {
    return stand(db, row.id, "account_not_set_up");
  }

  const to = found.email;
  if (!to) return await missing(db, row, "account_email_missing");

  const purpose = isInvitation ? "invitation" : "password_reset";
  const issued = await issueCredential({
    userId: found.id,
    purpose,
    createdByUserId: null,
  });
  /*
    No credential, no message. The row stays pending with its attempt spent, so
    a database blip is retried rather than becoming an email with a dead link
    in it.
  */
  if (!issued) return finish(db, row, { status: "failed", reason: "credential_not_issued" });

  const path = isInvitation ? "invitation" : "reset";
  const facts = {
    name: found.name,
    link: `${business.url}/account/${path}/${issued.token}`,
    lifetimeHours: CREDENTIAL_LIFETIME_HOURS[purpose],
  };

  const email = isInvitation
    ? renderAccountInvitationEmail(facts)
    : renderPasswordResetEmail(facts);

  return finish(
    db,
    row,
    await sendOutboxEmail({
      kind: isInvitation ? "account-invitation" : "account-password-reset",
      to,
      email,
      /*
        The account id, not an address. It is the stable thing this message is
        about, and it keeps the provider key free of anybody's email.
      */
      reference: found.id,
      // Each attempt carries a different link, so the provider must not
      // collapse it into the previous one.
      idempotencySuffix: `${path}-${row.attempts}`,
    }),
  );
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

/**
 * A released certificate, to one chosen recipient.
 *
 * Three things are re-checked at send time rather than trusted from the
 * queue, because minutes or hours may have passed:
 *
 * - **The certificate is still the current version.** A correction issued
 *   in between supersedes this one, and telling somebody about a record
 *   that has been replaced is worse than telling them nothing — the
 *   correction has its own rows.
 * - **The address, resolved now.** The queue carries a role. If the
 *   address has changed since the administrator saw it, the change is what
 *   is used, and what was actually used is recorded.
 * - **The document still exists.** A certificate row whose document has
 *   gone is a fault, not something to announce.
 */
async function deliverCertificate(
  db: NonNullable<ReturnType<typeof getDb>>,
  row: ClaimedRow,
  loaded: LoadedJob,
): Promise<RowOutcome> {
  const { job, property } = loaded;

  const certificateId = certificateFromKey(row.idempotencyKey);
  if (!certificateId) return stand(db, row.id, "certificate_key_unreadable");

  const [certificate] = await db
    .select({
      id: certificates.id,
      certificateNumber: certificates.certificateNumber,
      version: certificates.version,
      status: certificates.status,
      inspectionDate: certificates.inspectionDate,
      nextDueDate: certificates.nextDueDate,
      correctionReason: certificates.correctionReason,
      documentId: certificates.documentId,
      filename: documents.filename,
      blobKey: documents.blobKey,
      sizeBytes: documents.sizeBytes,
    })
    .from(certificates)
    .leftJoin(documents, eq(documents.id, certificates.documentId))
    .where(eq(certificates.id, certificateId))
    .limit(1);

  if (!certificate) return stand(db, row.id, "certificate_missing");

  /*
    Superseded while this sat in the queue. A correction has its own rows,
    so telling somebody about a version that has been replaced would be
    worse than telling them nothing.
  */
  if (certificate.status !== "issued") {
    return stand(db, row.id, "superseded_by_correction");
  }
  if (!certificate.documentId || !certificate.filename || !certificate.blobKey) {
    return stand(db, row.id, "certificate_document_missing");
  }

  const recipient = row.recipient as OutboxRecipient;

  /*
    **The address a person approved**, frozen on the row when they chose it.
    An edit to the agency's or the customer's record between then and now
    does not redirect the send — see migration 0005. A row written before
    that column existed falls back to resolving, which is the behaviour it
    was queued under.
  */
  const to =
    row.recipientAddress ??
    (recipient === "agent" ? loaded.organisationEmail : loaded.customerEmail);

  if (!to) {
    return await missing(
      db,
      row,
      recipient === "agent" ? "agent_email_missing" : "customer_email_missing",
    );
  }

  /*
    Eligibility, re-checked now rather than assumed from the approval.

    Freezing the address is about not being *redirected*; it is not licence
    to send to somebody who has since stopped being entitled to the
    document. An agency removed from the job, or deactivated, no longer has
    a claim on it — and neither does a billing customer who has been
    replaced.

    A revocation is **not** a retryable failure and not a quiet
    cancellation: the row is failed with a named reason, which puts the job
    on the needs-attention queue for a person to look at.
  */
  const eligible = await recipientStillEligible(db, job.id, recipient, to);
  if (!eligible.ok) {
    await db
      .update(outboundEmails)
      .set({
        state: "failed",
        lastError: eligible.reason,
        updatedAt: new Date(),
      })
      .where(eq(outboundEmails.id, row.id));
    return "failed";
  }

  /*
    The document itself, fetched now.

    A failure here is **not** a failure of the message — the store may be
    briefly unreachable — so the attempt is given back and the row stays
    queued, exactly as an unsynced calendar does. Sending the email without
    the certificate would be worse than sending it late: the whole point of
    the message is the attachment, and a recipient without a portal account
    has no other way to get it.
  */
  const stored = await getDocument(certificate.blobKey);
  if (!stored.ok) {
    await refund(db, row);
    return "stillQueued";
  }

  if (stored.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    // Not retryable: the file will be the same size next time.
    return stand(db, row.id, "attachment_too_large");
  }

  const email = renderCertificateReleaseEmail({
    reference: job.reference,
    certificateNumber: certificate.certificateNumber,
    address: addressOf(property),
    postcode: property.postcode,
    inspectionDate: certificate.inspectionDate,
    nextDueDate: certificate.nextDueDate,
    correctionReason: certificate.correctionReason,
    version: certificate.version,
    /*
      The agency reads it in their own account as well. A customer has no
      account and needs none — the PDF is attached, which is the whole
      reason this message carries one.
    */
    portalLink:
      recipient === "agent" ? `${business.url}/portal/jobs/${job.id}` : null,
    timeZone: bookingConfig.timeZone,
  });

  const result = await sendOutboxEmail({
    kind: "certificate-release",
    to,
    email,
    reference: job.reference,
    /*
      **One intent, one provider key.**

      Taken from the row's own idempotency key, which carries the approval
      number, so the two can never drift apart:

      - a **retry** of this row is the same key, and the provider
        recognises it — which is what makes retrying after an ambiguous
        outcome safe;
      - a **re-approval** is a different row with a different approval, and
        therefore a different key, so the corrected address actually
        receives something instead of being deduplicated away.

      Deriving it rather than rebuilding it is the point: the earlier
      version rebuilt the suffix from the certificate and recipient alone,
      which meant a new approval produced a new row and the same provider
      key, and the second message was silently swallowed.
    */
    idempotencySuffix: `cert-${certificate.id}-${recipient}-${
      approvalFromKey(row.idempotencyKey) ?? 1
    }`,
    attachments: [
      { filename: certificate.filename, content: stored.bytes },
    ],
  });

  /*
    Recorded only on acceptance, and never before it. `sent` means the
    provider took it — not that it arrived — and the row says so.
  */
  if (result.status === "sent") {
    try {
      await db
        .update(documents)
        .set({
          sentAt: new Date(),
          sentTo: sql`COALESCE(${documents.sentTo}, '[]'::jsonb) || ${JSON.stringify([
            {
              recipient,
              address: to,
              at: new Date().toISOString(),
              version: certificate.version,
              attached: true,
            },
          ])}::jsonb`,
        })
        .where(eq(documents.id, certificate.documentId));
    } catch {
      // The message went. A missing note about it is not worth a retry that
      // would send it again.
    }
  }

  return finish(db, row, result);
}

/**
 * An issued invoice, to one chosen recipient, with the PDF attached.
 *
 * Four things are re-checked at send time rather than trusted from the queue,
 * because minutes or hours may have passed:
 *
 * - **The invoice is still issued.** One voided in between must not go out:
 *   a bill nobody owes is worse than a bill sent late, and voiding it was
 *   somebody's deliberate decision.
 * - **The document still exists.** An invoice row whose PDF has gone is a
 *   fault, not something to announce.
 * - **The address, as approved.** Frozen on the row; the worker sends to that
 *   and does not re-resolve, so an edit in between cannot redirect it.
 * - **The recipient is still entitled to it.** Freezing the address is about
 *   not being redirected; it is not licence to send a bill to somebody who
 *   has stopped being the payer.
 *
 * **The stored bytes are attached, never a re-render.** What the customer
 * receives has to be the document that was issued — rendering again here
 * would pick up whatever the settings say today.
 */
async function deliverInvoice(
  db: NonNullable<ReturnType<typeof getDb>>,
  row: ClaimedRow,
  loaded: LoadedJob,
): Promise<RowOutcome> {
  const { job, property } = loaded;

  const invoiceId = invoiceFromKey(row.idempotencyKey);
  if (!invoiceId) return stand(db, row.id, "invoice_key_unreadable");

  const [invoice] = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      status: invoices.status,
      issuedAt: invoices.issuedAt,
      dueDate: invoices.dueDate,
      totalPence: invoices.totalPence,
      billingCustomerId: invoices.billingCustomerId,
      agentOrganisationId: invoices.agentOrganisationId,
      documentId: invoices.documentId,
      filename: documents.filename,
      blobKey: documents.blobKey,
    })
    .from(invoices)
    .leftJoin(documents, eq(documents.id, invoices.documentId))
    .where(eq(invoices.id, invoiceId))
    .limit(1);

  if (!invoice) return stand(db, row.id, "invoice_missing");

  if (!isIssued(invoice.status as InvoiceStatus) || !invoice.number || !invoice.issuedAt) {
    return stand(db, row.id, "invoice_not_issued");
  }
  if (!invoice.documentId || !invoice.filename || !invoice.blobKey) {
    return stand(db, row.id, "invoice_document_missing");
  }

  const recipient = row.recipient as OutboxRecipient;
  const to =
    row.recipientAddress ??
    (recipient === "agent" ? loaded.organisationEmail : loaded.customerEmail);

  if (!to) {
    return await missing(
      db,
      row,
      recipient === "agent" ? "agent_email_missing" : "customer_email_missing",
    );
  }

  const eligible = await invoiceRecipientStillEligible(
    db,
    invoice.agentOrganisationId,
    invoice.billingCustomerId,
    recipient,
    to,
  );
  if (!eligible.ok) {
    await db
      .update(outboundEmails)
      .set({ state: "failed", lastError: eligible.reason, updatedAt: new Date() })
      .where(eq(outboundEmails.id, row.id));
    return "failed";
  }

  /*
    The document itself, fetched now.

    A failure here is not a failure of the message — the store may be
    briefly unreachable — so the attempt is given back and the row stays
    queued. Sending an invoice email with no invoice attached would be worse
    than sending it late.
  */
  const stored = await getDocument(invoice.blobKey);
  if (!stored.ok) {
    await refund(db, row);
    return "stillQueued";
  }

  if (stored.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    // Not retryable: the file will be the same size next time.
    return stand(db, row.id, "attachment_too_large");
  }

  const email = renderInvoiceEmail({
    number: invoice.number,
    address: addressOf(property),
    postcode: property.postcode,
    issuedOn: invoice.issuedAt.toISOString().slice(0, 10),
    dueDate: invoice.dueDate,
    totalFormatted: formatPence(invoice.totalPence),
    reference: job.reference,
    /*
      The agency reads it in their own account as well. A private customer
      has no account and needs none — the PDF is attached, which is the whole
      reason this message carries one.
    */
    portalLink:
      recipient === "agent" ? `${business.url}/portal/invoices/${invoice.id}` : null,
    timeZone: bookingConfig.timeZone,
  });

  const result = await sendOutboxEmail({
    kind: "invoice-issue",
    to,
    email,
    reference: job.reference,
    /*
      **One intent, one provider key**, taken from the row's own key so the
      two can never drift apart — the mistake §20.f found in the certificate
      path. A retry keeps it; a re-approval to a corrected address is a
      different row with a different approval number and therefore a
      different key, so the corrected message is not deduplicated away.
    */
    idempotencySuffix: `inv-${invoice.id}-${recipient}-${
      invoiceApprovalFromKey(row.idempotencyKey) ?? 1
    }`,
    attachments: [{ filename: invoice.filename, content: stored.bytes }],
  });

  if (result.status === "sent") {
    /*
      Recorded only on acceptance. `sent` means the provider took it — not
      that it arrived, and emphatically not that it was paid: the invoice
      moves to `sent`, which is a different column from `paid`.
    */
    try {
      await db.batch([
        db
          .update(documents)
          .set({
            sentAt: new Date(),
            sentTo: sql`COALESCE(${documents.sentTo}, '[]'::jsonb) || ${JSON.stringify([
              {
                recipient,
                address: to,
                at: new Date().toISOString(),
                number: invoice.number,
                attached: true,
              },
            ])}::jsonb`,
          })
          .where(eq(documents.id, invoice.documentId)),
        db
          .update(invoices)
          .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
          // Only from `issued`. A payment recorded in the meantime is a later
          // fact than this send and must not be walked back by it.
          .where(and(eq(invoices.id, invoice.id), eq(invoices.status, "issued"))),
      ] as unknown as Parameters<typeof db.batch>[0]);
    } catch {
      // The message went. A missing note about it is not worth a retry that
      // would send it again.
    }
  }

  return finish(db, row, result);
}

/**
 * Is this recipient still entitled to the invoice?
 *
 * Deliberately **not** `recipientStillEligible`: that one compares against
 * the *job's* billing customer, and an invoice may legitimately have been
 * addressed to a different related payer. Asking the job would revoke a
 * perfectly valid send.
 */
async function invoiceRecipientStillEligible(
  db: NonNullable<ReturnType<typeof getDb>>,
  organisationId: string | null,
  payerId: string,
  recipient: OutboxRecipient,
  approvedAddress: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (recipient === "agent") {
    if (!organisationId) return { ok: false, reason: "agency_no_longer_on_invoice" };
    const [org] = await db
      .select({ email: agentOrganisations.email, active: agentOrganisations.isActive })
      .from(agentOrganisations)
      .where(eq(agentOrganisations.id, organisationId))
      .limit(1);

    if (!org) return { ok: false, reason: "agency_missing" };
    if (org.active === false) return { ok: false, reason: "agency_deactivated" };
    if (org.email !== approvedAddress) {
      return { ok: false, reason: "approved_address_changed" };
    }
    return { ok: true };
  }

  const [payer] = await db
    .select({ email: customers.email, active: customers.isActive })
    .from(customers)
    .where(eq(customers.id, payerId))
    .limit(1);

  if (!payer) return { ok: false, reason: "payer_missing" };
  if (payer.active === false) return { ok: false, reason: "customer_deactivated" };
  if (payer.email !== approvedAddress) {
    return { ok: false, reason: "approved_address_changed" };
  }
  return { ok: true };
}

/**
 * Is this recipient still entitled to the document?
 *
 * Re-derived from the job now, at send time. The approval froze *where* to
 * send; this decides whether sending is still right at all.
 *
 * The address is compared too: if the record has moved on, the approved
 * address is no longer one the application can vouch for, and that is a
 * decision for a person rather than something to push through.
 */
async function recipientStillEligible(
  db: NonNullable<ReturnType<typeof getDb>>,
  jobId: string,
  recipient: OutboxRecipient,
  approvedAddress: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [current] = await db
    .select({
      organisationId: jobs.agentOrganisationId,
      organisationEmail: agentOrganisations.email,
      organisationActive: agentOrganisations.isActive,
      customerEmail: customers.email,
      customerActive: customers.isActive,
    })
    .from(jobs)
    .leftJoin(
      agentOrganisations,
      eq(agentOrganisations.id, jobs.agentOrganisationId),
    )
    .leftJoin(customers, eq(customers.id, jobs.billingCustomerId))
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!current) return { ok: false, reason: "job_missing" };

  if (recipient === "agent") {
    if (!current.organisationId) return { ok: false, reason: "agency_no_longer_on_job" };
    if (current.organisationActive === false) {
      return { ok: false, reason: "agency_deactivated" };
    }
    if (current.organisationEmail !== approvedAddress) {
      return { ok: false, reason: "approved_address_changed" };
    }
    return { ok: true };
  }

  if (current.customerActive === false) {
    return { ok: false, reason: "customer_deactivated" };
  }
  if (current.customerEmail !== approvedAddress) {
    return { ok: false, reason: "approved_address_changed" };
  }
  return { ok: true };
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
  /** The address a person approved, where one was frozen. */
  recipientAddress: string | null;
  /** So a screen can tell which certificate version a row belongs to. */
  idempotencyKey: string;
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
        recipientAddress: outboundEmails.recipientAddress,
        idempotencyKey: outboundEmails.idempotencyKey,
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
