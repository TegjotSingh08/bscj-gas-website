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
import {
  releaseCertificate,
  updateRenewalFromCertificate,
} from "../../src/lib/documents/certificates";
import {
  listOutstandingRenewals,
  renewalIsOutstanding,
} from "../../src/lib/compliance/outstanding";

/**
 * Releasing a certificate moves the renewal it proves — against a real
 * database.
 *
 * This replaces a service-level test that drove the same path with a
 * hand-rolled Drizzle fake. The fake could only ever confirm what the
 * application asked for; it could not confirm that the write landed, that the
 * partial unique index held, or that a rolled-back batch left nothing behind.
 * Those are the properties worth having, so they are asserted here instead.
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

function admin() {
  return {
    user: {
      id: fixture.adminUserId,
      email: "admin@fixture.example.invalid",
      role: "admin",
    },
    scope: { kind: "all" as const },
  };
}

const DETAILS = {
  certificateNumber: "TEST-0001",
  inspectionDate: "2026-09-20",
  nextDueDate: "2027-09-19",
  correctionReason: "",
};

async function release(
  overrides: Partial<typeof DETAILS> = {},
  documentIndex = 0,
) {
  return releaseCertificate({
    session: admin() as never,
    jobId: fixture.jobId,
    documentId: fixture.documentIds[documentIndex],
    details: { ...DETAILS, ...overrides },
    today: "2026-09-22",
  });
}

async function cycles(productId?: string) {
  const { rows } = await conn.client.query<{
    product_id: string;
    due_date: string;
    inspection_date: string | null;
    status: string;
    due_date_source: string;
    established_by_job_id: string | null;
    certificate_id: string | null;
  }>(
    `select product_id, due_date, inspection_date, status, due_date_source,
            established_by_job_id, certificate_id
       from compliance_cycle
      where property_id = $1 ${productId ? "and product_id = $2" : ""}
      order by created_at`,
    productId ? [fixture.propertyId, productId] : [fixture.propertyId],
  );
  return rows;
}

async function activities() {
  const { rows } = await conn.client.query<{ kind: string }>(
    `select kind from activity where property_id = $1 order by created_at`,
    [fixture.propertyId],
  );
  return rows.map((row) => row.kind);
}

/** Changes the job's product, so one fixture serves all three services. */
async function setJobProduct(productId: string) {
  await conn.client.query("update job set product_id = $1 where id = $2", [
    productId,
    fixture.jobId,
  ]);
}

describe("a first release", () => {
  test("establishes the position from the reviewed dates", async () => {
    const result = await release();
    assert.equal(result.ok, true);

    const [cycle] = await cycles();
    assert.equal(cycle.product_id, "cp12");
    // The dates an administrator read off the certificate, not a derived pair.
    assert.equal(cycle.inspection_date, "2026-09-20");
    assert.equal(cycle.due_date, "2027-09-19");
    assert.equal(cycle.status, "active");
    assert.equal(cycle.due_date_source, "manual");
    assert.equal(cycle.established_by_job_id, fixture.jobId);
    assert.ok(cycle.certificate_id);
  });

  test("does not derive the renewal from the inspection date", async () => {
    /*
      The rule would make this 2027-09-19. The point is that the value comes
      from the form: a certificate whose printed date differs keeps its printed
      date, because that is the document the customer is holding.
    */
    await release({ nextDueDate: "2027-06-30" });
    const [cycle] = await cycles();
    assert.equal(cycle.due_date, "2027-06-30");
  });

  test("is recorded in the property's history", async () => {
    await release();
    assert.ok((await activities()).includes("compliance.established"));
  });

  test("tells the administrator the renewal moved", async () => {
    const result = await release();
    assert.match(result.ok ? result.message : "", /renewal is now recorded/i);
  });
});

describe("which service a certificate moves", () => {
  test("a combined job moves the CP12 and nothing else", async () => {
    await setJobProduct("cp12-boiler-service");
    await release();

    const rows = await cycles();
    assert.deepEqual(
      rows.map((row) => row.product_id),
      ["cp12"],
    );
  });

  test("a boiler-service job records no compliance position at all", async () => {
    /*
      There is no certificate for a service. Recording a CP12 here would claim
      a gas safety check that was never part of the work.
    */
    await setJobProduct("boiler-service");
    const result = await release();

    assert.equal(result.ok, true);
    assert.deepEqual(await cycles(), []);
  });

  test("and that release still succeeds — the document is still a document", async () => {
    await setJobProduct("boiler-service");
    const result = await release();
    assert.match(result.ok ? result.message : "", /released/i);
  });
});

