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
  type RenewalCursor,
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

/**
 * The outstanding rows, plus the traversal's own claim that it saw everything.
 *
 * Asserting on `rows` alone would pass just as happily against a walk that
 * gave up early, which is the defect this list has already had once. Every
 * "nothing outstanding" below therefore also asserts that the search reached
 * the end.
 */
async function outstandingRows() {
  const result = await listOutstandingRenewals();
  assert.notEqual(result, null, "the records were readable");
  assert.equal(result!.stoppedBecause, "exhausted", "the search reached the end");
  return result!.rows;
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
    assert.deepEqual(await outstandingRows(), []);
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
    assert.deepEqual(await outstandingRows(), []);
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
    assert.deepEqual(await outstandingRows(), []);
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

    const outstanding = await outstandingRows();
    assert.equal(outstanding.length, 1);
    assert.equal(outstanding[0].jobReference, fixture.jobReference);

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
    assert.deepEqual(await outstandingRows(), []);
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

    assert.deepEqual(await outstandingRows(), []);
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

/**
 * `count` certificates that are candidates and are correctly *not* repairs.
 *
 * Each is a property whose active position is from a later inspection than
 * its certificate, so `decidePosition` answers `keep_newer` — the rules
 * working, not a failure. No active cycle points at the certificate, so each
 * one is a genuine candidate that the SQL cannot exclude and only the rules
 * can. They are written directly because they are prior history, not
 * something this test is exercising.
 */
async function seedResolvedHistory(count: number): Promise<void> {
  const q = conn.client;
  const org = fixture.organisationId;

  await q.query(
    `insert into property
       (agent_organisation_id, customer_id, house_or_name, street, postcode)
     select $1, $2, 'H' || g, 'History Street', 'WV9 9AA'
     from generate_series(1, $3::int) g`,
    [org, fixture.landlordId, count],
  );

  // A newer position, from a different visit, holding each property.
  await q.query(
    `insert into compliance_cycle
       (property_id, agent_organisation_id, product_id, inspection_date,
        due_date, due_date_source, status)
     select id, $1, 'cp12', date '2026-06-01', date '2027-05-31',
            'manual', 'active'
     from property where street = 'History Street'`,
    [org],
  );

  await q.query(
    `insert into job
       (reference, idempotency_key, agent_organisation_id, customer_id,
        billing_customer_id, property_id, product_id, source,
        scheduling_method, lifecycle_status, appliance_count,
        price_total_pence, customer_snapshot, property_snapshot,
        price_snapshot)
     select ref, ref, $1, $2, $2, property_id, 'cp12', 'portal',
            'tenant_selected', 'completed', 1, 4500,
            '{"name":"Ada Fixture"}'::jsonb,
            '{"postcode":"WV9 9AA"}'::jsonb,
            '{"totalPence":4500}'::jsonb
     from (
       select p.id as property_id,
              'BSCJ-HIST' || row_number() over (order by p.id) as ref
       from property p where p.street = 'History Street'
     ) numbered`,
    [org, fixture.landlordId],
  );

  /*
    Issued well before the failure below, and a minute apart, so the
    ordering the traversal walks is the one this test intends.
  */
  await q.query(
    `insert into certificate
       (job_id, property_id, agent_organisation_id, certificate_number,
        version, status, inspection_date, next_due_date, issued_at)
     select j.id, j.property_id, $1, 'HIST-' || j.reference, 1, 'issued',
            date '2025-01-10', date '2026-01-09',
            timestamptz '2025-01-15 09:00:00+00'
              + (row_number() over (order by j.reference)) * interval '1 minute'
     from job j where j.reference like 'BSCJ-HIST%'`,
    [org],
  );
}

/** The fixture job's release, with the compliance write genuinely failing. */
async function failedRelease(): Promise<string> {
  await withComplianceWritesFailing(() =>
    release({
      jobId: fixture.jobId,
      documentId: fixture.documentIds[0],
      certificateNumber: "TEST-BEHIND-HISTORY",
      inspectionDate: "2026-09-20",
      nextDueDate: "2027-09-19",
    }),
  );
  return certificateIdFor(fixture.jobId);
}

/**
 * History in front of a repair.
 *
 * **The defect these reproduce.** The list fetched one window of candidates —
 * `max(limit * 4, 200)` rows, oldest issued first — and only then applied the
 * rules that decide what is a repair. Old certificates are overwhelmingly
 * *not* repairs: they are last year's, replaced by this year's visit. So a
 * portfolio with a couple of hundred of them filled the window with resolved
 * history, and a genuine failure sitting behind them never reached the page.
 * The page's whole purpose is to surface exactly that failure.
 *
 * Raising the multiplier would only move the number at which it happens, so
 * these tests are written against quantities a real portfolio reaches: BSCJ
 * issuing two certificates a working day passes 200 inside a year.
 */
describe("a genuine repair behind a long run of history", () => {
  test("the history is candidates, and none of it is a repair", async () => {
    await seedResolvedHistory(200);

    // Every one of them survives the SQL and is judged by the rules.
    const { rows } = await conn.client.query<{ n: string }>(
      `select count(*)::text as n from certificate c
         join job j on j.id = c.job_id
         left join compliance_cycle cc
           on cc.certificate_id = c.id and cc.status = 'active'
        where c.status = 'issued' and cc.id is null`,
    );
    assert.equal(rows[0].n, "200", "200 candidates the query cannot exclude");

    const result = await outstandingRows();
    assert.deepEqual(result, [], "and not one of them is a repair");
  });

  test("a failure behind 200 of them is still found", async () => {
    await seedResolvedHistory(200);
    const certificateId = await failedRelease();

    assert.equal(await renewalIsOutstanding(certificateId), "outstanding");

    const result = await listOutstandingRenewals();
    assert.notEqual(result, null);
    assert.equal(
      result!.stoppedBecause,
      "exhausted",
      "the whole ordering was walked",
    );
    assert.equal(result!.examined, 201, "every candidate was judged");
    assert.deepEqual(
      result!.rows.map((row) => row.jobReference),
      [fixture.jobReference],
      "the one genuine repair, behind two hundred that are not",
    );
  });

  test("and the retry offered for it actually clears it", async () => {
    await seedResolvedHistory(200);
    const certificateId = await failedRelease();

    const { updateRenewalFromCertificate } = await import(
      "../../src/lib/documents/certificates"
    );
    const retried = await updateRenewalFromCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      certificateId,
    });
    assert.equal(retried.ok, true);

    assert.deepEqual(await outstandingRows(), []);
    assert.equal(await renewalIsOutstanding(certificateId), "resolved");
  });

  test("nothing in the history was touched to make the list work", async () => {
    await seedResolvedHistory(200);
    await failedRelease();
    await listOutstandingRenewals();

    const counts = async (sql: string) =>
      (await conn.client.query<{ n: string }>(sql)).rows[0].n;

    assert.equal(
      await counts(
        "select count(*)::text as n from certificate where status = 'issued'",
      ),
      "201",
      "no certificate was marked superseded to shorten the list",
    );
    assert.equal(
      await counts(
        "select count(*)::text as n from compliance_cycle where status = 'active'",
      ),
      "200",
      "no position was closed, and the failure's was still not written",
    );
    assert.equal(
      await counts("select count(*)::text as n from compliance_cycle"),
      "200",
      "and nothing was deleted",
    );
  });
});

