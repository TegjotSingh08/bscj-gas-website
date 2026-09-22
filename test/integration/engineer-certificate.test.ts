import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  connect,
  reset,
  start,
  stop,
  type Connection,
} from "../support/disposable-postgres";
import { setDbForTesting } from "../../src/lib/db/client";
import { seed, type Fixture } from "../support/fixtures";
import {
  loadCertificateDraft,
  saveCertificateDraft,
  submitCertificateDraft,
  draftSummaryFor,
} from "../../src/lib/documents/certificate-drafts";

/**
 * The connected engineer certificate workflow, against a real database.
 *
 * **What this replaces, and why it is worth testing as one path.** The old
 * workflow was: download a file of the customer's details, open the
 * generator, import the file, generate a PDF, come back and upload it. The
 * new one keeps the same generator and the same certificate lifecycle and
 * removes the file: the draft lives against the job on the server, and the
 * finished PDF is submitted straight into the existing awaiting-review state.
 *
 * Everything below goes through the production functions the routes call.
 * Nothing here constructs a session the application would not accept, and no
 * check is bypassed or stubbed — the point of these is the access decisions,
 * so faking one would leave exactly the thing that matters untested.
 *
 * Every record is fictional and the certificate PDF is the repository's
 * `TEST-NOT-VALID` specimen, which says on its face that it certifies
 * nothing.
 */

let conn: Connection;
let fixture: Fixture;

/** The `TEST-NOT-VALID` specimen, as the generator's output stands in here. */
const SPECIMEN = new Uint8Array(
  readFileSync("docs/acceptance/TEST-NOT-VALID-certificate.pdf"),
);

before(async () => {
  await start();
  conn = await connect();
  setDbForTesting(conn.db as never);
  process.env.BSCJ_DOCUMENT_STORE = "local";
  process.env.BSCJ_DOCUMENT_DIR = process.env.BSCJ_DOCUMENT_DIR ?? "/tmp";
});

after(async () => {
  setDbForTesting(null);
  await stop();
});

beforeEach(async () => {
  await reset(conn);
  fixture = await seed(conn);
  // The fixture job is in progress; the connected flow needs it assigned.
  await conn.client.query(
    "update job set assigned_engineer_id = $1 where id = $2",
    [fixture.engineerUserId, fixture.jobId],
  );
});

/** The sessions the guards actually receive, built the way the app builds them. */
const engineer = (): never =>
  ({
    user: {
      id: fixture.engineerUserId,
      email: "engineer@fixture.example.invalid",
      role: "engineer",
    },
    scope: { kind: "assigned", userId: fixture.engineerUserId },
  }) as never;

const otherEngineer = (): never =>
  ({
    user: {
      id: fixture.otherEngineerUserId,
      email: "engineer2@fixture.example.invalid",
      role: "engineer",
    },
    scope: { kind: "assigned", userId: fixture.otherEngineerUserId },
  }) as never;

const admin = (): never =>
  ({
    user: {
      id: fixture.adminUserId,
      email: "admin@fixture.example.invalid",
      role: "admin",
    },
    scope: { kind: "all" },
  }) as never;

/** A finished record, as the generator would have collected it off the sheet. */
function completeFields(overrides: Record<string, string> = {}) {
  return {
    certNo: "TEST-NOT-VALID-0001",
    instEngineer: "Fixture Engineer",
    instCompany: "BSCJ (FIXTURE)",
    jobName: "Ada Fixture",
    jobAddress: "14 Fixture Street, Wolverhampton",
    jobPostcode: "WV1 1AA",
    sigDate: "20/09/2026",
    issuedPrintName: "Fixture Engineer",
    app_1_location: "Kitchen",
    app_1_type: "Boiler",
    app_1_make: "Fixture",
    coFitted: "yes",
    coTested: "yes",
    chkEmergency: "yes",
    chkTightness: "yes",
    chkPipework: "yes",
    chkBonding: "yes",
    ...overrides,
  };
}

async function saveComplete(session = engineer(), revision = 0) {
  return saveCertificateDraft({
    session,
    jobId: fixture.jobId,
    fields: completeFields(),
    expectedRevision: revision,
  });
}

async function countRows(table: string, where = ""): Promise<number> {
  const { rows } = await conn.client.query<{ n: string }>(
    `select count(*)::text as n from ${table} ${where}`,
  );
  return Number(rows[0].n);
}

