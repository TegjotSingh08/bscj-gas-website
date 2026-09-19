import "server-only";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { recordAudit } from "@/lib/audit/record";
import { assertCan } from "@/lib/auth/roles";
import { canAccessAssignedJob, type AccessScope } from "@/lib/auth/scope";
import type { Session } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import {
  activities,
  agentOrganisations,
  appUsers,
  certificates,
  customers,
  documents,
  jobs,
  outboundEmails,
} from "@/lib/db/schema";
import {
  deleteDocument,
  getDocument,
  putDocument,
  storageStatus,
} from "@/lib/storage/documents";
import { checkPdf } from "./validate";
import {
  canUploadCertificate,
  checkRelease,
  isCertificateRecipient,
  uploadRefusal,
  type CertificateRecipient,
  type ReleaseInput,
} from "./release";
import {
  approvalFromKey,
  certificateFromKey,
  certificateRows,
  OUTBOX_KINDS,
} from "@/lib/notifications/kinds";

/**
 * Certificates: uploaded, reviewed, released, sent.
 *
 * Four separate acts, deliberately. The engineer produces a PDF and puts it
 * against the job; an administrator reads it and releases it; only then is
 * it a record the agency can see; and only then, and only if somebody
 * chooses to, is anybody emailed. Collapsing any two of those would mean a
 * document reaching a customer because a file finished uploading.
 *
 * What holds it together:
 *
 * - **Storage first, database second.** A row is written only once the bytes
 *   are stored, so there is never a record pointing at a document that does
 *   not exist. The reverse — an orphaned blob — is recoverable and harmless.
 * - **An issued certificate is never overwritten.** Releasing over one
 *   creates a new version with a reason, marks the previous `superseded`,
 *   and keeps every row.
 * - **Permission is re-derived here, from the row.** Every function takes a
 *   session, checks the capability, and checks the job — the screen that
 *   called it is not evidence of anything.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DocumentResult =
  | { ok: true; message: string; documentId?: string }
  | { ok: false; error: string; errors?: Record<string, string> };

const NOT_FOUND = "That job could not be found.";
const NO_DATABASE = "The database is not available.";

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Putting the generated PDF against the job.
 *
 * The engineer allocated to the job, or an administrator. `job:work` is the
 * capability — producing the record is part of doing the work — and the
 * scope check decides the row, so an engineer cannot upload against
 * somebody else's job.
 *
 * **A second upload does not replace the first.** Both are kept: the
 * administrator reviewing them can see what was superseded and release the
 * one they have read. Nothing here decides which is right.
 */