describe("an existing position", () => {
  /** A position established by some other, earlier job. */
  async function existingFrom(input: {
    inspectionDate: string | null;
    dueDate: string;
  }) {
    await conn.client.query(
      `insert into compliance_cycle
         (property_id, agent_organisation_id, product_id, inspection_date,
          due_date, due_date_source, status, established_by_job_id)
       values ($1, $2, 'cp12', $3, $4, 'manual', 'active', null)`,
      [
        fixture.propertyId,
        fixture.organisationId,
        input.inspectionDate,
        input.dueDate,
      ],
    );
  }

  test("an older one is superseded, and kept", async () => {
    await existingFrom({ inspectionDate: "2025-09-20", dueDate: "2026-09-19" });
    await release();

    const rows = await cycles();
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.status === "active").length, 1);
    assert.equal(rows.find((row) => row.status === "active")?.due_date, "2027-09-19");
    assert.equal(rows.find((row) => row.status === "superseded")?.due_date, "2026-09-19");
  });

  test("a newer one is kept, and the release says so", async () => {
    await existingFrom({ inspectionDate: "2027-02-01", dueDate: "2028-01-31" });
    const result = await release();

    const rows = await cycles();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].due_date, "2028-01-31");
    assert.match(result.ok ? result.message : "", /left as it is/i);
    assert.match(result.ok ? result.message : "", /2028-01-31/);
  });

  test("keeping a newer position is recorded, not silent", async () => {
    await existingFrom({ inspectionDate: "2027-02-01", dueDate: "2028-01-31" });
    await release();
    assert.ok((await activities()).includes("compliance.position_kept"));
  });

  test("an imported position with no inspection date is compared on the due date", async () => {
    await existingFrom({ inspectionDate: null, dueDate: "2026-12-31" });
    await release();

    const active = (await cycles()).find((row) => row.status === "active");
    assert.equal(active?.due_date, "2027-09-19");
  });
});

describe("a correction", () => {
  test("is refused without a reason, before anything is written", async () => {
    await release();
    const result = await release({ correctionReason: "" }, 1);

    assert.equal(result.ok, false);
    // Still exactly the first position, and exactly one certificate.
    assert.equal((await cycles()).length, 1);
  });

  test("supersedes the certificate and moves the renewal with it", async () => {
    await release();
    const result = await release(
      { certificateNumber: "TEST-0002", nextDueDate: "2027-08-31", correctionReason: "Mistyped." },
      1,
    );

    assert.equal(result.ok, true);
    const active = (await cycles()).find((row) => row.status === "active");
    assert.equal(active?.due_date, "2027-08-31");

    const { rows } = await conn.client.query<{ status: string; version: number }>(
      "select status, version from certificate order by version",
    );
    assert.deepEqual(rows, [
      { status: "superseded", version: 1 },
      { status: "issued", version: 2 },
    ]);
  });

  test("leaves exactly one active position, enforced by the index", async () => {
    await release();
    await release(
      { certificateNumber: "TEST-0002", nextDueDate: "2027-08-31", correctionReason: "Mistyped." },
      1,
    );

    const { rows } = await conn.client.query<{ n: string }>(
      `select count(*)::text as n from compliance_cycle
        where property_id = $1 and product_id = 'cp12' and status = 'active'`,
      [fixture.propertyId],
    );
    assert.equal(rows[0].n, "1");
  });
});