describe("opening the record on an assigned job", () => {
  test("an engineer on the job gets an empty draft, not a refusal", async () => {
    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.equal(loaded.ok, true);
    assert.ok(loaded.ok);
    assert.equal(loaded.job.reference, fixture.jobReference);
    assert.deepEqual(loaded.draft.fields, {});
    assert.equal(loaded.draft.revision, 0, "nothing stored yet");
    assert.equal(loaded.draft.submittedAt, null);
  });

  test("the draft is bound to the job it was saved against", async () => {
    await saveComplete();

    // A second job, same engineer, same property.
    const { rows } = await conn.client.query<{ id: string }>(
      `insert into job
         (reference, idempotency_key, agent_organisation_id, customer_id,
          billing_customer_id, property_id, product_id, source,
          scheduling_method, lifecycle_status, appliance_count,
          price_total_pence, customer_snapshot, property_snapshot,
          price_snapshot, assigned_engineer_id)
       values ('BSCJ-SECOND', 'BSCJ-SECOND', $1, $2, $2, $3, 'cp12', 'portal',
               'tenant_selected', 'in_progress', 1, 4500,
               '{"name":"Ada Fixture"}'::jsonb,
               '{"postcode":"WV1 1AA"}'::jsonb,
               '{"totalPence":4500}'::jsonb, $4)
       returning id`,
      [
        fixture.organisationId,
        fixture.landlordId,
        fixture.propertyId,
        fixture.engineerUserId,
      ],
    );

    const other = await loadCertificateDraft({
      session: engineer(),
      jobId: rows[0].id,
    });
    assert.ok(other.ok);
    assert.deepEqual(
      other.draft.fields,
      {},
      "one job's record never appears on another's",
    );
  });

  test("the summary the job page uses says whether one is part-written", async () => {
    assert.deepEqual(await draftSummaryFor(engineer(), fixture.jobId), {
      exists: false,
      submittedAt: null,
    });

    await saveComplete();

    const after = await draftSummaryFor(engineer(), fixture.jobId);
    assert.equal(after?.exists, true);
    assert.equal(after?.submittedAt, null);
  });
});

describe("a draft that survives the phone being put away", () => {
  test("it is stored and comes back exactly as it went in", async () => {
    const saved = await saveComplete();
    assert.ok(saved.ok);
    assert.equal(saved.revision, 1);

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.draft.fields, completeFields());
    assert.equal(loaded.draft.revision, 1);
  });

  test("saving again advances the revision and replaces the fields", async () => {
    await saveComplete();
    const second = await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ comments: "Second visit note." }),
      expectedRevision: 1,
    });
    assert.ok(second.ok);
    assert.equal(second.revision, 2);

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.equal(loaded.draft.fields.comments, "Second visit note.");
  });

  test("a reading the server does not recognise is dropped, not stored", async () => {
    const saved = await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: { certNo: "TEST-NOT-VALID-0001", smuggled: "x".repeat(100) },
      expectedRevision: 0,
    });
    assert.ok(saved.ok);

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.draft.fields, { certNo: "TEST-NOT-VALID-0001" });
  });

  test("one draft per job, so two tabs cannot both start one", async () => {
    const first = await saveComplete();
    assert.ok(first.ok);

    /*
      The second tab still believes there is no draft. The unique index
      decides, and the loser is told rather than replacing the winner.
    */
    const second = await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ certNo: "TEST-NOT-VALID-0002" }),
      expectedRevision: 0,
    });
    assert.equal(second.ok, false);
    assert.ok(!second.ok && second.conflict);
    assert.equal(await countRows("certificate_draft"), 1);

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.equal(loaded.draft.fields.certNo, "TEST-NOT-VALID-0001");
  });
});

describe("a stale tab cannot overwrite newer work", () => {
  test("a save based on an old revision is refused and nothing is lost", async () => {
    await saveComplete();
    // The tablet saves.
    const newer = await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ comments: "Done on the tablet." }),
      expectedRevision: 1,
    });
    assert.ok(newer.ok);

    // The phone, still open in the van, believes it is at revision 1.
    const stale = await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ comments: "Stale phone." }),
      expectedRevision: 1,
    });
    assert.equal(stale.ok, false);
    assert.ok(!stale.ok && stale.conflict);

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.equal(
      loaded.draft.fields.comments,
      "Done on the tablet.",
      "the newer work stands",
    );
  });

  test("the refusal carries what is actually stored, so nobody has to guess", async () => {
    await saveComplete();
    await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ comments: "Current." }),
      expectedRevision: 1,
    });

    const stale = await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ comments: "Stale." }),
      expectedRevision: 1,
    });
    assert.ok(!stale.ok && stale.conflict);
    assert.equal(stale.draft.fields.comments, "Current.");
    assert.equal(stale.draft.revision, 2);
  });
});

