import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  connect,
  reset,
  start,
  stop,
  type Connection,
} from "../support/disposable-postgres";
import { seed, type Fixture } from "../support/fixtures";

/**
 * The down migrations, actually run.
 *
 * **Why this exists.** A rollback note is a claim about what happens to
 * somebody's data, and until now those claims had been written but never
 * executed — the handover before this one repeated one it had not checked. A
 * header that says "no certificate is touched" is worth nothing if nobody has
 * watched it not touch one.
 *
 * So these apply the real files, in the real order, to a database with a
 * submitted certificate and a signed draft on it, and assert what is left.
 * Disposable PostgreSQL only: `assertDisposable` inside the harness refuses
 * to connect to anything that is not the throwaway instance, which is what
 * makes it safe to run destructive DDL here at all.
 *
 * The three reversed here are the certificate-draft chain — `0010` (the
 * table), `0011` (the submission lease) and `0012` (the signatures). Reversing
 * `0000` is a different kind of act and is deliberately not automated.
 */

let conn: Connection;
let fixture: Fixture;

const down = (file: string) => readFileSync(`drizzle/down/${file}`, "utf8");

const DOWN_0012 = "0012_certificate_draft_signatures.down.sql";
const DOWN_0011 = "0011_certificate_submission_lease.down.sql";
const DOWN_0010 = "0010_engineer_certificate_drafts.down.sql";

before(async () => {
  await start();
  conn = await connect();
});

after(async () => {
  await conn.close();
  await stop();
});

async function count(sql: string): Promise<number> {
  const { rows } = await conn.client.query<{ n: string }>(sql);
  return Number(rows[0].n);
}

async function hasColumn(column: string): Promise<boolean> {
  return (
    (await count(
      `select count(*)::text as n from information_schema.columns
        where table_name = 'certificate_draft' and column_name = '${column}'`,
    )) > 0
  );
}

/** Whether the one document this file created is still there, untouched. */
async function documentSurvives(documentId: string): Promise<boolean> {
  const { rows } = await conn.client.query<{ blob_key: string; size_bytes: number }>(
    "select blob_key, size_bytes from document where id = $1",
    [documentId],
  );
  return (
    rows.length === 1 &&
    rows[0].blob_key === "rollback/test-not-valid" &&
    rows[0].size_bytes === 1234
  );
}

async function hasTable(): Promise<boolean> {
  return (
    (await count(
      `select count(*)::text as n from pg_tables
        where schemaname = 'public' and tablename = 'certificate_draft'`,
    )) > 0
  );
}

/**
 * A job with both kinds of thing on it: a draft nobody has finished, and a
 * certificate that has been submitted and released.
 *
 * The distinction is the whole point of the rollback notes — one of these is
 * working state and is expected to go, the other is a record and must not.
 */
async function seedBoth(): Promise<{ documentId: string }> {
  await reset(conn);
  fixture = await seed(conn);

  await conn.client.query(
    "update job set assigned_engineer_id = $1 where id = $2",
    [fixture.engineerUserId, fixture.jobId],
  );

  const { rows: docs } = await conn.client.query<{ id: string }>(
    `insert into document
       (job_id, kind, filename, blob_key, content_type, size_bytes, uploaded_by)
     values ($1, 'certificate', 'TEST-NOT-VALID-rollback.pdf',
             'rollback/test-not-valid', 'application/pdf', 1234, $2)
     returning id`,
    [fixture.jobId, fixture.engineerUserId],
  );
  const documentId = docs[0].id;

  await conn.client.query(
    `insert into certificate_draft
       (job_id, agent_organisation_id, fields, revision, signatures,
        submitted_document_id, submitted_at, submission_started_at)
     values ($1, $2, $3::jsonb, 4, $4::jsonb, $5, now(), now())`,
    [
      fixture.jobId,
      fixture.organisationId,
      JSON.stringify({ certNo: "TEST-NOT-VALID-ROLLBACK" }),
      JSON.stringify({
        issued: {
          dataUrl: "data:image/png;base64,AAAA",
          contentHash: "not-a-real-hash",
        },
      }),
      documentId,
    ],
  );

  return { documentId };
}