describe("when the renewal write fails after the certificate is written", () => {
  /**
   * A real failure, injected in the disposable database only.
   *
   * The two writes cannot be one statement — the cycle must point at the
   * certificate's id, which does not exist until the certificate is inserted —
   * so this state is genuinely reachable and is worth proving rather than
   * describing. The trigger is dropped again immediately.
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

  test("the certificate is still released, and the state is reported", async () => {
    const result = await withComplianceWritesFailing(() => release());

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.complianceOutstanding, true);
    assert.match(result.ok ? result.message : "", /has not moved/i);

    // The certificate exists; the renewal did not move. That is the state.
    const { rows } = await conn.client.query<{ n: string }>(
      "select count(*)::text as n from certificate",
    );
    assert.equal(rows[0].n, "1");
    assert.deepEqual(await cycles(), []);
  });

  test("the unresolved state is still there after a refresh", async () => {
    /*
      **The point of deriving it rather than remembering it.** The release told
      the administrator once, in a response. They refresh, or close the tab, or
      somebody else opens the job tomorrow — and without this the only record
      that anything was left undone is gone.
    */
    await withComplianceWritesFailing(() => release());

    const outstanding = await listOutstandingRenewals();
    assert.equal(outstanding?.length, 1);
    assert.equal(outstanding?.[0].jobReference, fixture.jobReference);
    assert.equal(outstanding?.[0].nextDueDate, "2027-09-19");

    const { rows } = await conn.client.query<{ id: string }>(
      "select id from certificate where status = 'issued'",
    );
    assert.equal(await renewalIsOutstanding(rows[0].id), "outstanding");
  });

  test("and it clears itself once the renewal lands", async () => {
    await withComplianceWritesFailing(() => release());
    const { rows } = await conn.client.query<{ id: string }>(
      "select id from certificate where status = 'issued'",
    );

    await updateRenewalFromCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      certificateId: rows[0].id,
    });

    assert.deepEqual(await listOutstandingRenewals(), []);
    assert.equal(await renewalIsOutstanding(rows[0].id), "resolved");
  });

  test("an ordinary release is never reported as outstanding", async () => {
    await release();
    assert.deepEqual(await listOutstandingRenewals(), []);
  });

  test("a boiler-service release is not outstanding — it is supposed to move nothing", async () => {
    /*
      Without excluding these, every boiler service ever released would sit on
      the reconciliation page for ever, which is the opposite of the truth and
      would quickly teach everyone to ignore the list.
    */
    await setJobProduct("boiler-service");
    await release();
    assert.deepEqual(await listOutstandingRenewals(), []);
  });

  test("a superseded version is not outstanding — its correction holds the position", async () => {
    await release();
    await release(
      { certificateNumber: "TEST-0002", nextDueDate: "2027-08-31", correctionReason: "Mistyped." },
      1,
    );

    const { rows } = await conn.client.query<{ id: string }>(
      "select id from certificate where status = 'superseded'",
    );
    assert.equal(await renewalIsOutstanding(rows[0].id), "resolved");
    assert.deepEqual(await listOutstandingRenewals(), []);
  });

  test("and the retry clears it afterwards", async () => {
    await withComplianceWritesFailing(() => release());

    const { rows } = await conn.client.query<{ id: string }>(
      "select id from certificate where status = 'issued'",
    );
    const retried = await updateRenewalFromCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      certificateId: rows[0].id,
    });

    assert.equal(retried.ok, true);
    const [cycle] = await cycles();
    assert.equal(cycle.due_date, "2027-09-19");
    assert.equal(cycle.certificate_id, rows[0].id);
  });

  test("the retry is safe to press when nothing is wrong", async () => {
    await release();
    const { rows } = await conn.client.query<{ id: string }>(
      "select id from certificate where status = 'issued'",
    );

    const again = await updateRenewalFromCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      certificateId: rows[0].id,
    });

    assert.equal(again.ok, true);
    assert.equal((await cycles()).length, 1);
  });

  test("the retry refuses a superseded version, so a renewal cannot walk backwards", async () => {
    await release();
    await release(
      { certificateNumber: "TEST-0002", nextDueDate: "2027-08-31", correctionReason: "Mistyped." },
      1,
    );

    const { rows } = await conn.client.query<{ id: string }>(
      "select id from certificate where status = 'superseded'",
    );
    const result = await updateRenewalFromCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      certificateId: rows[0].id,
    });

    assert.equal(result.ok, false);
    const active = (await cycles()).find((row) => row.status === "active");
    assert.equal(active?.due_date, "2027-08-31");
  });
});

describe("who may do it", () => {
  const as = (role: string, scope: unknown) => ({
    user: { id: fixture.agentUserId, email: "x@fixture.example.invalid", role },
    scope,
  });

  test("an agent cannot release a certificate", async () => {
    await assert.rejects(() =>
      releaseCertificate({
        session: as("agent_owner", {
          kind: "organisation",
          organisationId: fixture.organisationId,
        }) as never,
        jobId: fixture.jobId,
        documentId: fixture.documentIds[0],
        details: DETAILS,
        today: "2026-09-22",
      }),
    );
    assert.deepEqual(await cycles(), []);
  });

  test("an engineer cannot release one either", async () => {
    /*
      An engineer *does* hold `certificate:issue` — they produce the document.
      What stops them is the scope: releasing is BSCJ's.
    */
    const result = await releaseCertificate({
      session: as("engineer", {
        kind: "assigned",
        userId: fixture.engineerUserId,
      }) as never,
      jobId: fixture.jobId,
      documentId: fixture.documentIds[0],
      details: DETAILS,
      today: "2026-09-22",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(await cycles(), []);
  });

  test("an engineer cannot move a renewal", async () => {
    await release();
    const { rows } = await conn.client.query<{ id: string }>(
      "select id from certificate limit 1",
    );

    const result = await updateRenewalFromCertificate({
      session: as("engineer", {
        kind: "assigned",
        userId: fixture.engineerUserId,
      }) as never,
      jobId: fixture.jobId,
      certificateId: rows[0].id,
    });

    assert.equal(result.ok, false);
  });
});