describe("a job that is not yours", () => {
  test("another engineer cannot read the draft", async () => {
    await saveComplete();

    const loaded = await loadCertificateDraft({
      session: otherEngineer(),
      jobId: fixture.jobId,
    });
    assert.equal(loaded.ok, false);
    assert.ok(!loaded.ok);
    assert.match(loaded.error, /could not be found/i);
  });

  test("another engineer cannot save over it, and nothing is written", async () => {
    await saveComplete();

    const saved = await saveCertificateDraft({
      session: otherEngineer(),
      jobId: fixture.jobId,
      fields: completeFields({ certNo: "TEST-NOT-VALID-9999" }),
      expectedRevision: 1,
    });
    assert.equal(saved.ok, false);

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.equal(loaded.draft.fields.certNo, "TEST-NOT-VALID-0001");
    assert.equal(loaded.draft.revision, 1, "not even the revision moved");
  });

  test("another engineer cannot submit it", async () => {
    await saveComplete();

    const submitted = await submitCertificateDraft({
      session: otherEngineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "not-theirs",
    });
    assert.equal(submitted.ok, false);
    assert.equal(await countRows("document", "where kind = 'certificate' and blob_key not like 'fixture/%'"), 0);
  });

  test("a guessed id for a job that does not exist reads the same as one that does", async () => {
    const missing = await loadCertificateDraft({
      session: engineer(),
      jobId: "00000000-0000-4000-8000-000000000000",
    });
    const notMine = await loadCertificateDraft({
      session: otherEngineer(),
      jobId: fixture.jobId,
    });
    assert.equal(missing.ok, false);
    assert.equal(notMine.ok, false);
    assert.ok(!missing.ok && !notMine.ok);
    assert.equal(
      missing.error,
      notMine.error,
      "the two are indistinguishable, so an id is not a probe",
    );
  });

  test("an id that is not a UUID is refused rather than reaching the database", async () => {
    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: "BSCJ-FIXT01",
    });
    assert.equal(loaded.ok, false, "a booking reference authorises nothing");
  });
});

describe("access is re-decided on every call, not at sign-in", () => {
  test("reassigning the job takes the draft away from the old engineer", async () => {
    await saveComplete();

    await conn.client.query(
      "update job set assigned_engineer_id = $1 where id = $2",
      [fixture.otherEngineerUserId, fixture.jobId],
    );

    const oldEngineer = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.equal(oldEngineer.ok, false, "no longer theirs, immediately");

    const saved = await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ comments: "After reassignment." }),
      expectedRevision: 1,
    });
    assert.equal(saved.ok, false);

    // And the engineer who now holds it can pick the work up.
    const newEngineer = await loadCertificateDraft({
      session: otherEngineer(),
      jobId: fixture.jobId,
    });
    assert.ok(newEngineer.ok);
    assert.equal(newEngineer.draft.fields.certNo, "TEST-NOT-VALID-0001");
  });

  test("an administrator can read any job's draft, as they can any job", async () => {
    await saveComplete();
    const loaded = await loadCertificateDraft({
      session: admin(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.equal(loaded.draft.revision, 1);
  });
});

describe("a job that cannot carry a certificate", () => {
  test("a cancelled job refuses the save and says why", async () => {
    await conn.client.query(
      "update job set lifecycle_status = 'cancelled' where id = $1",
      [fixture.jobId],
    );

    const saved = await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields(),
      expectedRevision: 0,
    });
    assert.equal(saved.ok, false);
    assert.ok(!saved.ok);
    assert.match(saved.error, /cancelled/i);
    assert.equal(await countRows("certificate_draft"), 0);
  });

  test("a visit that has not started refuses it too", async () => {
    await conn.client.query(
      "update job set lifecycle_status = 'scheduled' where id = $1",
      [fixture.jobId],
    );

    const saved = await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields(),
      expectedRevision: 0,
    });
    assert.equal(saved.ok, false);
    assert.ok(!saved.ok);
    assert.match(saved.error, /not started/i);
  });
});

