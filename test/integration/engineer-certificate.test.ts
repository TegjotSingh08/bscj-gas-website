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
  signCertificateDraft,
  submitCertificateDraft,
  draftSummaryFor,
} from "../../src/lib/documents/certificate-drafts";
import type { SignatureRole } from "../../src/lib/documents/certificate-signatures";
import {
  OTHER_TEST_SIGNATURE_PNG,
  TEST_SIGNATURE_PNG,
} from "../support/signature";

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

/**
 * Signs the stored record as the engineer, at whatever revision it is on.
 *
 * Reads the revision rather than being told it, because that is what a
 * signature is for in these tests: the specific binding is exercised
 * deliberately in the signature suite, and everywhere else the point is
 * simply that a submittable record has been signed.
 */
async function signIssued(
  session = engineer(),
  role: SignatureRole = "issued",
  image: string = TEST_SIGNATURE_PNG,
): Promise<number> {
  const loaded = await loadCertificateDraft({ session, jobId: fixture.jobId });
  assert.ok(loaded.ok);
  const signed = await signCertificateDraft({
    session,
    jobId: fixture.jobId,
    role,
    dataUrl: image,
    expectedRevision: loaded.draft.revision,
  });
  assert.ok(signed.ok, "the fixture record could not be signed");
  return signed.revision;
}

/** A finished record that has been signed — what a submission actually needs. */
async function saveCompleteSigned(session = engineer(), revision = 0) {
  const saved = await saveComplete(session, revision);
  assert.ok(saved.ok);
  return { ok: true as const, revision: await signIssued(session) };
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
    await saveCompleteSigned();

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
    await saveCompleteSigned();

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
    await saveCompleteSigned();
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
    await saveCompleteSigned();
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
    await saveCompleteSigned();

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
    await saveCompleteSigned();

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
    await saveCompleteSigned();
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

    /*
      The edit also took the signature off, because the record it was put
      against is not the record any more. So the second attempt needs the
      engineer to sign the corrected version — which is the point.
    */
    const unsigned = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "first-attempt",
    });
    assert.equal(unsigned.ok, false);
    assert.ok(!unsigned.ok);
    assert.deepEqual(unsigned.missing, ["Engineer signature"]);

    await signIssued();

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
    await saveCompleteSigned();

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
    await saveCompleteSigned();
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
    await saveCompleteSigned();
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
    await saveCompleteSigned();

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
    await saveCompleteSigned();
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
    const saved = await saveCompleteSigned();
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
    const saved = await saveCompleteSigned();
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
    await saveCompleteSigned();
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
    await saveCompleteSigned();
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
    await saveCompleteSigned();
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
    await saveCompleteSigned();
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