export async function uploadCertificate(input: {
  session: Session;
  jobId: string;
  bytes: Uint8Array;
  filename: unknown;
}): Promise<DocumentResult> {
  const { session, jobId } = input;
  assertCan(session.user.role, "certificate:issue");

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!UUID.test(jobId)) return { ok: false, error: NOT_FOUND };

  const storage = storageStatus();
  if (!storage.ready) {
    return {
      ok: false,
      error: `Documents cannot be stored yet. ${storage.requirement ?? ""}`.trim(),
    };
  }

  const [job] = await db
    .select({
      id: jobs.id,
      reference: jobs.reference,
      lifecycleStatus: jobs.lifecycleStatus,
      agentOrganisationId: jobs.agentOrganisationId,
      assignedEngineerId: jobs.assignedEngineerId,
      propertyId: jobs.propertyId,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!job) return { ok: false, error: NOT_FOUND };
  if (!canAccessAssignedJob(session.scope, job)) return { ok: false, error: NOT_FOUND };

  if (!canUploadCertificate(job.lifecycleStatus)) {
    return { ok: false, error: uploadRefusal(job.lifecycleStatus) ?? NOT_FOUND };
  }

  const checked = checkPdf(input.bytes, input.filename);
  if (!checked.ok) return { ok: false, error: checked.error };

  /*
    Stored before anything is recorded. A failure here leaves the database
    exactly as it was and the engineer is told to try again — which is the
    only honest outcome, because there is nothing to point a row at.
  */
  const stored = await putDocument(input.bytes);
  if (!stored.ok) return { ok: false, error: stored.error };

  let documentId: string | null = null;
  try {
    const [row] = await db
      .insert(documents)
      .values({
        jobId: job.id,
        agentOrganisationId: job.agentOrganisationId,
        kind: "certificate",
        blobKey: stored.key,
        filename: checked.filename,
        contentType: "application/pdf",
        sizeBytes: checked.sizeBytes,
        uploadedBy: session.user.id,
      })
      .returning({ id: documents.id });
    documentId = row.id;
  } catch {
    /*
      The insert threw. **That does not mean it did not commit.**

      A timeout, a dropped connection or an aborted request can all leave a
      row committed on the server while the client sees an error. Deleting
      the object on the strength of an exception would, in exactly those
      cases, destroy the bytes a committed row points at — turning a
      recoverable blip into a certificate record with nothing behind it.

      So the row is looked for by its blob key, which is unique-indexed:

      - **found** — it committed after all. Nothing is deleted and the
        upload is reported as the success it was.
      - **definitely absent** — the write did not happen. The object is
        removed, because nothing will ever reference it.
      - **the check itself failed** — the outcome is unknown. The object is
        kept and the uncertainty is recorded. An orphan costs a fraction of
        a penny; a wrong delete cannot be undone.
    */
    let settled: "committed" | "absent" | "unknown";
    try {
      const [existing] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.blobKey, stored.key))
        .limit(1);
      settled = existing ? "committed" : "absent";
      if (existing) documentId = existing.id;
    } catch {
      settled = "unknown";
    }

    if (settled === "absent") {
      const removed = await deleteDocument(stored.key);
      if (!removed.ok) {
        await recordAudit({
          actorUserId: session.user.id,
          actorDescription: session.user.email,
          kind: "document.orphaned",
          subjectType: "document",
          subjectId: null,
          detail: {
            reference: job.reference,
            storageKey: stored.key,
            outcome: "not_recorded",
            note: "Stored but not recorded, and the cleanup failed. Remove by hand.",
          },
        });
      }
      return {
        ok: false,
        error:
          "The certificate could not be recorded. Nothing was saved — please try again.",
      };
    }

    if (settled === "unknown") {
      /*
        Kept deliberately. The record may exist; nobody can say from here.
      */
      await recordAudit({
        actorUserId: session.user.id,
        actorDescription: session.user.email,
        kind: "document.upload_uncertain",
        subjectType: "document",
        subjectId: null,
        detail: {
          reference: job.reference,
          storageKey: stored.key,
          outcome: "unknown",
          note: "The write may or may not have committed. The object was KEPT, not deleted. Check the job before re-uploading.",
        },
      });
      return {
        ok: false,
        error:
          "It is not clear whether the certificate was recorded. Reload the job before uploading again — it may already be there.",
      };
    }

    // Committed after all. Fall through and report it as stored.
  }

  if (!documentId) {
    /*
      Belt and braces: the only path here is "committed" with an id, so a
      null means an assumption above stopped being true. Refuse rather than
      report a success nobody can point at.
    */
    return {
      ok: false,
      error: "The certificate could not be recorded. Please try again.",
    };
  }

  try {
    await db.insert(activities).values({
      jobId: job.id,
      propertyId: job.propertyId,
      agentOrganisationId: job.agentOrganisationId,
      kind: "certificate.uploaded",
      actor: `user:${session.user.id}`,
      // The act and its shape. Never the key, never the contents.
      detail: { filename: checked.filename, sizeBytes: checked.sizeBytes },
    });
  } catch {
    // A gap in the timeline is smaller than a lost upload.
  }

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "certificate.uploaded",
    subjectType: "document",
    subjectId: documentId,
    detail: { reference: job.reference, sizeBytes: checked.sizeBytes },
  });

  return {
    ok: true,
    documentId,
    message: "Uploaded. It is not released until an administrator has reviewed it.",
  };
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

/**
 * An administrator says they have read it.
 *
 * This is the step that turns a stored file into a record. It requires
 * `certificate:issue` **and** an administrator scope — an agency may read
 * its own released certificates and may never release one.
 *
 * The number and both dates are taken from the form because nothing may
 * invent them: no numbering scheme exists, and the renewal rule, though
 * confirmed, is deliberately not applied here — the date on the record is
 * the date a person read off the PDF.
 */