describe("submitting the finished record", () => {
  test("it is refused while the record is unfinished, and nothing is stored", async () => {
    await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ chkTightness: "", certNo: "" }),
      expectedRevision: 0,
    });

    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "attempt-1",
    });
    assert.equal(submitted.ok, false);
    assert.ok(!submitted.ok);
    assert.ok(submitted.missing);
    assert.ok(submitted.missing.includes("Certificate number"));
    assert.ok(submitted.missing.some((m) => m.includes("Gas tightness")));
    assert.equal(
      await countRows("document", "where blob_key not like 'fixture/%'"),
      0,
      "no PDF was stored for a record that is not finished",
    );
  });

  test("the browser's own check is not what decides — the server re-checks", async () => {
    /*
      The generator refuses before it draws a PDF, which is the right place
      for the engineer's sake. This asserts the refusal also happens on the
      server, with the PDF already in hand, which is the one that counts.
    */
    await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ issuedPrintName: "" }),
      expectedRevision: 0,
    });

    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "attempt-1",
    });
    assert.equal(submitted.ok, false);
  });

  test("submitting with nothing saved is refused rather than inventing a draft", async () => {
    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "attempt-1",
    });
    assert.equal(submitted.ok, false);
    assert.ok(!submitted.ok);
    assert.match(submitted.error, /no saved record/i);
  });

  test("a finished record reaches awaiting review, and issues nothing", async () => {
    await saveComplete();

    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "attempt-1",
    });
    assert.ok(submitted.ok);
    assert.equal(submitted.replayed, false);

    // The document is stored against the job, awaiting review.
    const { rows } = await conn.client.query<{
      id: string;
      job_id: string;
      kind: string;
      size_bytes: number;
      sent_at: string | null;
    }>(
      "select id, job_id, kind, size_bytes, sent_at from document where id = $1",
      [submitted.documentId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].job_id, fixture.jobId);
    assert.equal(rows[0].kind, "certificate");
    assert.equal(rows[0].size_bytes, SPECIMEN.byteLength);
    assert.equal(rows[0].sent_at, null, "nothing has been sent");

    /*
      **The boundary this whole feature had to preserve.** Submitting is not
      issuing. An administrator still has to open it and release it.
    */
    assert.equal(await countRows("certificate"), 0, "no certificate issued");
    assert.equal(
      await countRows("compliance_cycle"),
      0,
      "no renewal date moved",
    );
    assert.equal(
      await countRows("outbound_email"),
      0,
      "nobody was emailed",
    );
  });

  test("the job's own lifecycle is untouched by submitting", async () => {
    await saveComplete();
    await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "attempt-1",
    });

    const { rows } = await conn.client.query<{ lifecycle_status: string }>(
      "select lifecycle_status from job where id = $1",
      [fixture.jobId],
    );
    assert.equal(
      rows[0].lifecycle_status,
      "in_progress",
      "a job is not silently finished by filing its paperwork",
    );
  });

  test("a rubbish file is refused by the same PDF check the upload uses", async () => {
    await saveComplete();
    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: new Uint8Array([1, 2, 3, 4]),
      filename: "not-a-pdf.pdf",
      submissionKey: "attempt-1",
    });
    assert.equal(submitted.ok, false);
    assert.equal(await countRows("document", "where blob_key not like 'fixture/%'"), 0);
  });
});