/*
  **One chain, in order, in a single test.** Each down file is destructive to
  the schema, so there is no re-seeding between them: once `signatures` is
  dropped the fixture cannot write one, and once the table is dropped there is
  no draft to write at all. Unwinding a release is a single sequence, and it
  is asserted as one — which is also how a person would actually do it.
*/
describe("reversing the certificate-draft chain", () => {
  test("each step takes working state and leaves the record", async () => {
    const { documentId } = await seedBoth();

    assert.equal(await hasColumn("signatures"), true);
    assert.equal(
      await count(
        "select count(*)::text as n from certificate_draft where signatures is not null",
      ),
      1,
      "a draft with a mark on it, to watch the mark go",
    );

    /* ---- 0012: the signatures come off, the draft stays ---- */
    await conn.client.query(down(DOWN_0012));

    assert.equal(await hasColumn("signatures"), false);
    assert.equal(
      await count("select count(*)::text as n from certificate_draft"),
      1,
      "the draft itself is untouched — only the marks on it go",
    );
    assert.equal(
      await documentSurvives(documentId),
      true,
      "and the submitted PDF is not reachable from here at all",
    );

    /* Safe to run against a database that has already had it. */
    await conn.client.query(down(DOWN_0012));
    assert.equal(await hasColumn("signatures"), false);

    /* ---- 0011: the lease column comes off, and nothing else does ---- */
    assert.equal(await hasColumn("submission_started_at"), true);
    await conn.client.query(down(DOWN_0011));

    assert.equal(await hasColumn("submission_started_at"), false);
    assert.equal(
      await count("select count(*)::text as n from certificate_draft"),
      1,
      "the draft survives losing its lease column",
    );
    assert.equal(await documentSurvives(documentId), true);

    await conn.client.query(down(DOWN_0011));
    assert.equal(await hasColumn("submission_started_at"), false);

    /* ---- 0010: the table goes, and the drafts with it ---- */
    await conn.client.query(down(DOWN_0010));

    assert.equal(await hasTable(), false, "the draft table is gone");

    /*
      **What survives, which is the claim worth checking.** The certificate
      that was submitted is a `document` row and a stored object. The foreign
      key from the draft to it is `ON DELETE SET NULL` in that direction, so
      dropping the draft table cannot reach it.
    */
    assert.equal(
      await documentSurvives(documentId),
      true,
      "the certificate the engineer submitted is exactly as it was",
    );

    await conn.client.query(down(DOWN_0010));
    assert.equal(await hasTable(), false);
  });

  test("the rest of the schema is still standing", async () => {
    /*
      A rollback of this release is not a rollback of V2. Everything the
      application needs to take a booking, hold a portfolio and issue a
      certificate is untouched.
    */
    for (const table of [
      "job",
      "document",
      "certificate",
      "compliance_cycle",
      "invoice",
      "property",
      "app_user",
    ]) {
      assert.equal(
        await count(
          `select count(*)::text as n from pg_tables
            where schemaname = 'public' and tablename = '${table}'`,
        ),
        1,
        `${table} survives the rollback`,
      );
    }
  });
});

describe("what a rollback needs the application to do", () => {
  test("the running code names the dropped column, so it cannot outlive it", async () => {
    /*
      **Stated here rather than only in a comment, because it is the thing
      that bites.** These are schema changes, not feature flags: the build
      that is deployed selects `signatures` by name. Reverting `0012` under a
      build that still expects it breaks every certificate draft save
      immediately — so the application is rolled back first, or with it.

      The other direction is safe, which is why the deployment order is
      migrate-then-deploy: an older build simply never reads the column.
    */
    const drafts = readFileSync(
      "src/lib/documents/certificate-drafts.ts",
      "utf8",
    );
    assert.ok(
      drafts.includes("certificateDrafts.signatures"),
      "the query names the column explicitly",
    );

    const schema = readFileSync("src/lib/db/schema.ts", "utf8");
    assert.ok(schema.includes('jsonb("signatures")'));
  });

  test("every committed down file is readable and says what it destroys", async () => {
    for (const file of [DOWN_0010, DOWN_0011, DOWN_0012]) {
      const sql = down(file);
      assert.match(sql, /Reverses 00\d\d\./, `${file} says what it reverses`);
      assert.match(
        sql,
        /IF EXISTS/,
        `${file} is safe to run against a database that has already had it`,
      );
    }
  });
});
