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
import { seed, type Fixture } from "../support/fixtures";
import { releaseCertificate } from "../../src/lib/documents/certificates";
import {
  listOutstandingRenewals,
  renewalIsOutstanding,
} from "../../src/lib/compliance/outstanding";

/**
 * **What counts as a renewal that did not land.**
 *
 * The first version asked "is there an active cycle pointing at this
 * certificate", and reported everything else as an unresolved repair. That is
 * true of a genuine failure — and equally true of every certificate a later
 * visit has legitimately replaced, and of every one the position rules
 * correctly declined to apply. Both of those would have sat on the
 * reconciliation page for ever, advertising a repair no retry could clear,
 * until somebody learned to ignore the list.
 *
 * The question is not "does a cycle point at this" but **"would applying this
 * now actually change anything"** — which `decidePosition` already answers.
 */

let conn: Connection;
let fixture: Fixture;

before(async () => {
  await start();
  conn = await connect();
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

const admin = () => ({
  user: {
    id: fixture.adminUserId,
    email: "admin@fixture.example.invalid",
    role: "admin",
  },
  scope: { kind: "all" as const },
});

/** A second job on the same property — a later year's visit. */
async function secondJob(): Promise<{ jobId: string; documentId: string }> {
  const { rows } = await conn.client.query<{ id: string }>(
    `insert into job
       (reference, idempotency_key, agent_organisation_id, customer_id,
        billing_customer_id, property_id, product_id, source, scheduling_method,
        lifecycle_status, appliance_count, price_total_pence,
        customer_snapshot, property_snapshot, price_snapshot)
     values ('BSCJ-FIXT02', 'BSCJ-FIXT02', $1, $2, $2, $3, 'cp12', 'portal',
             'tenant_selected', 'in_progress', 1, 4500,
             '{"name":"Ada Fixture"}'::jsonb,
             '{"postcode":"WV1 1AA"}'::jsonb,
             '{"totalPence":4500}'::jsonb)
     returning id`,
    [fixture.organisationId, fixture.landlordId, fixture.propertyId],
  );
  const jobId = rows[0].id;

  const doc = await conn.client.query<{ id: string }>(
    `insert into document
       (job_id, agent_organisation_id, kind, filename, blob_key,
        content_type, size_bytes, uploaded_by)
     values ($1, $2, 'certificate', 'second.pdf', $3, 'application/pdf', 2731, $4)
     returning id`,
    [jobId, fixture.organisationId, `fixture/second-${jobId}`, fixture.adminUserId],
  );
  return { jobId, documentId: doc.rows[0].id };
}

async function release(input: {
  jobId: string;
  documentId: string;
  certificateNumber: string;
  inspectionDate: string;
  nextDueDate: string;
  correctionReason?: string;
}) {
  return releaseCertificate({
    session: admin() as never,
    jobId: input.jobId,
    documentId: input.documentId,
    details: {
      certificateNumber: input.certificateNumber,
      inspectionDate: input.inspectionDate,
      nextDueDate: input.nextDueDate,
      correctionReason: input.correctionReason ?? "",
    },
    today: "2027-01-01",
  });
}

async function certificateIdFor(jobId: string): Promise<string> {
  const { rows } = await conn.client.query<{ id: string }>(
    "select id from certificate where job_id = $1 order by version desc limit 1",
    [jobId],
  );
  return rows[0].id;
}

/**
 * A real failure of the compliance write, injected in the disposable database.
 *
 * The two writes cannot be one statement — the cycle must point at the
 * certificate's id, which does not exist until the certificate is inserted —
 * so this state is genuinely reachable.
 */
async function withComplianceWritesFailing<T>(body: () => Promise<T>): Promise<T> {
  await conn.client.query(`
    create or replace function bscj_refuse_cycle() returns trigger as $$
    begin raise exception 'injected failure'; end;
    $$ language plpgsql;
    create trigger bscj_refuse_cycle_trigger
      before insert on compliance_cycle
      for each row execute function bscj_refuse_cycle();
  `);
  try {
    return await body();
  } finally {
    await conn.client.query(
      "drop trigger if exists bscj_refuse_cycle_trigger on compliance_cycle",
    );
  }
}

describe("a certificate a later visit legitimately replaced", () => {
  test("is not an unresolved repair", async () => {
    /*
      **The false alert.** Job A establishes the position in 2026. Job B — this
      year's visit — legitimately supersedes it. A's certificate is still
      `issued`, because a different job's release does not supersede it, and no
      active cycle points at it any more. Under the old rule that was reported
      as a failed application, for ever.
    */
    await release({
      jobId: fixture.jobId,
      documentId: fixture.documentIds[0],
      certificateNumber: "TEST-A",
      inspectionDate: "2026-01-10",
      nextDueDate: "2027-01-09",
    });
    const certificateA = await certificateIdFor(fixture.jobId);

    const later = await secondJob();
    await release({
      jobId: later.jobId,
      documentId: later.documentId,
      certificateNumber: "TEST-B",
      inspectionDate: "2026-12-20",
      nextDueDate: "2027-12-19",
    });

    // The current position is B's.
    const { rows } = await conn.client.query<{ due_date: string }>(
      "select due_date from compliance_cycle where status = 'active'",
    );
    assert.deepEqual(rows, [{ due_date: "2027-12-19" }]);

    // A is history, not a repair.
    assert.equal(await renewalIsOutstanding(certificateA), "resolved");
    assert.deepEqual(await listOutstandingRenewals(), []);
  });

  test("and both certificates are kept", async () => {
    await release({
      jobId: fixture.jobId,
      documentId: fixture.documentIds[0],
      certificateNumber: "TEST-A",
      inspectionDate: "2026-01-10",
      nextDueDate: "2027-01-09",
    });
    const later = await secondJob();
    await release({
      jobId: later.jobId,
      documentId: later.documentId,
      certificateNumber: "TEST-B",
      inspectionDate: "2026-12-20",
      nextDueDate: "2027-12-19",
    });

    const { rows } = await conn.client.query<{ n: string }>(
      "select count(*)::text as n from certificate where status = 'issued'",
    );
    // Nothing was marked superseded to make an alert go away.
    assert.equal(rows[0].n, "2");
  });

  test("and the superseded cycle is kept as history", async () => {
    await release({
      jobId: fixture.jobId,
      documentId: fixture.documentIds[0],
      certificateNumber: "TEST-A",
      inspectionDate: "2026-01-10",
      nextDueDate: "2027-01-09",
    });
    const later = await secondJob();
    await release({
      jobId: later.jobId,
      documentId: later.documentId,
      certificateNumber: "TEST-B",
      inspectionDate: "2026-12-20",
      nextDueDate: "2027-12-19",
    });

    const { rows } = await conn.client.query<{ status: string; n: string }>(
      "select status, count(*)::text as n from compliance_cycle group by status order by status",
    );
    assert.deepEqual(rows, [
      { status: "active", n: "1" },
      { status: "superseded", n: "1" },
    ]);
  });
});

describe("a certificate the rules correctly declined to apply", () => {
  test("keep_newer is not an endless repair", async () => {
    /*
      An older job released late, after this year's visit already established
      the position. `applyCertificateToCompliance` correctly declines, and a
      retry would decline again — so advertising a repair would be advertising
      one that cannot be cleared.
    */
    const later = await secondJob();
    await release({
      jobId: later.jobId,
      documentId: later.documentId,
      certificateNumber: "TEST-B",
      inspectionDate: "2026-12-20",
      nextDueDate: "2027-12-19",
    });

    // Now the older job's certificate is released.
    const old = await release({
      jobId: fixture.jobId,
      documentId: fixture.documentIds[0],
      certificateNumber: "TEST-A",
      inspectionDate: "2026-01-10",
      nextDueDate: "2027-01-09",
    });
    assert.equal(old.ok, true);
    assert.match(old.ok ? old.message : "", /left as it is/i);

    const certificateA = await certificateIdFor(fixture.jobId);
    assert.equal(await renewalIsOutstanding(certificateA), "resolved");
    assert.deepEqual(await listOutstandingRenewals(), []);
  });

  test("a superseded version of our own job is not a repair either", async () => {
    await release({
      jobId: fixture.jobId,
      documentId: fixture.documentIds[0],
      certificateNumber: "TEST-V1",
      inspectionDate: "2026-09-20",
      nextDueDate: "2027-09-19",
    });
    await release({
      jobId: fixture.jobId,
      documentId: fixture.documentIds[1],
      certificateNumber: "TEST-V2",
      inspectionDate: "2026-09-20",
      nextDueDate: "2027-08-31",
      correctionReason: "Mistyped.",
    });

    const { rows } = await conn.client.query<{ id: string }>(
      "select id from certificate where status = 'superseded'",
    );
    assert.equal(await renewalIsOutstanding(rows[0].id), "resolved");
    assert.deepEqual(await listOutstandingRenewals(), []);
  });
});

describe("a genuine failure", () => {
  test("is discoverable, survives a refresh, and clears after recovery", async () => {
    await withComplianceWritesFailing(() =>
      release({
        jobId: fixture.jobId,
        documentId: fixture.documentIds[0],
        certificateNumber: "TEST-FAILED",
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-09-19",
      }),
    );

    const certificateId = await certificateIdFor(fixture.jobId);
    assert.equal(await renewalIsOutstanding(certificateId), "outstanding");

    const outstanding = await listOutstandingRenewals();
    assert.equal(outstanding?.length, 1);
    assert.equal(outstanding?.[0].jobReference, fixture.jobReference);

    // A second read — the state is derived, so it is still there.
    assert.equal(await renewalIsOutstanding(certificateId), "outstanding");

    const { updateRenewalFromCertificate } = await import(
      "../../src/lib/documents/certificates"
    );
    const retried = await updateRenewalFromCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      certificateId,
    });
    assert.equal(retried.ok, true);

    assert.equal(await renewalIsOutstanding(certificateId), "resolved");
    assert.deepEqual(await listOutstandingRenewals(), []);
  });

  test("a failure on a property that already has an older position is still a repair", async () => {
    /*
      The distinction that matters: this certificate *would* supersede what is
      there, and the write did not land. That is a real repair, and the retry
      can clear it — unlike the declined cases above.
    */
    await conn.client.query(
      `insert into compliance_cycle
         (property_id, agent_organisation_id, product_id, inspection_date,
          due_date, due_date_source, status)
       values ($1, $2, 'cp12', '2025-01-10', '2026-01-09', 'manual', 'active')`,
      [fixture.propertyId, fixture.organisationId],
    );

    await withComplianceWritesFailing(() =>
      release({
        jobId: fixture.jobId,
        documentId: fixture.documentIds[0],
        certificateNumber: "TEST-FAILED",
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-09-19",
      }),
    );

    const certificateId = await certificateIdFor(fixture.jobId);
    assert.equal(await renewalIsOutstanding(certificateId), "outstanding");
  });
});

describe("a boiler-service release", () => {
  test("is never a repair — it is supposed to move nothing", async () => {
    await conn.client.query("update job set product_id = 'boiler-service' where id = $1", [
      fixture.jobId,
    ]);
    await release({
      jobId: fixture.jobId,
      documentId: fixture.documentIds[0],
      certificateNumber: "TEST-SERVICE",
      inspectionDate: "2026-09-20",
      nextDueDate: "2027-09-19",
    });

    assert.deepEqual(await listOutstandingRenewals(), []);
  });
});

describe("when the database cannot be read", () => {
  test("it says so rather than reporting a confident 'no'", async () => {
    /*
      A read failure is not evidence of health. Returning `false` here told the
      job page there was nothing wrong, which is the one answer the page must
      not give when it does not know.
    */
    setDbForTesting(null);
    try {
      assert.equal(await renewalIsOutstanding("never-read"), "unavailable");
    } finally {
      setDbForTesting(conn.db as never);
    }
  });

  test("and the list reports unknown rather than empty", async () => {
    setDbForTesting(null);
    try {
      assert.equal(await listOutstandingRenewals(), null);
    } finally {
      setDbForTesting(conn.db as never);
    }
  });
});