describe("a double tap, a timeout and a retry", () => {
  test("the same submission key never makes a second record", async () => {
    await saveComplete();

    const first = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "one-tap",
    });
    assert.ok(first.ok);
    assert.equal(first.replayed, false);

    const second = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "one-tap",
    });
    assert.ok(second.ok);
    assert.equal(second.replayed, true, "reported as the replay it is");
    assert.equal(second.documentId, first.documentId);

    assert.equal(
      await countRows("document", "where blob_key not like 'fixture/%'"),
      1,
      "one document for one submission, whatever the network did",
    );
  });

  test("two simultaneous taps produce one document", async () => {
    await saveComplete();

    const [a, b] = await Promise.all([
      submitCertificateDraft({
        session: engineer(),
        jobId: fixture.jobId,
        bytes: SPECIMEN,
        filename: "TEST-NOT-VALID-certificate.pdf",
        submissionKey: "same-key",
      }),
      submitCertificateDraft({
        session: engineer(),
        jobId: fixture.jobId,
        bytes: SPECIMEN,
        filename: "TEST-NOT-VALID-certificate.pdf",
        submissionKey: "same-key",
      }),
    ]);

    /*
      Exactly one of them stores a document. The other loses the claim on the
      submission key, waits for the winner and reports the same document — so
      whichever way the race goes, the office is handed one record for one
      visit rather than two to choose between.
    */
    assert.ok(a.ok || b.ok, "at least one tap got through");
    if (a.ok && b.ok) assert.equal(a.documentId, b.documentId);
    assert.equal(
      await countRows("document", "where blob_key not like 'fixture/%'"),
      1,
      "one stored document, whichever tap won",
    );
  });

  test("more work after a submission is a new attempt, not a replay", async () => {
    await saveComplete();
    const first = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "first-attempt",
    });
    assert.ok(first.ok);

    /*
      The engineer notices something, reopens the record and saves again. The
      old key must not be able to satisfy the next submit as a replay — that
      would silently file the previous PDF as if it were the corrected one.
    */
    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ comments: "Corrected the model number." }),
      expectedRevision: loaded.draft.revision,
    });

    const replayAttempt = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "first-attempt",
    });
    assert.ok(replayAttempt.ok);
    assert.equal(
      replayAttempt.replayed,
      false,
      "the key was cleared by the save, so this is a fresh submission",
    );
  });

  test("a failed submission leaves the draft exactly as it was", async () => {
    await saveComplete();

    const failed = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: new Uint8Array([0]),
      filename: "broken.pdf",
      submissionKey: "attempt-1",
    });
    assert.equal(failed.ok, false);

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.deepEqual(
      loaded.draft.fields,
      completeFields(),
      "the engineer's work is still there to retry with",
    );
    assert.equal(loaded.draft.submittedAt, null);

    // And the retry, with the real document, goes through.
    const retried = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "attempt-2",
    });
    assert.ok(retried.ok);
  });
});

describe("the office picks it up through the path it always used", () => {
  test("a submitted record is reviewable and releasable, unchanged", async () => {
    await saveComplete();
    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "attempt-1",
    });
    assert.ok(submitted.ok);

    /* It appears where the administrator already looks — no upload step. */
    const { listPendingDocuments } = await import(
      "../../src/lib/documents/certificates"
    );
    const pending = await listPendingDocuments(fixture.jobId);
    assert.ok(
      pending.some((doc) => doc.id === submitted.documentId),
      "the submitted record is in the office's review list with no upload step",
    );

    /* And releasing it is the existing function, doing the existing thing. */
    const { releaseCertificate } = await import(
      "../../src/lib/documents/certificates"
    );
    const released = await releaseCertificate({
      session: admin(),
      jobId: fixture.jobId,
      documentId: submitted.documentId,
      details: {
        certificateNumber: "TEST-NOT-VALID-0001",
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-09-19",
        correctionReason: "",
      },
      today: "2026-09-22",
    });
    assert.equal(released.ok, true);

    const { rows } = await conn.client.query<{
      certificate_number: string;
      version: number;
      status: string;
      document_id: string;
    }>(
      "select certificate_number, version, status, document_id from certificate",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].certificate_number, "TEST-NOT-VALID-0001");
    assert.equal(rows[0].version, 1);
    assert.equal(rows[0].status, "issued");
    assert.equal(
      rows[0].document_id,
      submitted.documentId,
      "the certificate points at the PDF the engineer submitted",
    );

    /* Release is what moves the renewal — submission never did. */
    const { rows: cycles } = await conn.client.query<{ due_date: string }>(
      "select due_date from compliance_cycle where status = 'active'",
    );
    assert.deepEqual(cycles, [{ due_date: "2027-09-19" }]);
  });

  test("the manual upload still works, for a record made elsewhere", async () => {
    const { uploadCertificate } = await import(
      "../../src/lib/documents/certificates"
    );
    const uploaded = await uploadCertificate({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
    });
    assert.equal(uploaded.ok, true);

    const { listPendingDocuments } = await import(
      "../../src/lib/documents/certificates"
    );
    assert.ok(
      (await listPendingDocuments(fixture.jobId)).some(
        (doc) => doc.id === uploaded.documentId,
      ),
      "an uploaded record reaches the same review list",
    );
    assert.equal(
      await countRows("certificate_draft"),
      0,
      "an upload needs no draft and creates none",
    );
  });
});

