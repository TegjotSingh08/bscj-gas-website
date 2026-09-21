import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  certifiedProductsFor,
  decidePosition,
  describeDecision,
  type ActivePosition,
  type ReleasedCertificate,
} from "./position";

/**
 * Which renewal a released certificate moves, and when it declines to.
 *
 * The rule under all of these: a certificate proves the service it is a
 * certificate for, and newer evidence is never quietly overwritten by older.
 */

const CERT: ReleasedCertificate = {
  id: "cert-new",
  jobId: "job-2",
  inspectionDate: "2026-09-20",
  nextDueDate: "2027-09-19",
};

const active = (overrides: Partial<ActivePosition> = {}): ActivePosition => ({
  id: "cycle-1",
  inspectionDate: "2025-09-20",
  dueDate: "2026-09-19",
  establishedByJobId: "job-1",
  certificateId: "cert-old",
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
    const imported = active({ inspectionDate: null, certificateId: null, establishedByJobId: null });
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
    const ours = active({ establishedByJobId: CERT.jobId, certificateId: "cert-v1" });
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
      inspectionDate: "2036-09-20",
      dueDate: "2037-09-19",
    });
    assert.equal(decidePosition(mistyped, CERT).kind, "supersede");
  });
});

describe("repeated and concurrent submissions", () => {
  test("a position already established from this certificate is left alone", () => {
    const ours = active({ certificateId: CERT.id, establishedByJobId: CERT.jobId });
    assert.deepEqual(decidePosition(ours, CERT), { kind: "already_current" });
  });

  test("so retrying after a partial failure is a no-op rather than a second cycle", () => {
    const ours = active({ certificateId: CERT.id });
    const first = decidePosition(ours, CERT);
    const second = decidePosition(ours, CERT);
    assert.deepEqual(first, second);
    assert.equal(first.kind, "already_current");
    assert.equal(describeDecision(first, "CP12"), null);
  });
});