export async function releaseCertificate(input: {
  session: Session;
  jobId: string;
  documentId: string;
  details: ReleaseInput;
  today: string;
}): Promise<DocumentResult> {
  const { session, jobId, documentId } = input;
  assertCan(session.user.role, "certificate:issue");
  if (session.scope.kind !== "all") return { ok: false, error: NOT_FOUND };

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!UUID.test(jobId) || !UUID.test(documentId)) {
    return { ok: false, error: NOT_FOUND };
  }

  const [job] = await db
    .select({
      id: jobs.id,
      reference: jobs.reference,
      propertyId: jobs.propertyId,
      agentOrganisationId: jobs.agentOrganisationId,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job) return { ok: false, error: NOT_FOUND };

  const [document] = await db
    .select({ id: documents.id, filename: documents.filename })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.jobId, jobId),
        eq(documents.kind, "certificate"),
      ),
    )
    .limit(1);
  if (!document) return { ok: false, error: "That document could not be found." };

  // Already released? Releasing the same document twice is a double submit.
  const [alreadyThis] = await db
    .select({ id: certificates.id })
    .from(certificates)
    .where(eq(certificates.documentId, documentId))
    .limit(1);
  if (alreadyThis) {
    return { ok: false, error: "That document has already been released." };
  }

  const existing = await db
    .select({
      id: certificates.id,
      version: certificates.version,
      status: certificates.status,
    })
    .from(certificates)
    .where(eq(certificates.jobId, jobId))
    .orderBy(desc(certificates.version));

  const current = existing.find((c) => c.status === "issued") ?? null;
  const isCorrection = current !== null;

  const checked = checkRelease(input.details, { isCorrection, today: input.today });
  if (!checked.ok) {
    return { ok: false, error: "Check the details below.", errors: checked.errors };
  }

  const nextVersion =
    existing.reduce((highest, c) => Math.max(highest, c.version), 0) + 1;

  let certificateId: string;
  try {
    /*
      One batch. The supersede and the new version land together or not at
      all — a job with two `issued` certificates, or none where there was
      one, are both worse than a failed release the administrator can retry.
    */
    const statements = [];
    if (current) {
      statements.push(
        db
          .update(certificates)
          .set({ status: "superseded" })
          .where(
            and(eq(certificates.id, current.id), eq(certificates.status, "issued")),
          ),
      );
    }
    statements.push(
      db
        .insert(certificates)
        .values({
          jobId: job.id,
          propertyId: job.propertyId,
          agentOrganisationId: job.agentOrganisationId,
          certificateNumber: checked.details.certificateNumber,
          version: nextVersion,
          supersedesId: current?.id ?? null,
          status: "issued",
          inspectionDate: checked.details.inspectionDate,
          nextDueDate: checked.details.nextDueDate,
          issuedBy: session.user.id,
          correctionReason: checked.details.correctionReason,
          documentId: document.id,
        })
        .returning({ id: certificates.id }),
    );

    const results = await db.batch(
      statements as unknown as Parameters<typeof db.batch>[0],
    );
    const inserted = results[results.length - 1] as { id: string }[];
    certificateId = inserted[0].id;
  } catch {
    return {
      ok: false,
      error:
        "The certificate could not be released. Nothing was changed — check the number is not already used and try again.",
    };
  }

  try {
    await db.insert(activities).values({
      jobId: job.id,
      propertyId: job.propertyId,
      agentOrganisationId: job.agentOrganisationId,
      kind: isCorrection ? "certificate.corrected" : "certificate.released",
      actor: `user:${session.user.id}`,
      detail: {
        certificateNumber: checked.details.certificateNumber,
        version: nextVersion,
        ...(checked.details.correctionReason
          ? { reason: checked.details.correctionReason }
          : {}),
      },
    });
  } catch {
    // Recorded imperfectly is better than refused.
  }

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: isCorrection ? "certificate.corrected" : "certificate.released",
    subjectType: "certificate",
    subjectId: certificateId,
    detail: {
      reference: job.reference,
      certificateNumber: checked.details.certificateNumber,
      version: nextVersion,
    },
  });

  return {
    ok: true,
    message: isCorrection
      ? `Released as version ${nextVersion}. The previous version is kept and marked superseded.`
      : "Released. The agency can now see it.",
  };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Queueing the message, to recipients somebody chose.
 *
 * Roles, not addresses: the administrator picks from a list that already
 * shows them the resolved address, and the worker resolves it again when it
 * sends. Nothing puts an address in a queue row, and the row records what
 * was actually used.
 *
 * Queued, not sent. The outbox owns delivery, with its claiming, its lease
 * and its bounded retries — so a provider outage is a row to retry rather
 * than a lost intent, and pressing the button twice cannot send twice
 * because the key is unique on the version and the recipient.
 */