describe("a submitted certificate is findable, not just visible on its own job", () => {
  /*
    `countPendingReview` and the `certificate_review` job-list view existed
    only as dead code and an unwired filter until this pass — a submitted or
    uploaded certificate was previously visible **only** by opening each job
    in turn, which does not scale past a handful of jobs, and a launch with
    several agencies reaches a handful in a morning.
  */
  test("counts it across the whole board, and drops by one once released", async () => {
    /*
      The fixture already seeds two pending certificate documents on this
      same job as prior state, so the count before submitting is 2, not 0 —
      asserted explicitly, so the rest of the test is honest about what it is
      actually proving: one more submission raises it by one, and releasing
      that one submission lowers it by one, not to zero.
    */
    const { countPendingReview } = await import(
      "../../src/lib/documents/certificates"
    );
    const before = await countPendingReview();
    assert.equal(before, 2, "the fixture's own two pending documents");

    await saveCompleteSigned();
    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "for-dashboard",
    });
    assert.ok(submitted.ok);
    assert.equal(await countPendingReview(), before + 1);

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

    assert.equal(
      await countPendingReview(),
      before,
      "back to just the two that were never this submission",
    );
  });

  test("the job-list view finds it, and drops it after release", async () => {
    /*
      A fresh job, not `fixture.jobId` — that one already carries two pending
      documents as prior state, so releasing one submission against it would
      leave the job in the view anyway, for the entirely correct reason that
      the other two are still unreviewed. Isolating the one submission this
      test is about needs a job with nothing else pending on it.
    */
    const { rows: created } = await conn.client.query<{ id: string }>(
      `insert into job
         (reference, idempotency_key, agent_organisation_id, customer_id,
          billing_customer_id, property_id, product_id, source,
          scheduling_method, lifecycle_status, appliance_count,
          price_total_pence, customer_snapshot, property_snapshot,
          price_snapshot, assigned_engineer_id)
       values ('BSCJ-CERTLIST', 'BSCJ-CERTLIST', $1, $2, $2, $3, 'cp12', 'portal',
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
    const jobId = created[0].id;

    const saved = await saveCertificateDraft({
      session: engineer(),
      jobId,
      fields: completeFields(),
      expectedRevision: 0,
    });
    assert.ok(saved.ok);
    const signed = await signCertificateDraft({
      session: engineer(),
      jobId,
      role: "issued",
      dataUrl: TEST_SIGNATURE_PNG,
      expectedRevision: saved.revision,
    });
    assert.ok(signed.ok);
    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "for-list",
    });
    assert.ok(submitted.ok);

    const { listJobs } = await import("../../src/lib/jobs/queries");
    const { DEFAULT_FILTERS } = await import("../../src/lib/jobs/filters");
    const before = await listJobs(
      { kind: "all" },
      { ...DEFAULT_FILTERS, view: "certificate_review" },
    );
    assert.ok(before?.rows.some((row) => row.id === jobId));

    const { releaseCertificate } = await import(
      "../../src/lib/documents/certificates"
    );
    await releaseCertificate({
      session: admin(),
      jobId,
      documentId: submitted.documentId,
      details: {
        certificateNumber: "TEST-NOT-VALID-0002",
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-09-19",
        correctionReason: "",
      },
      today: "2026-09-22",
    });

    const after = await listJobs(
      { kind: "all" },
      { ...DEFAULT_FILTERS, view: "certificate_review" },
    );
    assert.equal(
      after?.rows.some((row) => row.id === jobId),
      false,
      "a released certificate is no longer awaiting review",
    );
  });
});

/* ==========================================================================
   Signatures
   --------------------------------------------------------------------------
   The certificate has always had two boxes and they have always printed
   empty. These are the rules that fill them: what a mark may be, what it is
   bound to, what removes it, and what a record may be submitted without.
   ========================================================================== */

describe("capturing a signature", () => {
  test("a mark is stored against the job and comes back from the server", async () => {
    const saved = await saveComplete();
    assert.ok(saved.ok);

    const signed = await signCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      role: "issued",
      dataUrl: TEST_SIGNATURE_PNG,
      expectedRevision: saved.revision,
    });
    assert.ok(signed.ok);
    assert.equal(signed.revision, saved.revision + 1, "signing changes the record");

    /*
      Reloaded from the database, which is the point: the engineer can close
      the tab, sign out, pick up a different device and the mark is still
      there. Nothing about it lives in a browser.
    */
    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.equal(loaded.draft.signatures.issued?.dataUrl, TEST_SIGNATURE_PNG);
    assert.equal(loaded.draft.signatures.issued?.capturedAtRevision, signed.revision);
    assert.equal(loaded.draft.signatures.received, undefined);
  });

  test("the two boxes are separate, and one is not the other", async () => {
    await saveComplete();
    await signIssued(engineer(), "issued", TEST_SIGNATURE_PNG);
    await signIssued(engineer(), "received", OTHER_TEST_SIGNATURE_PNG);

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.equal(loaded.draft.signatures.issued?.dataUrl, TEST_SIGNATURE_PNG);
    assert.equal(
      loaded.draft.signatures.received?.dataUrl,
      OTHER_TEST_SIGNATURE_PNG,
    );
  });

  test("a typed name never becomes a mark", async () => {
    /*
      Both print names are on this record and both are stored. Neither
      produces a signature, and there is no code path by which one could:
      the only writer of the column is `signCertificateDraft`, and it takes an
      image.
    */
    await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ receivedPrintName: "A Fixture Tenant" }),
      expectedRevision: 0,
    });

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.equal(loaded.draft.fields.issuedPrintName, "Fixture Engineer");
    assert.equal(loaded.draft.fields.receivedPrintName, "A Fixture Tenant");
    assert.deepEqual(loaded.draft.signatures, {}, "two names, no signature");
  });

  test("something that is not an image is refused and nothing is stored", async () => {
    const saved = await saveComplete();
    assert.ok(saved.ok);

    const attempt = await signCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      role: "issued",
      dataUrl: "Fixture Engineer",
      expectedRevision: saved.revision,
    });
    assert.equal(attempt.ok, false);

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.draft.signatures, {});
    assert.equal(loaded.draft.revision, saved.revision, "not even the revision moved");
  });

  test("signing before anything is saved is refused rather than inventing a draft", async () => {
    const attempt = await signCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      role: "issued",
      dataUrl: TEST_SIGNATURE_PNG,
      expectedRevision: 1,
    });
    assert.equal(attempt.ok, false);
    assert.ok(!attempt.ok);
    assert.match(attempt.error, /save this record/i);
  });

  test("signing a job that has not been visited is refused", async () => {
    await saveComplete();
    await conn.client.query(
      "update job set lifecycle_status = 'scheduled' where id = $1",
      [fixture.jobId],
    );

    const attempt = await signCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      role: "issued",
      dataUrl: TEST_SIGNATURE_PNG,
      expectedRevision: 1,
    });
    assert.equal(attempt.ok, false);
  });
});

describe("clearing and redrawing", () => {
  test("clearing empties the box and leaves the rest of the record alone", async () => {
    await saveComplete();
    const revision = await signIssued();

    const cleared = await signCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      role: "issued",
      dataUrl: null,
      expectedRevision: revision,
    });
    assert.ok(cleared.ok);

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.draft.signatures, {});
    assert.deepEqual(
      loaded.draft.fields,
      completeFields(),
      "the record itself is untouched",
    );
  });

  test("redrawing replaces the mark rather than keeping both", async () => {
    await saveComplete();
    await signIssued(engineer(), "issued", TEST_SIGNATURE_PNG);
    await signIssued(engineer(), "issued", OTHER_TEST_SIGNATURE_PNG);

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.equal(loaded.draft.signatures.issued?.dataUrl, OTHER_TEST_SIGNATURE_PNG);
  });

  test("clearing one box does not touch the other", async () => {
    await saveComplete();
    await signIssued(engineer(), "issued", TEST_SIGNATURE_PNG);
    const revision = await signIssued(engineer(), "received", OTHER_TEST_SIGNATURE_PNG);

    await signCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      role: "received",
      dataUrl: null,
      expectedRevision: revision,
    });

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.equal(loaded.draft.signatures.issued?.dataUrl, TEST_SIGNATURE_PNG);
    assert.equal(loaded.draft.signatures.received, undefined);
  });
});

describe("a mark is bound to the record it was put against", () => {
  test("a stale revision is refused, and carries what is actually stored", async () => {
    const saved = await saveComplete();
    assert.ok(saved.ok);

    // Another device saves in between.
    await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ comments: "From the tablet." }),
      expectedRevision: saved.revision,
    });

    const stale = await signCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      role: "issued",
      dataUrl: TEST_SIGNATURE_PNG,
      expectedRevision: saved.revision,
    });
    assert.equal(stale.ok, false);
    assert.ok(!stale.ok && stale.conflict);
    assert.equal(stale.draft.revision, saved.revision + 1);
    assert.deepEqual(stale.draft.signatures, {}, "nothing was signed");
  });

  test("editing the record afterwards takes the mark off, and names it", async () => {
    await saveComplete();
    const revision = await signIssued();

    const saved = await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ app_1_highCO: "48" }),
      expectedRevision: revision,
    });
    assert.ok(saved.ok);
    assert.deepEqual(saved.cleared, ["issued"]);
    assert.deepEqual(saved.signatures, {});

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.draft.signatures, {}, "not kept over the change");
  });

  test("saving the same record again keeps the mark", async () => {
    await saveComplete();
    const revision = await signIssued();

    const saved = await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields(),
      expectedRevision: revision,
    });
    assert.ok(saved.ok);
    assert.deepEqual(saved.cleared, []);
    assert.ok(saved.signatures.issued, "an autosave is not an edit");
  });

  test("adding the tenant's name keeps the engineer's mark and removes theirs", async () => {
    await saveComplete();
    await signIssued(engineer(), "issued", TEST_SIGNATURE_PNG);
    const revision = await signIssued(engineer(), "received", OTHER_TEST_SIGNATURE_PNG);

    const saved = await saveCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      fields: completeFields({ receivedPrintName: "A Fixture Tenant" }),
      expectedRevision: revision,
    });
    assert.ok(saved.ok);
    assert.deepEqual(saved.cleared, ["received"]);
    assert.ok(saved.signatures.issued);
  });

  test("a mark from one job never appears on another", async () => {
    await saveComplete();
    await signIssued();

    const { rows } = await conn.client.query<{ id: string }>(
      `insert into job
         (reference, idempotency_key, agent_organisation_id, customer_id,
          billing_customer_id, property_id, product_id, source,
          scheduling_method, lifecycle_status, appliance_count,
          price_total_pence, customer_snapshot, property_snapshot,
          price_snapshot, assigned_engineer_id)
       values ('BSCJ-SIGNEXT', 'BSCJ-SIGNEXT', $1, $2, $2, $3, 'cp12', 'portal',
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

    await saveCertificateDraft({
      session: engineer(),
      jobId: rows[0].id,
      fields: completeFields({ certNo: "TEST-NOT-VALID-0002" }),
      expectedRevision: 0,
    });

    const other = await loadCertificateDraft({
      session: engineer(),
      jobId: rows[0].id,
    });
    assert.ok(other.ok);
    assert.deepEqual(
      other.draft.signatures,
      {},
      "the next certificate starts unsigned, always",
    );
  });
});