/**
 * The traversal itself: its bound, its order, and its continuation.
 *
 * A bound on the work is right — a page render must not become a full scan of
 * years of certificates. What is not right is a bound that *looks like* an
 * answer. So reaching it is reported as its own outcome, with the exact
 * position to resume from, and these tests are what hold that to it.
 */
describe("the walk over candidates", () => {
  /**
   * `count` certificates whose compliance write never landed.
   *
   * Written directly, as the residue of failures that happened before today —
   * the same shape the injected-failure test produces through the real
   * release path, which is where that path is exercised. Here what is under
   * test is the traversal, and it needs more of them than one release makes.
   *
   * No active cycle exists for these properties at all, so `decidePosition`
   * answers `establish`: a repair the retry button can make.
   */
  async function seedUnresolvedFailures(
    count: number,
    options: { issuedAt?: string; tag?: string } = {},
  ): Promise<void> {
    const tag = options.tag ?? "FAIL";
    const q = conn.client;

    await q.query(
      `insert into property
         (agent_organisation_id, customer_id, house_or_name, street, postcode)
       select $1, $2, $4 || g, $4 || ' Street', 'WV8 8AA'
       from generate_series(1, $3::int) g`,
      [fixture.organisationId, fixture.landlordId, count, tag],
    );

    await q.query(
      `insert into job
         (reference, idempotency_key, agent_organisation_id, customer_id,
          billing_customer_id, property_id, product_id, source,
          scheduling_method, lifecycle_status, appliance_count,
          price_total_pence, customer_snapshot, property_snapshot,
          price_snapshot)
       select ref, ref, $1, $2, $2, property_id, 'cp12', 'portal',
              'tenant_selected', 'completed', 1, 4500,
              '{"name":"Ada Fixture"}'::jsonb,
              '{"postcode":"WV8 8AA"}'::jsonb,
              '{"totalPence":4500}'::jsonb
       from (
         select p.id as property_id,
                'BSCJ-' || $3 || lpad(
                  (row_number() over (order by p.id))::text, 4, '0') as ref
         from property p where p.street = $3 || ' Street'
       ) numbered`,
      [fixture.organisationId, fixture.landlordId, tag],
    );

    await q.query(
      `insert into certificate
         (job_id, property_id, agent_organisation_id, certificate_number,
          version, status, inspection_date, next_due_date, issued_at)
       select j.id, j.property_id, $1, $3 || '-' || j.reference, 1, 'issued',
              date '2026-09-20', date '2027-09-19',
              $2::timestamptz
                + (row_number() over (order by j.reference)) * $4::interval
       from job j where j.reference like 'BSCJ-' || $3 || '%'`,
      [
        fixture.organisationId,
        options.issuedAt ?? "2026-10-01 09:00:00+00",
        tag,
        // Identical timestamps when asked for, so ties are genuinely tested.
        options.issuedAt === undefined ? "1 minute" : "0 seconds",
      ],
    );
  }

  test("reaching the bound is an incomplete answer, not an empty one", async () => {
    /*
      Two thousand resolved certificates — a portfolio BSCJ would reach in a
      few years — and one genuine repair behind all of them. The walk stops at
      its bound before the repair. The only honest thing it can say is that it
      has not finished, and where it got to.
    */
    await seedResolvedHistory(2_000);
    const certificateId = await failedRelease();

    const first = await listOutstandingRenewals();
    assert.notEqual(first, null);
    assert.equal(first!.stoppedBecause, "bound");
    assert.deepEqual(first!.rows, [], "nothing found yet");
    assert.equal(first!.examined, 2_000);
    assert.ok(first!.cursor, "and it says exactly where it stopped");

    // The repair is real, and the job page says so all along.
    assert.equal(await renewalIsOutstanding(certificateId), "outstanding");

    // Continuing from that position reaches it.
    const second = await listOutstandingRenewals({ after: first!.cursor });
    assert.equal(second!.stoppedBecause, "exhausted");
    assert.deepEqual(
      second!.rows.map((row) => row.jobReference),
      [fixture.jobReference],
    );
  });

  test("a full page says so and hands back where to continue", async () => {
    await seedUnresolvedFailures(5);

    const page = await listOutstandingRenewals({ limit: 2 });
    assert.equal(page!.rows.length, 2, "the limit is the limit");
    assert.equal(page!.stoppedBecause, "limit");
    assert.ok(page!.cursor);

    const rest = await listOutstandingRenewals({ limit: 10, after: page!.cursor });
    assert.equal(rest!.stoppedBecause, "exhausted");
    assert.equal(rest!.rows.length, 3);

    // Five distinct repairs, each reported exactly once across the two calls.
    const seen = [...page!.rows, ...rest!.rows].map((row) => row.jobReference);
    assert.equal(new Set(seen).size, 5);
  });

  test("certificates issued at the same instant are still walked exactly once", async () => {
    /*
      `issued_at` alone is not a total order, and a keyset over a partial one
      can repeat a row or skip one — skipping being the failure that matters,
      because the row it skips is a repair nobody is told about. The
      certificate id breaks the tie.
    */
    await seedUnresolvedFailures(6, { issuedAt: "2026-10-01 09:00:00+00" });

    const { rows } = await conn.client.query<{ n: string }>(
      `select count(distinct issued_at)::text as n from certificate`,
    );
    assert.equal(rows[0].n, "1", "all six share one instant");

    // One at a time, following the cursor, as a paging caller would.
    const seen: string[] = [];
    let cursor: RenewalCursor | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const step = await listOutstandingRenewals({ limit: 1, after: cursor });
      assert.notEqual(step, null);
      seen.push(...step!.rows.map((row) => row.jobReference));
      if (step!.stoppedBecause === "exhausted") break;
      cursor = step!.cursor;
    }

    assert.equal(seen.length, 6, "none skipped");
    assert.equal(new Set(seen).size, 6, "and none repeated");
  });

  test("an exhausted walk over nothing is a confident empty list", async () => {
    const result = await listOutstandingRenewals();
    assert.deepEqual(result, {
      rows: [],
      stoppedBecause: "exhausted",
      cursor: null,
      examined: 0,
    });
  });
});