/**
 * What a process death leaves behind, and whether anybody can get out of it.
 *
 * **Why these are written as database states rather than as killed processes.**
 * A submission is: claim the key, store the object, insert the row, record the
 * link. A crash, a serverless timeout or a dropped connection can land between
 * any two of those, and what the *next* request sees is exactly the row state
 * the dead one left. Reproducing that state is reproducing the interruption —
 * and it is the only way to reproduce it deterministically.
 */
describe("a submission interrupted part-way", () => {
  /** The row as a process that died just after claiming the key leaves it. */
  async function claimLeftBehind(key: string, startedMinutesAgo = 10) {
    await conn.client.query(
      `update certificate_draft
          set submission_key = $1,
              submission_started_at = now() - ($2 || ' minutes')::interval
        where job_id = $3`,
      [key, String(startedMinutesAgo), fixture.jobId],
    );
  }

  test("a retry after dying between the claim and the upload gets through", async () => {
    /*
      **The permanent "submitting" state.** The claim is `IS DISTINCT FROM`, so
      the engineer's own retry — same key, because it is the same attempt —
      matched nothing, found no document to replay, and was told the record was
      already being submitted. For ever: nothing clears the key, so every
      retry, on any device, got the same answer and the certificate could never
      be filed.
    */
    await saveComplete();
    await claimLeftBehind("attempt-1");

    const retried = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "attempt-1",
    });

    assert.ok(retried.ok, "the engineer can recover their own attempt");
    assert.equal(retried.replayed, false, "nothing was stored last time");
    assert.equal(
      await countRows("document", "where blob_key not like 'fixture/%'"),
      1,
      "and exactly one document exists",
    );
  });

  test("a retry after dying between the upload and the link finds the document", async () => {
    /*
      The worse half: the PDF **is** stored and already in front of the office,
      but the draft never learned its id. A retry must not store a second copy
      for an administrator to choose between — it has to find the first.
    */
    await saveComplete();

    /*
      Stored the way the submission path stores it — under the key derived
      from this attempt — because that is what a process dying here would
      actually have left behind. An orphan under a random key is a different
      situation, and the honest answer to it is the administrator's release
      action rather than a guess.
    */
    const { uploadCertificate } = await import(
      "../../src/lib/documents/certificates"
    );
    const { derivedDocumentKey } = await import(
      "../../src/lib/storage/documents"
    );
    const orphan = await uploadCertificate({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      blobKey: derivedDocumentKey(`${fixture.jobId}:attempt-1`),
    });
    assert.ok(orphan.ok);
    await claimLeftBehind("attempt-1");

    const retried = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "attempt-1",
    });

    assert.ok(retried.ok);
    assert.equal(
      retried.documentId,
      orphan.documentId,
      "the retry got back the document the dead attempt stored",
    );
    assert.equal(
      await countRows("document", "where blob_key not like 'fixture/%'"),
      1,
      "no second copy was stored",
    );

    /*
      `replayed` is not asserted here, and deliberately. The recovery runs
      through `uploadCertificate`, whose unique index returns the first row —
      so the draft itself never learned this was a second attempt and reports
      the conservative answer. Claiming "already submitted" when it might not
      have been would be the dangerous direction; this is the safe one.
    */
  });

  test("a genuinely in-flight attempt is still not stomped on", async () => {
    /*
      The recovery above must not become a way to bypass the claim. A claim
      taken seconds ago is a request that is probably still running, and the
      right answer there is to wait rather than to store a second document.
    */
    await saveComplete();
    await claimLeftBehind("attempt-1", 0);

    const second = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "attempt-1",
    });

    assert.equal(second.ok, false);
    assert.equal(
      await countRows("document", "where blob_key not like 'fixture/%'"),
      0,
    );
  });
});

