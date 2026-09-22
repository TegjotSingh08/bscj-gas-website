import "server-only";

import { and, eq, isNull, or, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { certificateDrafts, jobs } from "@/lib/db/schema";
import { canAccessAssignedJob } from "@/lib/auth/scope";
import { assertCan } from "@/lib/auth/roles";
import type { Session } from "@/lib/auth/session";
import { canUploadCertificate, uploadRefusal } from "./release";
import { uploadCertificate } from "./certificates";
import { derivedDocumentKey } from "@/lib/storage/documents";
import {
  describeIncompleteDraft,
  sanitiseDraftFields,
  type CertificateDraftFields,
} from "./certificate-draft-fields";

/**
 * The engineer's gas safety record, held against the job while it is written.
 *
 * **What this is for.** The old workflow was four steps and a file: download
 * the job's details, open the generator, import the file, upload the PDF back.
 * On a phone in a hallway that is unusable, and it left a document full of a
 * customer's details sitting in the device's Downloads folder every time. The
 * connected workflow keeps the same generator and the same certificate
 * lifecycle, and replaces the file with this: a draft that belongs to the job,
 * lives on the server, and is submitted straight into the existing
 * awaiting-review state.
 *
 * ---
 *
 * **Every function here re-derives access from the row.** The job id arrives
 * from a browser and is treated as nothing more than a lookup key: the job is
 * read, `canAccessAssignedJob` decides, and an engineer who is not on the job
 * gets the same answer as for a job that does not exist. Nothing trusts a
 * client-supplied organisation, property, owner or engineer identity, and a
 * booking reference is not accepted as an identifier at all.
 *
 * **It is checked on every call, not once at the page.** An engineer taken off
 * a job, or an account suspended, loses access to the draft on their next save
 * — not at their next sign-in.
 *
 * **Submission does not issue anything.** It calls the same
 * `uploadCertificate` the manual upload has always used, so the document lands
 * in the same private store, under the same PDF checks, in the same
 * awaiting-review state. No certificate row is written, no compliance date
 * moves and nobody is emailed. An administrator still has to open it and
 * release it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How long a submission claim is believed to be live.
 *
 * Long enough that a slow upload on a poor signal is never mistaken for a
 * dead one, short enough that an engineer recovering their own interrupted
 * attempt is not left waiting. The outbox uses the same idea for the same
 * reason — a lease, not a lock, because the holder may never come back.
 */
export const SUBMISSION_LEASE_SECONDS = 120;

const NOT_FOUND = "That job could not be found.";
const NO_DATABASE = "The database is not configured.";

/** What a draft looks like to a caller. */
export type CertificateDraft = {
  fields: CertificateDraftFields;
  /**
   * The revision this draft is at.
   *
   * A save states the revision it was based on and is refused if the stored
   * one has moved. Zero means there is no stored draft yet, so the first save
   * from a fresh sheet is based on nothing and cannot conflict with anything.
   */
  revision: number;
  updatedAt: Date | null;
  /** Set once a submission has been recorded against this draft. */
  submittedAt: Date | null;
  submittedDocumentId: string | null;
};

export type DraftJob = {
  id: string;
  reference: string;
  lifecycleStatus: string;
  agentOrganisationId: string | null;
  assignedEngineerId: string | null;
};

/**
 * The job, if this session may work on it. Null for every other reason.
 *
 * Deliberately one function used by all three entry points below, so "may
 * this person touch this job" has exactly one answer and cannot be
 * implemented twice slightly differently.
 */
async function authorisedJob(
  session: Session,
  jobId: string,
): Promise<DraftJob | null> {
  const db = getDb();
  if (!db || !UUID.test(jobId)) return null;

  const [job] = await db
    .select({
      id: jobs.id,
      reference: jobs.reference,
      lifecycleStatus: jobs.lifecycleStatus,
      agentOrganisationId: jobs.agentOrganisationId,
      assignedEngineerId: jobs.assignedEngineerId,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!job) return null;
  if (!canAccessAssignedJob(session.scope, job)) return null;
  return job;
}

export type LoadResult =
  | { ok: true; job: DraftJob; draft: CertificateDraft }
  | { ok: false; error: string };

/** The stored draft for a job, or an empty one. */
export async function loadCertificateDraft(input: {
  session: Session;
  jobId: string;
}): Promise<LoadResult> {
  const { session, jobId } = input;
  assertCan(session.user.role, "certificate:issue");

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };

  const job = await authorisedJob(session, jobId);
  if (!job) return { ok: false, error: NOT_FOUND };

  const [row] = await db
    .select({
      fields: certificateDrafts.fields,
      revision: certificateDrafts.revision,
      updatedAt: certificateDrafts.updatedAt,
      submittedAt: certificateDrafts.submittedAt,
      submittedDocumentId: certificateDrafts.submittedDocumentId,
    })
    .from(certificateDrafts)
    .where(eq(certificateDrafts.jobId, job.id))
    .limit(1);

  if (!row) {
    return {
      ok: true,
      job,
      draft: {
        fields: {},
        revision: 0,
        updatedAt: null,
        submittedAt: null,
        submittedDocumentId: null,
      },
    };
  }

  return {
    ok: true,
    job,
    draft: {
      /*
        Sanitised on the way out as well as in. The column is `jsonb` and a
        row could predate a change to the allow-list; a reader should never
        have to wonder whether what it holds is what this module means by a
        draft.
      */
      fields: sanitiseDraftFields(row.fields),
      revision: row.revision,
      updatedAt: row.updatedAt,
      submittedAt: row.submittedAt,
      submittedDocumentId: row.submittedDocumentId,
    },
  };
}

export type SaveResult =
  | { ok: true; revision: number; updatedAt: Date }
  /**
   * Somebody else's save landed first.
   *
   * Carries the current draft so the caller can show what is actually stored
   * rather than only refusing. A stale phone left open in a van must not be
   * able to replace the work done afterwards on a tablet, and the way to make
   * that true without losing anybody's work is to refuse and say so.
   */
  | { ok: false; conflict: true; error: string; draft: CertificateDraft }
  | { ok: false; conflict?: false; error: string };

/**
 * Stores a draft, if it is based on the revision that is actually current.
 *
 * `expectedRevision` of 0 means "I believe there is no draft yet". If one has
 * appeared since, that is a conflict too — two engineers cannot both start the
 * same record and have the second silently win.
 */
export async function saveCertificateDraft(input: {
  session: Session;
  jobId: string;
  fields: unknown;
  expectedRevision: number;
}): Promise<SaveResult> {
  const { session, jobId, expectedRevision } = input;
  assertCan(session.user.role, "certificate:issue");

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };

  const job = await authorisedJob(session, jobId);
  if (!job) return { ok: false, error: NOT_FOUND };

  const fields = sanitiseDraftFields(input.fields);

  /*
    A draft is working state and may be saved at any point in the visit —
    half-finished, in a cold hallway, with one appliance still to do. What is
    gated is the *submission*, not the work in progress. The one thing refused
    here is a job that could never carry a certificate at all.
  */
  if (!canUploadCertificate(job.lifecycleStatus)) {
    return { ok: false, error: uploadRefusal(job.lifecycleStatus) ?? NOT_FOUND };
  }

  const now = new Date();

  if (expectedRevision === 0) {
    /*
      Insert, and let the unique index decide. Two tabs both starting a draft
      race here; exactly one wins, and the loser is told rather than
      overwriting. `onConflictDoNothing` returns no row when it lost.
    */
    const inserted = await db
      .insert(certificateDrafts)
      .values({
        jobId: job.id,
        agentOrganisationId: job.agentOrganisationId,
        fields,
        revision: 1,
        updatedBy: session.user.id,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: certificateDrafts.jobId })
      .returning({ revision: certificateDrafts.revision });

    if (inserted.length > 0) {
      return { ok: true, revision: inserted[0].revision, updatedAt: now };
    }
    return conflict(session, job.id);
  }

  const updated = await db
    .update(certificateDrafts)
    .set({
      fields,
      revision: sql`${certificateDrafts.revision} + 1`,
      updatedBy: session.user.id,
      updatedAt: now,
      /*
        Saving again after a submission starts a new attempt: the old key must
        not be able to satisfy a later submit as a replay. The submitted
        document itself is untouched — it is already in front of an
        administrator and belongs to the certificate lifecycle, not to this.
      */
      submissionKey: null,
      submissionStartedAt: null,
      /*
        And it is no longer *this* draft that was submitted. The document
        already with the office is untouched — it belongs to the certificate
        lifecycle — but the job screen must stop saying "submitted and waiting"
        over work the office has not seen.
      */
      submittedAt: null,
    })
    .where(
      and(
        eq(certificateDrafts.jobId, job.id),
        eq(certificateDrafts.revision, expectedRevision),
      ),
    )
    .returning({ revision: certificateDrafts.revision });

  if (updated.length === 0) return conflict(session, job.id);
  return { ok: true, revision: updated[0].revision, updatedAt: now };
}

