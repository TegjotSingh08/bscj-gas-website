import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  certifiedProductsFor,
  decidePosition,
  describeDecision,
  type ActivePosition,
  type GoverningCertificate,
} from "./position";

/**
 * Which renewal a released certificate moves, and when it declines to.
 *
 * The rule under all of these: a certificate proves the service it is a
 * certificate for, and newer evidence is never quietly overwritten by older.
 */

const CERT: GoverningCertificate = {
  id: "cert-new",
  jobId: "job-2",
  inspectionDate: "2026-09-20",
  nextDueDate: "2027-09-19",
  version: 2,
};

const active = (overrides: Partial<ActivePosition> = {}): ActivePosition => ({
  id: "cycle-1",
  inspectionDate: "2025-09-20",
  dueDate: "2026-09-19",
  establishedByJobId: "job-1",
  certificateId: "cert-old",
  certificateVersion: 1,
  ...overrides,
});

describe("which services a certificate evidences", () => {
  test("a CP12 job establishes the CP12 position", () => {
    assert.deepEqual(certifiedProductsFor("cp12"), ["cp12"]);
  });

  test("a combined job establishes the CP12 position, and only that", () => {
    /*
      The boiler really was serviced on the same visit, and **no certificate
      attests to it**. Recording a twelve-month service position from this
      document would invent a compliance claim out of an appointment.
    */
    assert.deepEqual(certifiedProductsFor("cp12-boiler-service"), ["cp12"]);
  });

  test("a boiler-service job establishes nothing", () => {
    // There is no certificate for a service. A document released against one
    // of these must not create a CP12 for a check nobody carried out.
    assert.deepEqual(certifiedProductsFor("boiler-service"), []);
  });

  test("an unrecognised product establishes nothing rather than defaulting", () => {
    assert.deepEqual(certifiedProductsFor("something-else"), []);
  });
});

describe("a property with no position yet", () => {
  test("the certificate establishes one", () => {
    assert.deepEqual(decidePosition(null, CERT), { kind: "establish" });
  });
});

describe("a property whose position is older", () => {
  test("a newer inspection supersedes it", () => {
    assert.deepEqual(decidePosition(active(), CERT), {
      kind: "supersede",
      supersedes: "cycle-1",
    });
  });

  test("an imported position, which has no inspection date, is compared on the due date", () => {
    const imported = active({
      inspectionDate: null,
      certificateId: null,
      certificateVersion: null,
      establishedByJobId: null,
    });
    assert.deepEqual(decidePosition(imported, CERT), {
      kind: "supersede",
      supersedes: "cycle-1",
    });
  });

  test("an imported position that already runs longer is kept", () => {
    const imported = active({
      inspectionDate: null,
      dueDate: "2028-01-01",
      certificateId: null,
      certificateVersion: null,
      establishedByJobId: null,
    });
    assert.deepEqual(decidePosition(imported, CERT), {
      kind: "keep_newer",
      heldDueDate: "2028-01-01",
    });
  });
});

describe("a property whose position is newer", () => {
  test("releasing an older job's certificate does not walk the renewal backwards", () => {
    /*
      Last year's job, released late — or corrected — after this year's visit
      already established the position. The current record is right and must
      not be replaced by the older document.
    */
    const newer = active({
      inspectionDate: "2027-01-10",
      dueDate: "2028-01-09",
      establishedByJobId: "job-3",
      certificateId: "cert-newer",
      certificateVersion: 1,
    });

    assert.deepEqual(decidePosition(newer, CERT), {
      kind: "keep_newer",
      heldDueDate: "2028-01-09",
    });
  });

  test("an inspection on the same day as the one held does not displace it", () => {
    const sameDay = active({ inspectionDate: CERT.inspectionDate, establishedByJobId: "job-9" });
    assert.equal(decidePosition(sameDay, CERT).kind, "keep_newer");
  });

  test("the caller is told plainly, with the date that was kept", () => {
    const newer = active({ inspectionDate: "2027-01-10", dueDate: "2028-01-09" });
    const message = describeDecision(decidePosition(newer, CERT), "CP12") ?? "";

    assert.match(message, /left as it is/i);
    assert.match(message, /2028-01-09/);
    assert.match(message, /nothing was overwritten/i);
  });
});

describe("corrections", () => {
  test("correcting the certificate that established the position replaces it", () => {
    const ours = active({
      establishedByJobId: CERT.jobId,
      certificateId: "cert-v1",
      certificateVersion: 1,
    });
    assert.deepEqual(decidePosition(ours, CERT), {
      kind: "supersede",
      supersedes: "cycle-1",
    });
  });

  test("a correction may move a date backwards — that is what correcting a typo is", () => {
    /*
      The mistyped date was 2037. Refusing to let it come back would make the
      typo permanent, which is the opposite of what a correction is for.
    */
    const mistyped = active({
      establishedByJobId: CERT.jobId,
      certificateVersion: 1,
      inspectionDate: "2036-09-20",
      dueDate: "2037-09-19",
    });
    assert.equal(decidePosition(mistyped, CERT).kind, "supersede");
  });
});

describe("a certificate that has been corrected since", () => {
  test("version 1 arriving late does not displace version 2", () => {
    /*
      **The race.** A releases v1 and pauses before applying its position; B
      releases the correction, v2, and applies it; A resumes. "The same job
      established this" was the whole of the same-job test, so v1 looked exactly
      like v2 correcting v1 — and the superseded document displaced the one that
      corrected it.
    */
    const heldByCorrection = active({
      establishedByJobId: CERT.jobId,
      certificateId: "cert-v2",
      certificateVersion: 2,
    });
    const late = { ...CERT, id: "cert-v1", version: 1 };

    assert.deepEqual(decidePosition(heldByCorrection, late), {
      kind: "superseded_by_correction",
      heldVersion: 2,
    });
  });

  test("and is told so in a sentence that names the version", () => {
    const heldByCorrection = active({
      establishedByJobId: CERT.jobId,
      certificateVersion: 3,
    });
    const message =
      describeDecision(
        decidePosition(heldByCorrection, { ...CERT, version: 1 }),
        "CP12",
      ) ?? "";

    assert.match(message, /version 3/);
    assert.match(message, /nothing was overwritten/i);
  });

  test("an equal version still supersedes — that is a retry, not a regression", () => {
    const ours = active({
      establishedByJobId: CERT.jobId,
      certificateId: "cert-other",
      certificateVersion: CERT.version,
    });
    assert.equal(decidePosition(ours, CERT).kind, "supersede");
  });

  test("a position with no certificate at all is still correctable", () => {
    // Imported, then a certificate released against the same job.
    const imported = active({
      establishedByJobId: CERT.jobId,
      certificateId: null,
      certificateVersion: null,
    });
    assert.equal(decidePosition(imported, CERT).kind, "supersede");
  });
});

describe("repeated and concurrent submissions", () => {
  test("a position already established from this certificate is left alone", () => {
    const ours = active({
      certificateId: CERT.id,
      establishedByJobId: CERT.jobId,
      certificateVersion: CERT.version,
    });
    assert.deepEqual(decidePosition(ours, CERT), { kind: "already_current" });
  });

  test("so retrying after a partial failure is a no-op rather than a second cycle", () => {
    const ours = active({ certificateId: CERT.id, certificateVersion: CERT.version });
    const first = decidePosition(ours, CERT);
    const second = decidePosition(ours, CERT);
    assert.deepEqual(first, second);
    assert.equal(first.kind, "already_current");
    assert.equal(describeDecision(first, "CP12"), null);
  });
});