describe("the PDF and the draft are the same state", () => {
  test("a certificate drawn before an edit is refused against the draft after it", async () => {
    /*
      **What the server can check about a PDF, and what it cannot.** It checks
      the bytes are a PDF and that the stored draft is complete. It does not
      read the document, so it cannot know the figures printed on it are the
      figures in the draft — and nothing should claim it does.

      What it can establish is that the two refer to the same state. The
      client says which revision it drew; if the draft has moved since, the
      submission is refused rather than filing a PDF of the old readings
      against the new record.
    */
    const saved = await saveComplete();
    assert.ok(saved.ok);

    // The engineer changes a reading after the certificate was drawn.
    await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ app_1_highCO: "48" }),
      expectedRevision: saved.revision,
    });

    const stale = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "drawn-early",
      drawnFromRevision: saved.revision,
    });

    assert.equal(stale.ok, false);
    assert.ok(!stale.ok);
    assert.match(stale.error, /changed after the certificate was drawn/i);
    assert.equal(
      await countRows("document", "where blob_key not like 'fixture/%'"),
      0,
      "nothing was stored",
    );
  });

  test("drawn from the current revision goes through", async () => {
    const saved = await saveComplete();
    assert.ok(saved.ok);

    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "in-step",
      drawnFromRevision: saved.revision,
    });
    assert.ok(submitted.ok);
  });

  test("a client that says nothing is still accepted", async () => {
    /*
      Refusing every submission that omits the revision would break a tab that
      has not reloaded since the deploy — a worse failure than the one the
      check prevents, and one the engineer cannot diagnose.
    */
    await saveComplete();
    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "older-client",
    });
    assert.ok(submitted.ok);
  });
});

describe("editing a record that has already been sent", () => {
  test("the job stops saying it is submitted once there is newer work", async () => {
    /*
      The correction path: the engineer notices something after sending. The
      document already with the office is untouched — an administrator may
      still release it, and a correction goes through the existing versioning
      — but the job screen must not keep saying "submitted and waiting" over
      work nobody has seen.
    */
    await saveComplete();
    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "first",
    });
    assert.ok(submitted.ok);
    assert.notEqual(
      (await draftSummaryFor(engineer(), fixture.jobId))?.submittedAt,
      null,
    );

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ comments: "Corrected the model number." }),
      expectedRevision: loaded.draft.revision,
    });

    assert.equal(
      (await draftSummaryFor(engineer(), fixture.jobId))?.submittedAt,
      null,
      "there is unsent work again",
    );

    /* And the document already sent is untouched. */
    const { listPendingDocuments } = await import(
      "../../src/lib/documents/certificates"
    );
    assert.ok(
      (await listPendingDocuments(fixture.jobId)).some(
        (doc) => doc.id === submitted.documentId,
      ),
    );
  });
});

describe("an administrator can clear a submission nobody can finish", () => {
  test("a stalled claim is listed, and releasing it lets the engineer resend", async () => {
    await saveComplete();
    await conn.client.query(
      `update certificate_draft
          set submission_key = 'abandoned',
              submission_started_at = now() - interval '30 minutes'
        where job_id = $1`,
      [fixture.jobId],
    );

    const { listStalledSubmissions, releaseStalledSubmission } = await import(
      "../../src/lib/documents/certificate-drafts"
    );

    const stalled = await listStalledSubmissions();
    assert.equal(stalled?.length, 1);
    assert.equal(stalled?.[0].reference, fixture.jobReference);

    const released = await releaseStalledSubmission({
      session: admin(),
      jobId: fixture.jobId,
    });
    assert.equal(released.ok, true);

    assert.deepEqual(await listStalledSubmissions(), []);

    /* Nothing was destroyed, and the engineer can send again. */
    const resent = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "fresh-attempt",
    });
    assert.ok(resent.ok);
  });

  test("an engineer cannot release one — it is an administrator's action", async () => {
    await saveComplete();
    await conn.client.query(
      `update certificate_draft set submission_key = 'abandoned',
              submission_started_at = now() - interval '30 minutes'
        where job_id = $1`,
      [fixture.jobId],
    );

    const { releaseStalledSubmission } = await import(
      "../../src/lib/documents/certificate-drafts"
    );
    const refused = await releaseStalledSubmission({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.equal(refused.ok, false);
  });

  test("a completed submission is not offered as stalled", async () => {
    await saveComplete();
    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "done",
    });
    assert.ok(submitted.ok);

    await conn.client.query(
      `update certificate_draft
          set submission_started_at = now() - interval '30 minutes'
        where job_id = $1`,
      [fixture.jobId],
    );

    const { listStalledSubmissions, releaseStalledSubmission } = await import(
      "../../src/lib/documents/certificate-drafts"
    );
    assert.deepEqual(
      await listStalledSubmissions(),
      [],
      "it produced a document, so it is done rather than stalled",
    );
    const refused = await releaseStalledSubmission({
      session: admin(),
      jobId: fixture.jobId,
    });
    assert.equal(refused.ok, false);
  });
});