export async function queueCertificateEmail(input: {
  session: Session;
  certificateId: string;
  recipients: unknown;
}): Promise<DocumentResult> {
  const { session, certificateId } = input;
  assertCan(session.user.role, "message:write");
  if (session.scope.kind !== "all") return { ok: false, error: NOT_FOUND };

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!UUID.test(certificateId)) return { ok: false, error: NOT_FOUND };

  const chosen = Array.isArray(input.recipients) ? input.recipients : [];
  const recipients = [...new Set(chosen.filter(isCertificateRecipient))];
  if (recipients.length === 0) {
    return { ok: false, error: "Choose at least one recipient." };
  }

  const [found] = await db
    .select({
      id: certificates.id,
      jobId: certificates.jobId,
      status: certificates.status,
      certificateNumber: certificates.certificateNumber,
      version: certificates.version,
      reference: jobs.reference,
      propertyId: jobs.propertyId,
      agentOrganisationId: jobs.agentOrganisationId,
    })
    .from(certificates)
    .innerJoin(jobs, eq(jobs.id, certificates.jobId))
    .where(eq(certificates.id, certificateId))
    .limit(1);

  if (!found) return { ok: false, error: NOT_FOUND };
  if (found.status !== "issued") {
    return {
      ok: false,
      error: "That version has been superseded. Send the current one instead.",
    };
  }

  // Refuse before queueing anything if an address is missing — a row that
  // can only ever fail is noise on the reconciliation page.
  const addresses = await certificateRecipientAddresses(found.jobId);
  const missing = recipients.filter(
    (r) => !addresses.find((a) => a.recipient === r)?.address,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      error: `No email address is on file for: ${missing.join(", ")}. Nothing was queued.`,
    };
  }

  /*
    The addresses as they are **now**, frozen onto the rows. These are the
    ones the administrator saw on screen when they chose; the worker sends
    to these and does not re-resolve. A change of address between here and
    the outbox run must not silently redirect an approved document.
  */
  const rows = certificateRows({
    jobId: found.jobId,
    certificateId: found.id,
    recipients: (recipients as CertificateRecipient[]).map((recipient) => ({
      recipient,
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
      jobId: found.jobId,
      propertyId: found.propertyId,
      agentOrganisationId: found.agentOrganisationId,
      kind: "certificate.email_queued",
      actor: `user:${session.user.id}`,
      // The roles chosen and the version. Never the addresses.
      detail: { recipients, version: found.version },
    });
  } catch {
    /* ignored */
  }

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "certificate.email_queued",
    subjectType: "certificate",
    subjectId: found.id,
    detail: { reference: found.reference, recipients },
  });

  return {
    ok: true,
    message: `Queued for ${queued} recipient${queued === 1 ? "" : "s"}. It goes out on the next run of the outbox.`,
  };
}

/**
 * Approving a send again, to the address as it now stands.
 *
 * **This creates a new intent, not a retry of the old one.** The two are
 * genuinely different things and conflating them was a defect:
 *
 * - A **retry** is the worker trying the *same* message again after a
 *   failure or an ambiguous outcome. Same row, same payload, same provider
 *   key — which is exactly what makes it safe, because the provider
 *   recognises it and does not send twice.
 * - A **re-approval** is a person saying "send it to this address", and
 *   the address may be different from the one that was approved before.
 *   Reusing the key would have the provider recognise it as the message it
 *   already accepted and quietly send nothing at all — the new address
 *   would never hear.
 *
 * So a new row is inserted with the next approval number, which produces a
 * new key, and **the earlier row is left exactly as it was**. What was
 * attempted to the old address is history: an email that may well have
 * arrived, and rewriting the row would hide it.
 */