describe("a signature is only the engineer's to give", () => {
  test("another engineer cannot sign this job's record", async () => {
    await saveComplete();

    const attempt = await signCertificateDraft({
      session: otherEngineer(),
      jobId: fixture.jobId,
      role: "issued",
      dataUrl: TEST_SIGNATURE_PNG,
      expectedRevision: 1,
    });
    assert.equal(attempt.ok, false);
    assert.ok(!attempt.ok);
    assert.match(attempt.error, /could not be found/i);

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.draft.signatures, {});
  });

  test("a job that does not exist reads the same as one that is not theirs", async () => {
    const missing = await signCertificateDraft({
      session: engineer(),
      jobId: "00000000-0000-4000-8000-000000000000",
      role: "issued",
      dataUrl: TEST_SIGNATURE_PNG,
      expectedRevision: 1,
    });
    const notMine = await signCertificateDraft({
      session: otherEngineer(),
      jobId: fixture.jobId,
      role: "issued",
      dataUrl: TEST_SIGNATURE_PNG,
      expectedRevision: 1,
    });
    assert.ok(!missing.ok && !notMine.ok);
    assert.equal(missing.error, notMine.error);
  });

  test("losing the job loses the ability to sign it", async () => {
    await saveComplete();
    await conn.client.query(
      "update job set assigned_engineer_id = $1 where id = $2",
      [fixture.otherEngineerUserId, fixture.jobId],
    );

    const attempt = await signCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      role: "issued",
      dataUrl: TEST_SIGNATURE_PNG,
      expectedRevision: 1,
    });
    assert.equal(attempt.ok, false);
  });
});

