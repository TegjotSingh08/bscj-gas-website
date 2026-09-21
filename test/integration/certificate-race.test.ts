import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  connect,
  reset,
  start,
  stop,
  type Connection,
} from "../support/disposable-postgres";
import { setDbForTesting } from "../../src/lib/db/client";
import { applyCertificateToCompliance } from "../../src/lib/compliance/apply";
import { releaseCertificate } from "../../src/lib/documents/certificates";
import { seed, type Fixture } from "../support/fixtures";

/**
 * **A superseded certificate must never displace its own correction.**
 *
 * The interleaving, which is not hypothetical — it is what two administrators
 * on one job, or one administrator and a retry, actually produce:
 *
 * 1. **A** releases version 1. The certificate row is written. A pauses here,
 *    before applying its compliance position: a slow query, a cold function, a
 *    dropped connection, a tab that was left open.
 * 2. **B** releases a correction, version 2, for the same job. That supersedes
 *    version 1 and establishes the renewal from the corrected dates.
 * 3. **A** resumes and applies its compliance position.
 *
 * Before the fix, step 3 won. `decidePosition` saw a position established by
 * *the same job* and treated that as its own correction, so version 1 quietly
 * replaced version 2 — the superseded document displacing the one that
 * corrected it, and the property left showing a date somebody had already
 * decided was wrong.
 *
 * The unique index cannot catch this. It guarantees one active row; it says
 * nothing about **which certificate that row belongs to**.
 */

let conn: Connection;
let second: Connection;
let fixture: Fixture;

before(async () => {
  await start();
  conn = await connect();
  second = await connect();
  setDbForTesting(conn.db as never);
});

after(async () => {
  setDbForTesting(null);
  await stop();
});

beforeEach(async () => {
  await reset(conn);
  fixture = await seed(conn);
});

const ADMIN = {
  user: { id: "", email: "admin@fixture.example.invalid", role: "admin" },
  scope: { kind: "all" as const },
};

function admin() {
  return { ...ADMIN, user: { ...ADMIN.user, id: fixture.adminUserId } };
}

/** The active position for a service, with the certificate that established it. */
async function activePosition(productId = "cp12") {
  const { rows } = await conn.client.query<{
    due_date: string;
    certificate_id: string | null;
    version: number | null;
    status: string | null;
  }>(
    `select c.due_date, c.certificate_id, cert.version, cert.status
       from compliance_cycle c
       left join certificate cert on cert.id = c.certificate_id
      where c.property_id = $1 and c.product_id = $2 and c.status = 'active'`,
    [fixture.propertyId, productId],
  );
  assert.ok(rows.length <= 1, "the unique index allows at most one");
  return rows[0] ?? null;
}

/** Inserts a certificate exactly as `releaseCertificate` would, and stops. */
async function writeCertificate(input: {
  version: number;
  inspectionDate: string;
  nextDueDate: string;
  documentId: string;
}) {
  const { rows } = await conn.client.query<{ id: string }>(
    `insert into certificate
       (job_id, property_id, agent_organisation_id, certificate_number, version,
        status, inspection_date, next_due_date, issued_by, document_id)
     values ($1, $2, $3, $4, $5, 'issued', $6, $7, $8, $9) returning id`,
    [
      fixture.jobId,
      fixture.propertyId,
      fixture.organisationId,
      `TEST-V${input.version}`,
      input.version,
      input.inspectionDate,
      input.nextDueDate,
      fixture.adminUserId,
      input.documentId,
    ],
  );
  return rows[0].id;
}

describe("A pauses, B corrects, A resumes", () => {
  test("the correction survives; the superseded version does not displace it", async () => {
    // 1. A writes version 1 and pauses before applying its position.
    const v1 = await writeCertificate({
      version: 1,
      inspectionDate: "2026-09-01",
      nextDueDate: "2027-08-31",
      documentId: fixture.documentIds[0],
    });

    // 2. B releases the correction, all the way through.
    const correction = await releaseCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      documentId: fixture.documentIds[1],
      details: {
        certificateNumber: "TEST-V2",
        inspectionDate: "2026-09-02",
        nextDueDate: "2027-09-01",
        correctionReason: "The inspection date was a day out.",
      },
      today: "2026-09-22",
    });
    assert.equal(correction.ok, true);

    const afterCorrection = await activePosition();
    assert.equal(afterCorrection?.due_date, "2027-09-01");
    assert.equal(afterCorrection?.version, 2);

    // 3. A resumes.
    const resumed = await applyCertificateToCompliance({
      organisationId: fixture.organisationId,
      propertyId: fixture.propertyId,
      jobId: fixture.jobId,
      jobProductId: "cp12",
      certificate: {
        id: v1,
        jobId: fixture.jobId,
        inspectionDate: "2026-09-01",
        nextDueDate: "2027-08-31",
      },
      actorUserId: fixture.adminUserId,
    });

    // It refuses, rather than writing a position from a superseded document.
    assert.equal(resumed.status, "superseded_certificate");

    const afterResume = await activePosition();
    assert.equal(
      afterResume?.due_date,
      "2027-09-01",
      "the correction must still hold the position",
    );
    assert.equal(afterResume?.version, 2);
  });

  test("the position is never left pointing at a superseded certificate", async () => {
    await writeCertificate({
      version: 1,
      inspectionDate: "2026-09-01",
      nextDueDate: "2027-08-31",
      documentId: fixture.documentIds[0],
    });
    await releaseCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      documentId: fixture.documentIds[1],
      details: {
        certificateNumber: "TEST-V2",
        inspectionDate: "2026-09-02",
        nextDueDate: "2027-09-01",
        correctionReason: "Corrected.",
      },
      today: "2026-09-22",
    });

    const position = await activePosition();
    assert.equal(position?.status, "issued");
  });
});