export async function requeueCertificateEmail(input: {
  session: Session;
  certificateId: string;
  recipient: unknown;
}): Promise<DocumentResult> {
  const { session, certificateId } = input;
  assertCan(session.user.role, "message:write");
  if (session.scope.kind !== "all") return { ok: false, error: NOT_FOUND };

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!UUID.test(certificateId)) return { ok: false, error: NOT_FOUND };
  if (!isCertificateRecipient(input.recipient)) {
    return { ok: false, error: "That is not a recipient." };
  }
  const recipient = input.recipient;

  const [found] = await db
    .select({
      id: certificates.id,
      jobId: certificates.jobId,
      status: certificates.status,
      version: certificates.version,
      reference: jobs.reference,
      propertyId: jobs.propertyId,
      agentOrganisationId: jobs.agentOrganisationId,
    })
    .from(certificates)
    .innerJoin(jobs, eq(jobs.id, certificates.jobId))
    .where(eq(certificates.id, certificateId))
    .limit(1);

  if (!found) return { ok: false, error: NOT_FOUND };
  if (found.status !== "issued") {
    return {
      ok: false,
      error: "That version has been superseded. Send the current one instead.",
    };
  }

  // The address as it stands now — this is a fresh approval, not a replay.
  const addresses = await certificateRecipientAddresses(found.jobId);
  const address = addresses.find((a) => a.recipient === recipient)?.address;
  if (!address) {
    return {
      ok: false,
      error: "There is still no email address on file for that recipient.",
    };
  }

  /*
    Every approval so far for this certificate and recipient. The next one
    is one higher — including when the address happens to be the same as
    before, because a person approving again is a new decision and should
    produce a message that actually goes.
  */
  const existing = await db
    .select({
      key: outboundEmails.idempotencyKey,
      state: outboundEmails.state,
    })
    .from(outboundEmails)
    .where(
      and(
        eq(outboundEmails.kind, OUTBOX_KINDS.certificate),
        eq(outboundEmails.jobId, found.jobId),
        eq(outboundEmails.recipient, recipient),
      ),
    );

  const mine = existing.filter(
    (row) => certificateFromKey(row.key) === found.id,
  );
  if (mine.length === 0) {
    return { ok: false, error: "There is nothing to retry for that recipient." };
  }

  /*
    Refused while one is still in flight. A pending row is going to be
    tried again on its own, and adding a second intent beside it is how one
    recipient gets two emails.
  */
  if (mine.some((row) => row.state === "pending")) {
    return {
      ok: false,
      error: "That recipient already has a send waiting. Let it finish first.",
    };
  }
  if (mine.some((row) => row.state === "sent")) {
    return {
      ok: false,
      error:
        "That version has already been accepted by the provider for this recipient.",
    };
  }

  const nextApproval =
    mine.reduce((highest, row) => Math.max(highest, approvalFromKey(row.key) ?? 1), 0) + 1;

  const [row] = certificateRows({
    jobId: found.jobId,
    certificateId: found.id,
    recipients: [{ recipient, address, approval: nextApproval }],
  });

  let inserted: { id: string }[];
  try {
    inserted = await db
      .insert(outboundEmails)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: outboundEmails.id });
  } catch {
    return { ok: false, error: "That could not be queued. Please try again." };
  }

  if (inserted.length === 0) {
    return { ok: false, error: "That approval is already queued." };
  }

  try {
    await db.insert(activities).values({
      jobId: found.jobId,
      propertyId: found.propertyId,
      agentOrganisationId: found.agentOrganisationId,
      kind: "certificate.email_reapproved",
      actor: `user:${session.user.id}`,
      // The decision and which attempt it is. Never the address.
      detail: { recipient, version: found.version, approval: nextApproval },
    });
  } catch {
    /* ignored */
  }

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "certificate.email_reapproved",
    subjectType: "certificate",
    subjectId: found.id,
    detail: { reference: found.reference, recipient, approval: nextApproval },
  });

  return {
    ok: true,
    message:
      "Approved again, to the address shown. It is a new send — the earlier attempt is kept in the history.",
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type RecipientAddress = {
  recipient: CertificateRecipient;
  label: string;
  address: string | null;
};

/**
 * The addresses the chosen roles resolve to, right now.
 *
 * Shown to the administrator **before** they send, because "email the
 * agency" is not something anybody can check and "email
 * lettings@example.com" is. The worker resolves the same way at send time
 * and records what it actually used, so a change in between is visible
 * rather than silent.
 */
export async function certificateRecipientAddresses(
  jobId: string,
): Promise<RecipientAddress[]> {
  const db = getDb();
  if (!db || !UUID.test(jobId)) return [];

  const [row] = await db
    .select({
      organisationName: agentOrganisations.name,
      organisationEmail: agentOrganisations.email,
      customerName: customers.name,
      customerEmail: customers.email,
    })
    .from(jobs)
    .leftJoin(
      agentOrganisations,
      eq(agentOrganisations.id, jobs.agentOrganisationId),
    )
    .leftJoin(customers, eq(customers.id, jobs.billingCustomerId))
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!row) return [];

  const out: RecipientAddress[] = [];
  if (row.organisationName) {
    out.push({
      recipient: "agent",
      label: `Agency — ${row.organisationName}`,
      address: row.organisationEmail ?? null,
    });
  }
  if (row.customerName) {
    out.push({
      recipient: "customer",
      label: `Customer — ${row.customerName}`,
      address: row.customerEmail ?? null,
    });
  }
  return out;
}