/** The refusal, with whatever is actually stored attached to it. */
async function conflict(session: Session, jobId: string): Promise<SaveResult> {
  const current = await loadCertificateDraft({ session, jobId });
  return {
    ok: false,
    conflict: true,
    error:
      "This record has been saved somewhere else since this screen loaded. Nothing has been overwritten.",
    draft: current.ok
      ? current.draft
      : {
          fields: {},
          revision: 0,
          updatedAt: null,
          submittedAt: null,
          submittedDocumentId: null,
        },
  };
}

export type SubmitResult =
  | { ok: true; documentId: string; message: string; replayed: boolean }
  | { ok: false; error: string; missing?: readonly string[] };

/**
 * The finished record, into the existing awaiting-review state.
 *
 * **It reuses `uploadCertificate` rather than reimplementing it.** That is
 * where the PDF is checked from its bytes, stored in the private document
 * store before any row is written, and reconciled if the insert's outcome is
 * uncertain. Submission is the manual upload with the file coming from the
 * generator instead of from a file picker, and treating it as anything more
 * than that would be a second certificate lifecycle.
 *
 * **Idempotent by key.** A double tap, a retry after a timeout, a browser that
 * resent on a flaky connection: the same `submissionKey` returns the document
 * the first attempt produced rather than making a second one. The key is
 * cleared by the next save, so a genuine second submission after more work is
 * a new attempt and not a replay.
 */