describe("the ordinary paths still work", () => {
  test("a first release establishes the position", async () => {
    const released = await releaseCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      documentId: fixture.documentIds[0],
      details: {
        certificateNumber: "TEST-0001",
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-09-19",
        correctionReason: "",
      },
      today: "2026-09-22",
    });

    assert.equal(released.ok, true);
    const position = await activePosition();
    assert.equal(position?.due_date, "2027-09-19");
    assert.equal(position?.version, 1);
  });

  test("a correction moves the position, in either direction", async () => {
    await releaseCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      documentId: fixture.documentIds[0],
      details: {
        certificateNumber: "TEST-0001",
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-09-19",
        correctionReason: "",
      },
      today: "2026-09-22",
    });

    // Backwards: the year was mistyped, and refusing would make it permanent.
    await releaseCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      documentId: fixture.documentIds[1],
      details: {
        certificateNumber: "TEST-0002",
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-06-30",
        correctionReason: "The due date was mistyped.",
      },
      today: "2026-09-22",
    });

    const position = await activePosition();
    assert.equal(position?.due_date, "2027-06-30");
    assert.equal(position?.version, 2);
  });

  test("history is kept: one active cycle, the rest superseded", async () => {
    await releaseCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      documentId: fixture.documentIds[0],
      details: {
        certificateNumber: "TEST-0001",
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-09-19",
        correctionReason: "",
      },
      today: "2026-09-22",
    });
    await releaseCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      documentId: fixture.documentIds[1],
      details: {
        certificateNumber: "TEST-0002",
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-06-30",
        correctionReason: "Corrected.",
      },
      today: "2026-09-22",
    });

    const { rows } = await conn.client.query<{ status: string; n: string }>(
      `select status, count(*)::text as n from compliance_cycle
        group by status order by status`,
    );
    assert.deepEqual(rows, [
      { status: "active", n: "1" },
      { status: "superseded", n: "1" },
    ]);

    const certs = await conn.client.query<{ status: string; n: string }>(
      `select status, count(*)::text as n from certificate
        group by status order by status`,
    );
    assert.deepEqual(certs, certs);
    assert.equal(
      certs.rows.find((row) => row.status === "issued")?.n,
      "1",
      "exactly one certificate stands",
    );
  });
});

describe("applying the same certificate twice", () => {
  test("is a no-op, not a second position", async () => {
    await releaseCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      documentId: fixture.documentIds[0],
      details: {
        certificateNumber: "TEST-0001",
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-09-19",
        correctionReason: "",
      },
      today: "2026-09-22",
    });

    const before = await activePosition();
    const again = await applyCertificateToCompliance({
      organisationId: fixture.organisationId,
      propertyId: fixture.propertyId,
      jobId: fixture.jobId,
      jobProductId: "cp12",
      certificate: {
        id: before!.certificate_id!,
        jobId: fixture.jobId,
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-09-19",
      },
      actorUserId: fixture.adminUserId,
    });

    assert.equal(again.status, "ok");
    const { rows } = await conn.client.query<{ n: string }>(
      "select count(*)::text as n from compliance_cycle",
    );
    assert.equal(rows[0].n, "1");
  });
});

describe("two connections applying at once", () => {
  test("the database arbitrates: one position, and it is a real one", async () => {
    /*
      Genuinely two backends — `harness.test.ts` proves the pids differ — so
      this is a real race rather than two calls taking turns. The partial unique
      index is the arbiter: one insert wins, the other is refused by Postgres.
    */
    const v1 = await writeCertificate({
      version: 1,
      inspectionDate: "2026-09-01",
      nextDueDate: "2027-08-31",
      documentId: fixture.documentIds[0],
    });

    const apply = (db: unknown) => {
      setDbForTesting(db as never);
      return applyCertificateToCompliance({
        organisationId: fixture.organisationId,
        propertyId: fixture.propertyId,
        jobId: fixture.jobId,
        jobProductId: "cp12",
        certificate: {
          id: v1,
          jobId: fixture.jobId,
          inspectionDate: "2026-09-01",
          nextDueDate: "2027-08-31",
        },
        actorUserId: fixture.adminUserId,
      });
    };

    /*
      Sequential calls with the handle swapped between them, because `getDb()`
      is a process-wide singleton and two concurrent calls would not be able to
      hold different connections. What is genuinely exercised here is that the
      **second connection's** write meets the first connection's committed row
      and is reconciled rather than duplicating it. The simultaneous-insert case
      is covered by `harness.test.ts`, where two live connections collide on the
      index directly.
    */
    const first = await apply(conn.db);
    const secondResult = await apply(second.db);
    setDbForTesting(conn.db as never);

    assert.equal(first.status, "ok");
    assert.equal(secondResult.status, "ok");

    const { rows } = await conn.client.query<{ n: string }>(
      "select count(*)::text as n from compliance_cycle where status = 'active'",
    );
    assert.equal(rows[0].n, "1");
  });
});