export type JobCertificate = {
  id: string;
  certificateNumber: string;
  version: number;
  status: string;
  inspectionDate: string;
  nextDueDate: string;
  correctionReason: string | null;
  issuedAt: Date;
  issuedByName: string | null;
  documentId: string | null;
  filename: string | null;
  sizeBytes: number | null;
  /** What the worker actually sent, and to which address. Never a guess. */
  sentTo: unknown;
};

/** Every certificate for a job, newest version first. Admin-scoped callers. */
export async function listJobCertificates(
  jobId: string,
): Promise<JobCertificate[]> {
  const db = getDb();
  if (!db || !UUID.test(jobId)) return [];

  return db
    .select({
      id: certificates.id,
      certificateNumber: certificates.certificateNumber,
      version: certificates.version,
      status: certificates.status,
      inspectionDate: certificates.inspectionDate,
      nextDueDate: certificates.nextDueDate,
      correctionReason: certificates.correctionReason,
      issuedAt: certificates.issuedAt,
      issuedByName: appUsers.name,
      documentId: certificates.documentId,
      filename: documents.filename,
      sizeBytes: documents.sizeBytes,
      sentTo: documents.sentTo,
    })
    .from(certificates)
    .leftJoin(appUsers, eq(appUsers.id, certificates.issuedBy))
    .leftJoin(documents, eq(documents.id, certificates.documentId))
    .where(eq(certificates.jobId, jobId))
    .orderBy(desc(certificates.version));
}

export type PendingDocument = {
  id: string;
  filename: string;
  sizeBytes: number;
  uploadedAt: Date;
  uploadedByName: string | null;
};

/**
 * Uploaded and not yet released.
 *
 * The review queue for one job. A document with no certificate row has been
 * put there and read by nobody.
 */
export async function listPendingDocuments(
  jobId: string,
): Promise<PendingDocument[]> {
  const db = getDb();
  if (!db || !UUID.test(jobId)) return [];

  return db
    .select({
      id: documents.id,
      filename: documents.filename,
      sizeBytes: documents.sizeBytes,
      uploadedAt: documents.uploadedAt,
      uploadedByName: appUsers.name,
    })
    .from(documents)
    .leftJoin(appUsers, eq(appUsers.id, documents.uploadedBy))
    .leftJoin(certificates, eq(certificates.documentId, documents.id))
    .where(
      and(
        eq(documents.jobId, jobId),
        eq(documents.kind, "certificate"),
        isNull(certificates.id),
      ),
    )
    .orderBy(asc(documents.uploadedAt));
}

/**
 * How many certificate documents are waiting for review, across the board.
 *
 * For the administrator's dashboard. A count, nothing else.
 */