export async function submitCertificateDraft(input: {
  session: Session;
  jobId: string;
  bytes: Uint8Array;
  filename: unknown;
  submissionKey: string;
  /**
   * The draft revision the PDF was drawn from.
   *
   * **What the server can and cannot check about a PDF.** It checks that the
   * bytes are a PDF, and it checks that the *stored draft* is complete — but
   * it does not read the document, so it cannot know that the figures printed
   * on it are the figures in the draft. Nothing here should be described as
   * verifying the contents, because it does not.
   *
   * What it can establish is that the two refer to the same state: the client
   * says which revision it drew, and this refuses if the stored draft has
   * moved since. That closes the case that matters — a PDF drawn before an
   * edit being filed against the draft made after it.
   */
  drawnFromRevision?: number;
}): Promise<SubmitResult> {
  const { session, jobId, submissionKey } = input;
  assertCan(session.user.role, "certificate:issue");

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!submissionKey || submissionKey.length > 100) {
    return { ok: false, error: "This submission could not be identified." };
  }

  const job = await authorisedJob(session, jobId);
  if (!job) return { ok: false, error: NOT_FOUND };

  const [existing] = await db
    .select({
      fields: certificateDrafts.fields,
      revision: certificateDrafts.revision,
      submissionKey: certificateDrafts.submissionKey,
      submittedDocumentId: certificateDrafts.submittedDocumentId,
      submissionStartedAt: certificateDrafts.submissionStartedAt,
    })
    .from(certificateDrafts)
    .where(eq(certificateDrafts.jobId, job.id))
    .limit(1);

  if (!existing) {
    return {
      ok: false,
      error: "There is no saved record for this job. Save the draft first.",
    };
  }

  /*
    The replay check comes before anything is generated or stored. Two taps a
    second apart must not produce two documents for one administrator to
    choose between.
  */
  if (
    existing.submissionKey === submissionKey &&
    existing.submittedDocumentId
  ) {
    return {
      ok: true,
      documentId: existing.submittedDocumentId,
      replayed: true,
      message: "Already submitted. It is with the office, waiting for review.",
    };
  }

  /*
    The server decides whether the record is complete, from what is stored.
    The generator checks too, so the engineer is told before a PDF is drawn —
    but a check that only runs in a browser is not a check.
  */
  /*
    The PDF and the draft must be the same state. A client that says nothing
    is an older one, and is let through — the alternative is refusing every
    submission from a tab that has not reloaded, which would be a worse
    failure than the one this prevents.
  */
  if (
    typeof input.drawnFromRevision === "number" &&
    input.drawnFromRevision !== existing.revision
  ) {
    return {
      ok: false,
      error:
        "This record changed after the certificate was drawn, so nothing was submitted. Press Submit for review again to draw it from what is saved now.",
    };
  }

  const missing = describeIncompleteDraft(sanitiseDraftFields(existing.fields));
  if (missing.length > 0) {
    return {
      ok: false,
      error: "This record is not finished yet.",
      missing,
    };
  }

  /*
    **Claim the key before a single byte is stored.**

    The read above catches the ordinary duplicate: a retry after a response
    that never arrived, seconds or minutes later. It cannot catch two requests
    in flight at once — both read "not submitted yet" and both go on to store
    a document, which is exactly what a double tap on a slow connection
    produces, and it leaves the office holding two records for one visit.

    This closes it with the database rather than with timing. The `UPDATE`
    takes a row lock; a second request evaluating the same statement waits for
    the first to commit and then **re-checks its own `WHERE`**, which by then
    is false. One claim succeeds, the other gets no row back. No advisory lock,
    no transaction spanning an upload, and nothing that depends on the two
    requests reaching the same process.
  */
  const startedAt = new Date();
  const claimed = await db
    .update(certificateDrafts)
    .set({ submissionKey, submissionStartedAt: startedAt })
    .where(
      and(
        eq(certificateDrafts.jobId, job.id),
        or(
          sql`${certificateDrafts.submissionKey} is distinct from ${submissionKey}`,
          /*
            **Or this attempt's own claim, abandoned.** A process that dies
            between claiming and storing leaves its key behind with no
            document under it. The engineer's retry is the *same* key — it is
            the same attempt — so without this it matched nothing, found
            nothing to replay, and was told for ever that a submission was
            already in flight. Past the lease, the attempt takes its own claim
            back.
          */
          sql`(
            ${certificateDrafts.submittedDocumentId} is null
            and (
              ${certificateDrafts.submissionStartedAt} is null
              or ${certificateDrafts.submissionStartedAt} < now() - ${sql.raw(`interval '${SUBMISSION_LEASE_SECONDS} seconds'`)}
            )
          )`,
        ),
      ),
    )
    .returning({ id: certificateDrafts.id });

  if (claimed.length === 0) {
    /*
      Somebody else holds this key and the claim is young, so it is a request
      that is probably still running. Wait briefly for its document rather than
      storing a second one — the thing being waited for takes milliseconds and
      the alternative is a duplicate record in front of an administrator.
    */
    const settled = await awaitSubmission(job.id);
    if (settled) {
      return {
        ok: true,
        documentId: settled,
        replayed: true,
        message: "Already submitted. It is with the office, waiting for review.",
      };
    }
    return {
      ok: false,
      error:
        "This record is already being submitted. Wait a moment, then open the job to check whether it arrived before sending it again.",
    };
  }

  /*
    **The same attempt always writes to the same place.**

    This is what makes an interruption recoverable exactly rather than by
    guesswork. A process that died after storing the object but before writing
    the row left a PDF with no record of it; the retry derives the same key,
    writes the same bytes over it, and `uploadCertificate`'s unique index on
    `blob_key` turns its second insert into a lookup of the first — so the
    engineer gets back the document their earlier attempt produced instead of
    a duplicate for an administrator to choose between.

    The job id is in the seed as well as the key, so two jobs can never
    collide even if a client reused a key.
  */
  const blobKey = derivedDocumentKey(`${job.id}:${submissionKey}`);

  const uploaded = await uploadCertificate({
    session,
    jobId: job.id,
    bytes: input.bytes,
    filename: input.filename,
    blobKey,
  });
  if (!uploaded.ok) {
    /*
      Nothing was stored, so the claim must go back: otherwise the engineer's
      retry — the same key, because it is the same attempt — would be told
      that a submission is already in flight and refused for ever.
    */
    await releaseClaim(job.id, submissionKey);
    return { ok: false, error: uploaded.error };
  }

  /*
    `DocumentResult` shares a type with `releaseCertificate`, where the id is
    optional. An upload always carries one — it refuses rather than returning
    a success nobody can point at — but asserting that with a `!` would be
    this module claiming something the type does not say.
  */
  const documentId = uploaded.documentId;
  if (!documentId) {
    await releaseClaim(job.id, submissionKey);
    return {
      ok: false,
      error: "The certificate could not be recorded. Please try again.",
    };
  }

  /*
    **The document exists and is already in front of the office.** Recording
    the key against the draft is bookkeeping for idempotency, so a failure
    here must not be reported as a failed submission — that would invite a
    retry and a second document. The consequence of losing this write is that
    one retry could duplicate, which is visible and recoverable; reporting a
    stored certificate as lost is neither.
  */
  try {
    await db
      .update(certificateDrafts)
      .set({
        submittedDocumentId: documentId,
        submittedAt: new Date(),
      })
      .where(
        and(
          eq(certificateDrafts.jobId, job.id),
          /* Only if this attempt still holds the claim. */
          eq(certificateDrafts.submissionKey, submissionKey),
        ),
      );
  } catch {
    // Deliberately swallowed. See above.
  }

  return {
    ok: true,
    documentId,
    replayed: false,
    message: uploaded.message,
  };
}