describe("what signing does and does not do", () => {
  test("it issues nothing, sends nothing and moves no date", async () => {
    await saveComplete();
    await signIssued();

    assert.equal(await countRows("certificate"), 0);
    assert.equal(await countRows("compliance_cycle"), 0);
    assert.equal(await countRows("outbound_email"), 0);
    assert.equal(
      await countRows("document", "where blob_key not like 'fixture/%'"),
      0,
      "signing is not submitting",
    );
  });

  test("an unsigned record cannot be submitted, whatever the browser does", async () => {
    await saveComplete();

    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "unsigned",
    });
    assert.equal(submitted.ok, false);
    assert.ok(!submitted.ok);
    assert.deepEqual(submitted.missing, ["Engineer signature"]);
    assert.equal(
      await countRows("document", "where blob_key not like 'fixture/%'"),
      0,
      "no PDF was stored for an unsigned record",
    );
  });

  test("nobody there to receive it does not stop the record being filed", async () => {
    /*
      The whole point of leaving the second box optional. This record has an
      engineer's mark and nothing in the *Received by* box, and it goes to the
      office as it stands — with the box empty and nothing claimed about it.
    */
    await saveComplete();
    await signIssued();

    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "nobody-home",
    });
    assert.ok(submitted.ok);

    const loaded = await loadCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
    });
    assert.ok(loaded.ok);
    assert.equal(
      loaded.draft.signatures.received,
      undefined,
      "absence is recorded as absence",
    );
  });

  test("signing ends a submission attempt in flight, and leaves its document alone", async () => {
    await saveComplete();
    const revision = await signIssued();

    const submitted = await submitCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      bytes: SPECIMEN,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "before-the-tenant-signed",
    });
    assert.ok(submitted.ok);

    /* The tenant appears after the record went. The engineer signs them in. */
    await signCertificateDraft({
      session: engineer(),
      jobId: fixture.jobId,
      role: "received",
      dataUrl: OTHER_TEST_SIGNATURE_PNG,
      expectedRevision: revision,
    });

    /*
      **The document already with the office is immutable.** It is still
      there, still awaiting review, still the same bytes — a later signature
      on the draft does not reach inside a submitted PDF, and correcting one
      goes through the office's own versioning as it always has.
    */
    const { rows } = await conn.client.query<{
      id: string;
      size_bytes: number;
      sent_at: string | null;
    }>("select id, size_bytes, sent_at from document where id = $1", [
      submitted.documentId,
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].size_bytes, SPECIMEN.byteLength);
    assert.equal(rows[0].sent_at, null);

    /* But the job no longer claims the draft is the thing that was sent. */
    const summary = await draftSummaryFor(engineer(), fixture.jobId);
    assert.deepEqual(summary, { exists: true, submittedAt: null });
  });
});