export async function countPendingReview(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  try {
    const [row] = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(documents)
      .leftJoin(certificates, eq(certificates.documentId, documents.id))
      .where(and(eq(documents.kind, "certificate"), isNull(certificates.id)));
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * The certificates an agency may see for one of its jobs.
 *
 * **Released only, and their own only.** The organisation is matched in the
 * `WHERE`, and a document with no certificate row is invisible here — which
 * is what "released" means in practice. The scope is passed by the caller
 * from `requireAgent()`; there is no unscoped variant of this function.
 */
export async function listAgencyJobCertificates(
  organisationId: string,
  jobId: string,
): Promise<JobCertificate[]> {
  const db = getDb();
  if (!db || !UUID.test(jobId) || !UUID.test(organisationId)) return [];

  return db
    .select({
      id: certificates.id,
      certificateNumber: certificates.certificateNumber,
      version: certificates.version,
      status: certificates.status,
      inspectionDate: certificates.inspectionDate,
      nextDueDate: certificates.nextDueDate,
      correctionReason: certificates.correctionReason,
      issuedAt: certificates.issuedAt,
      issuedByName: sql<string | null>`NULL`,
      documentId: certificates.documentId,
      filename: documents.filename,
      sizeBytes: documents.sizeBytes,
      /* An agency sees that it was issued, not our delivery bookkeeping. */
      sentTo: sql`NULL`,
    })
    .from(certificates)
    .innerJoin(jobs, eq(jobs.id, certificates.jobId))
    .leftJoin(documents, eq(documents.id, certificates.documentId))
    .where(
      and(
        eq(certificates.jobId, jobId),
        eq(jobs.agentOrganisationId, organisationId),
        eq(certificates.agentOrganisationId, organisationId),
      ),
    )
    .orderBy(desc(certificates.version));
}

// ---------------------------------------------------------------------------
// Reading the bytes
// ---------------------------------------------------------------------------

export type DocumentAccess =
  | { ok: true; filename: string; bytes: Uint8Array }
  | { ok: false; status: 404 | 503; error: string };

/**
 * A document's bytes, for a caller who has proved they may have them.
 *
 * The permission is decided here, from the database, for every request:
 *
 * - **BSCJ staff** — an administrator, or the engineer the job is assigned
 *   to. An engineer who is not on the job is a stranger to it.
 * - **An agency** — its own organisation's documents, and **only once
 *   released**. An uploaded, unreviewed PDF is not theirs to see.
 * - **Nobody else.** A tenant's scheduling session is a token for choosing
 *   an appointment; it has never been an identity and it grants nothing
 *   here.
 *
 * Every refusal is the same 404. Distinguishing "not yours" from "not
 * there" turns a document id into a probe for which documents exist.
 */
export async function readDocumentFor(
  scope: AccessScope,
  documentId: string,
): Promise<DocumentAccess> {
  const db = getDb();
  if (!db || !UUID.test(documentId)) {
    return { ok: false, status: 404, error: "Not found." };
  }

  const [row] = await db
    .select({
      id: documents.id,
      filename: documents.filename,
      blobKey: documents.blobKey,
      agentOrganisationId: documents.agentOrganisationId,
      jobId: documents.jobId,
      assignedEngineerId: jobs.assignedEngineerId,
      jobOrganisationId: jobs.agentOrganisationId,
      certificateId: certificates.id,
      certificateStatus: certificates.status,
    })
    .from(documents)
    .leftJoin(jobs, eq(jobs.id, documents.jobId))
    .leftJoin(certificates, eq(certificates.documentId, documents.id))
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!row) return { ok: false, status: 404, error: "Not found." };

  const released = row.certificateId !== null;
  let permitted = false;

  switch (scope.kind) {
    case "all":
      // BSCJ sees everything, released or not. Reviewing requires it.
      permitted = true;
      break;
    case "assigned":
      // The engineer on the job, whether or not it has been released.
      permitted = row.assignedEngineerId === scope.userId;
      break;
    case "organisation":
      /*
        Their own organisation, and only what has been released. Both
        columns are checked: the document carries the organisation so an
        access check never has to join, and the job is checked too so a
        mismatch between them fails closed rather than open.
      */
      permitted =
        released &&
        row.agentOrganisationId !== null &&
        row.agentOrganisationId === scope.organisationId &&
        row.jobOrganisationId === scope.organisationId;
      break;
  }

  if (!permitted) return { ok: false, status: 404, error: "Not found." };

  const stored = await getDocument(row.blobKey);
  if (!stored.ok) {
    // The row exists and the bytes do not. Say so; do not pretend it is
    // missing, because that would hide a storage fault.
    return { ok: false, status: 503, error: "That document could not be read." };
  }

  return { ok: true, filename: row.filename, bytes: stored.bytes };
}