/**
 * Waits a moment for a simultaneous attempt to finish storing its document.
 *
 * Bounded and short. The thing being waited for is one object write and one
 * insert; if it has not appeared in a second it is not going to, and saying
 * so is better than holding a request open.
 */
async function awaitSubmission(jobId: string): Promise<string | null> {
  const db = getDb();
  if (!db) return null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [row] = await db
      .select({ documentId: certificateDrafts.submittedDocumentId })
      .from(certificateDrafts)
      .where(eq(certificateDrafts.jobId, jobId))
      .limit(1);
    if (row?.documentId) return row.documentId;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

/**
 * Submissions that claimed a job and never finished.
 *
 * What an administrator needs to see: a record an engineer believes they sent
 * that has no document under it. Everything here is derived from the rows, so
 * it survives a refresh and is still true tomorrow.
 */
export type StalledSubmission = {
  jobId: string;
  reference: string;
  startedAt: Date | null;
  revision: number;
};

export async function listStalledSubmissions(
  limit = 20,
): Promise<StalledSubmission[] | null> {
  const db = getDb();
  if (!db) return null;

  try {
    const rows = await db
      .select({
        jobId: certificateDrafts.jobId,
        reference: jobs.reference,
        startedAt: certificateDrafts.submissionStartedAt,
        revision: certificateDrafts.revision,
      })
      .from(certificateDrafts)
      .innerJoin(jobs, eq(jobs.id, certificateDrafts.jobId))
      .where(
        and(
          sql`${certificateDrafts.submissionKey} is not null`,
          isNull(certificateDrafts.submittedDocumentId),
          sql`(
            ${certificateDrafts.submissionStartedAt} is null
            or ${certificateDrafts.submissionStartedAt} < now() - ${sql.raw(`interval '${SUBMISSION_LEASE_SECONDS} seconds'`)}
          )`,
        ),
      )
      .orderBy(certificateDrafts.submissionStartedAt)
      .limit(limit);

    return rows;
  } catch {
    return null;
  }
}

/**
 * Releases a stalled claim, so the engineer can send the record again.
 *
 * **The safest possible recovery action, deliberately.** It clears a claim and
 * nothing else: no document is deleted, no certificate is touched, no renewal
 * moves and nobody is emailed. If the attempt did store a PDF, that PDF is
 * already in the review list and this does not disturb it; the engineer's next
 * submission is simply allowed to proceed rather than being refused.
 *
 * Administrators only, and it refuses a claim that produced a document — that
 * one is not stalled, it is done.
 */
export async function releaseStalledSubmission(input: {
  session: Session;
  jobId: string;
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const { session, jobId } = input;
  assertCan(session.user.role, "certificate:issue");
  if (session.scope.kind !== "all") return { ok: false, error: NOT_FOUND };

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!UUID.test(jobId)) return { ok: false, error: NOT_FOUND };

  const released = await db
    .update(certificateDrafts)
    .set({ submissionKey: null, submissionStartedAt: null })
    .where(
      and(
        eq(certificateDrafts.jobId, jobId),
        isNull(certificateDrafts.submittedDocumentId),
        sql`${certificateDrafts.submissionKey} is not null`,
      ),
    )
    .returning({ id: certificateDrafts.id });

  if (released.length === 0) {
    return {
      ok: false,
      error: "There is nothing stalled on that job — it may have completed.",
    };
  }

  return {
    ok: true,
    message:
      "Released. The engineer can submit that record again; nothing was deleted.",
  };
}

/** Puts a claim back when the attempt holding it stored nothing. */
async function releaseClaim(jobId: string, submissionKey: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .update(certificateDrafts)
      .set({ submissionKey: null, submissionStartedAt: null })
      .where(
        and(
          eq(certificateDrafts.jobId, jobId),
          eq(certificateDrafts.submissionKey, submissionKey),
          /* Never unclaim one that actually produced a document. */
          sql`${certificateDrafts.submittedDocumentId} is null`,
        ),
      );
  } catch {
    // The retry will be refused rather than duplicating. Safe direction.
  }
}

/** Whether a job already has a draft, for the button's wording. */
export async function draftSummaryFor(
  session: Session,
  jobId: string,
): Promise<{ exists: boolean; submittedAt: Date | null } | null> {
  const loaded = await loadCertificateDraft({ session, jobId });
  if (!loaded.ok) return null;
  return {
    exists: loaded.draft.revision > 0,
    submittedAt: loaded.draft.submittedAt,
  };
}
