import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import {
  connect,
  DISPOSABLE_URL,
  assertDisposable,
  start,
  stop,
  type Connection,
} from "../support/disposable-postgres";

/**
 * The upgrade path, not the fresh build.
 *
 * **Why the fresh build proved nothing.** Every other test here starts from an
 * empty database and applies `0000`–`0012` in one run. On an empty database
 * there is no newest `created_at` to compare against, so the migrator's
 * `!lastDbMigration ||` short-circuits and **every** migration applies
 * regardless of its timestamp. The whole suite was green while the pilot
 * could not be upgraded at all.
 *
 * The pilot is not an empty database. It is a database that already has
 * `0000`–`0009`, whose newest `created_at` is `0009`'s `1790500000000`, and
 * `drizzle-orm/pg-core/dialect.js` decides what to do next with one
 * comparison:
 *
 * ```js
 * if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
 * ```
 *
 * `0010`, `0011` and `0012` had been generated with their real timestamps
 * (22–23 September) while `0008` and `0009` carried hand-picked round numbers
 * running ahead of real time (26–27 September). All three lost that
 * comparison, so all three were skipped — silently, with exit code zero, on
 * every run.
 *
 * So these tests build the pilot's actual state and upgrade it:
 *
 * 1. Empty the database completely — schema and migration table.
 * 2. Apply `0000`–`0009` only, through the real migrator, from a journal
 *    truncated to those ten entries. That is the pilot baseline, byte for
 *    byte the same SQL the owner ran.
 * 3. Run **the owner's actual command**, `npm run db:migrate`, against it.
 * 4. Check what is really there afterwards: the table, its two later columns,
 *    the recorded hashes, and the counts `db:status` will print.
 *
 * One test also proves the defect, by staging the same baseline and running
 * the migrator with the **original broken timestamps** — so the thing this
 * repair fixes is demonstrated rather than described.
 *
 * Disposable PostgreSQL only. `assertDisposable` is re-checked before the
 * command is spawned, because that step hands a connection string to a
 * subprocess and the one mistake worth making impossible is that subprocess
 * reaching a real database.
 */

let conn: Connection;

/** What the owner's baseline is: `0000`–`0009`, and nothing after. */
const BASELINE_COUNT = 10;

/** Everything on disk. */
const JOURNAL = JSON.parse(
  readFileSync("drizzle/meta/_journal.json", "utf8"),
) as { entries: { idx: number; when: number; tag: string; breakpoints: boolean }[] };

const ALL_COUNT = JOURNAL.entries.length;

before(async () => {
  await start();
  conn = await connect();
});

after(async () => {
  await conn.close();
  await stop();
});

async function rows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await conn.client.query<T>(sql, params);
  return result.rows;
}

async function count(sql: string): Promise<number> {
  const [row] = await rows<{ n: string }>(sql);
  return Number(row.n);
}

/** The counts `db:status` prints, from the same queries it uses. */
async function shape(): Promise<{ tables: number; enums: number }> {
  return {
    tables: await count(
      `select count(*)::text as n from information_schema.tables
        where table_schema = 'public'`,
    ),
    enums: await count(
      `select count(*)::text as n from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' and t.typtype = 'e'`,
    ),
  };
}

type AppliedRow = { hash: string; created_at: string };

async function applied(): Promise<AppliedRow[]> {
  const present = await count(
    `select count(*)::text as n from information_schema.tables
      where table_schema = 'drizzle' and table_name = '__drizzle_migrations'`,
  );
  if (present === 0) return [];
  return rows<AppliedRow>(
    `select hash, created_at from drizzle.__drizzle_migrations order by created_at`,
  );
}

/** drizzle-kit's own hash: SHA-256 of the migration file, unmodified. */
function hashOf(tag: string): string {
  return createHash("sha256")
    .update(readFileSync(`drizzle/${tag}.sql`, "utf8"))
    .digest("hex");
}

/**
 * Back to nothing — schema and migration ledger both.
 *
 * `reset()` in the harness truncates rows and keeps the schema, which is the
 * right thing between ordinary tests and useless here: the point is to not
 * have `0010` onwards in the database at all.
 */
async function emptyTheDatabase(): Promise<void> {
  assertDisposable(DISPOSABLE_URL);
  await conn.client.query(`drop schema if exists public cascade`);
  await conn.client.query(`drop schema if exists drizzle cascade`);
  await conn.client.query(`create schema public`);
}

/**
 * A migrations folder holding only the entries named, with timestamps that
 * can be overridden.
 *
 * The SQL files are copied unchanged — the pilot ran these exact bytes, and a
 * test that rewrote them would be testing something else.
 */
function stageFolder(options: {
  upTo: number;
  overrideWhen?: Record<string, number>;
}): string {
  const folder = mkdtempSync(path.join(tmpdir(), "bscj-journal-"));
  mkdirSync(path.join(folder, "meta"));

  const entries = JOURNAL.entries.slice(0, options.upTo).map((entry) => ({
    ...entry,
    when: options.overrideWhen?.[entry.tag] ?? entry.when,
  }));

  for (const entry of entries) {
    copyFileSync(`drizzle/${entry.tag}.sql`, path.join(folder, `${entry.tag}.sql`));
  }

  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2),
  );

  return folder;
}

/** The pilot's state: `0000`–`0009` applied, through the real migrator. */
async function stagePilotBaseline(): Promise<void> {
  await emptyTheDatabase();
  await migrate(conn.db as never, {
    migrationsFolder: stageFolder({ upTo: BASELINE_COUNT }),
  });
}

/**
 * The owner's command, against the disposable database.
 *
 * **Both connection variables are set**, not just `DATABASE_URL`.
 * `resolveTarget` prefers `DATABASE_URL_UNPOOLED` when it is present, and
 * `drizzle.config.ts` loads `.env.local` for anything the environment has not
 * already supplied — so setting only one would leave a path by which the real
 * command could resolve a real database. Setting both closes it, and the
 * assertion above closes it again.
 */
function runOwnerMigrateCommand(): string {
  assertDisposable(DISPOSABLE_URL);
  return execFileSync("npm", ["run", "--silent", "db:migrate"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: DISPOSABLE_URL,
      DATABASE_URL_UNPOOLED: DISPOSABLE_URL,
      /* Development mode: pilot mode seals itself to `.env.pilot`. */
      BSCJ_PILOT: "",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("the pilot baseline, built the way the owner built it", () => {
  test("0000-0009 applied, and nothing of the certificate workflow present", async () => {
    await stagePilotBaseline();

    const ledger = await applied();
    assert.equal(ledger.length, BASELINE_COUNT, "ten migrations applied");
    assert.equal(
      Number(ledger[ledger.length - 1].created_at),
      1_790_500_000_000,
      "the newest created_at is 0009's — the number every later migration is compared against",
    );

    for (const [index, row] of ledger.entries()) {
      assert.equal(
        row.hash,
        hashOf(JOURNAL.entries[index].tag),
        `${JOURNAL.entries[index].tag} recorded the hash of the file on disk`,
      );
    }

    assert.equal(
      await count(
        `select count(*)::text as n from information_schema.tables
          where table_schema = 'public' and table_name = 'certificate_draft'`,
      ),
      0,
      "certificate_draft does not exist yet",
    );

    assert.deepEqual(
      await shape(),
      { tables: 24, enums: 22 },
      "24 tables and 22 enums — what db:status reports on the pilot today",
    );
  });
});

describe("the defect, demonstrated against the baseline", () => {
  test("the original timestamps are skipped in silence, applying nothing", async () => {
    await stagePilotBaseline();

    /*
      The three values as they were committed. Every one of them is lower
      than `0009`'s `1790500000000`.
    */
    const asShipped = stageFolder({
      upTo: ALL_COUNT,
      overrideWhen: {
        "0010_engineer_certificate_drafts": 1_790_036_674_090,
        "0011_certificate_submission_lease": 1_790_037_869_192,
        "0012_certificate_draft_signatures": 1_790_196_713_112,
      },
    });

    /* It does not throw. That is the whole problem. */
    await migrate(conn.db as never, { migrationsFolder: asShipped });

    assert.equal(
      (await applied()).length,
      BASELINE_COUNT,
      "still ten applied — the migrator reported success and did nothing",
    );
    assert.equal(
      await count(
        `select count(*)::text as n from information_schema.tables
          where table_schema = 'public' and table_name = 'certificate_draft'`,
      ),
      0,
      "certificate_draft was never created",
    );
    assert.deepEqual(await shape(), { tables: 24, enums: 22 });
  });

  test("the drizzle-kit CLI skips them too, not just the in-process migrator", async () => {
    /*
      **Worth proving separately.** The test above calls `migrate()` from
      `drizzle-orm/node-postgres/migrator`, which is where the `<` comparison
      lives. The owner does not run that — they run `drizzle-kit migrate`, and
      a repair aimed at the wrong code path would be worthless.

      So the CLI itself is pointed at a folder holding the original broken
      journal, through a temporary config beside the real one (it has to be
      inside the repository for `drizzle-kit`'s own types and `node_modules`
      to resolve). It is removed again whatever happens.
    */
    await stagePilotBaseline();

    const broken = stageFolder({
      upTo: ALL_COUNT,
      overrideWhen: {
        "0010_engineer_certificate_drafts": 1_790_036_674_090,
        "0011_certificate_submission_lease": 1_790_037_869_192,
        "0012_certificate_draft_signatures": 1_790_196_713_112,
      },
    });

    assertDisposable(DISPOSABLE_URL);
    const configPath = path.resolve(`drizzle.broken-journal.${process.pid}.config.ts`);
    writeFileSync(
      configPath,
      `import type { Config } from "drizzle-kit";\n` +
        `export default {\n` +
        `  schema: "./src/lib/db/schema.ts",\n` +
        `  out: ${JSON.stringify(broken)},\n` +
        `  dialect: "postgresql",\n` +
        `  dbCredentials: { url: ${JSON.stringify(DISPOSABLE_URL)} },\n` +
        `} satisfies Config;\n`,
    );

    let cliOutput = "";
    try {
      cliOutput = execFileSync(
        "npx",
        ["drizzle-kit", "migrate", `--config=${configPath}`],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } finally {
      rmSync(configPath, { force: true });
    }

    assert.equal(
      (await applied()).length,
      BASELINE_COUNT,
      `drizzle-kit migrate exited successfully and applied nothing; output:\n${cliOutput}`,
    );
    assert.equal(
      await count(
        `select count(*)::text as n from information_schema.tables
          where table_schema = 'public' and table_name = 'certificate_draft'`,
      ),
      0,
      "the CLI shares the comparison — this is the pilot's exact symptom",
    );
  });

  test("the repaired timestamps are exactly what the comparison needs", () => {
    /*
      Not a date check. `when` is an ordinal here, and the only requirement is
      that each of the three is greater than the newest already applied.
    */
    const byTag = new Map(JOURNAL.entries.map((e) => [e.tag, e.when]));
    const nine = byTag.get("0009_one_active_cycle_per_service")!;
    for (const tag of [
      "0010_engineer_certificate_drafts",
      "0011_certificate_submission_lease",
      "0012_certificate_draft_signatures",
    ]) {
      assert.ok(byTag.get(tag)! > nine, `${tag} must be after 0009`);
    }
  });
});

describe("the owner's command, run against the baseline", () => {
  test("npm run db:migrate applies all three and says what it checked", async () => {
    await stagePilotBaseline();

    const output = runOwnerMigrateCommand();

    /*
      The preflight guard runs first and prints one line. Its silence was the
      original sin; a gate that also said nothing would repeat it.
    */
    assert.match(
      output,
      /Journal\s+: 13 migrations, ordered, newest 0012_certificate_draft_signatures/,
      `the guard reported the journal it approved; got:\n${output}`,
    );

    const ledger = await applied();
    assert.equal(ledger.length, ALL_COUNT, "13 of 13 applied");
  });

  test("every recorded hash matches the file on disk, in order", async () => {
    const ledger = await applied();
    assert.equal(ledger.length, ALL_COUNT);
    for (const [index, row] of ledger.entries()) {
      const entry = JOURNAL.entries[index];
      assert.equal(row.hash, hashOf(entry.tag), `${entry.tag} hash`);
      assert.equal(
        Number(row.created_at),
        entry.when,
        `${entry.tag} created_at is its journal timestamp`,
      );
    }
  });

  test("certificate_draft exists, with its lease and signature columns", async () => {
    const columns = await rows<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema = 'public' and table_name = 'certificate_draft'
        order by column_name`,
    );
    assert.ok(columns.length > 0, "the table was created by 0010");

    const byName = new Map(columns.map((c) => [c.column_name, c]));

    /* 0010 — the table itself. */
    for (const name of [
      "id",
      "job_id",
      "agent_organisation_id",
      "fields",
      "revision",
      "updated_by",
      "created_at",
      "updated_at",
      "submission_key",
      "submitted_document_id",
      "submitted_at",
    ]) {
      assert.ok(byName.has(name), `0010 column ${name}`);
    }

    /* 0011 — the submission lease. */
    const lease = byName.get("submission_started_at");
    assert.ok(lease, "0011 applied: submission_started_at is present");
    assert.equal(lease.data_type, "timestamp with time zone");
    assert.equal(lease.is_nullable, "YES");

    /* 0012 — the signatures. */
    const signatures = byName.get("signatures");
    assert.ok(signatures, "0012 applied: signatures is present");
    assert.equal(signatures.data_type, "jsonb");
    assert.equal(
      signatures.is_nullable,
      "YES",
      "nullable, so no existing row was rewritten",
    );

    /* And the constraints 0010 carried, not just its columns. */
    const indexes = await rows<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = 'public' and tablename = 'certificate_draft'`,
    );
    const names = indexes.map((i) => i.indexname);
    assert.ok(
      names.includes("certificate_draft_job_key"),
      "the one-draft-per-job unique index",
    );
    assert.ok(names.includes("certificate_draft_organisation_idx"));

    const keys = await rows<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid = 'public.certificate_draft'::regclass and contype = 'f'`,
    );
    assert.equal(keys.length, 4, "four foreign keys, as 0010 declares");
  });

  test("the counts are the ones db:status will print", async () => {
    assert.deepEqual(
      await shape(),
      { tables: 25, enums: 22 },
      "25 tables, 22 enums after the upgrade",
    );
  });

  test("a second run changes nothing", async () => {
    const before = await applied();

    const output = runOwnerMigrateCommand();
    assert.match(output, /13 migrations, ordered/);

    const after = await applied();
    assert.equal(after.length, before.length, "no row was added");
    assert.deepEqual(
      after.map((r) => r.hash),
      before.map((r) => r.hash),
      "and none was rewritten",
    );
    assert.deepEqual(await shape(), { tables: 25, enums: 22 });

    /*
      The ledger has one row per migration and no duplicate of any of them,
      which is the failure a second run would produce if the comparison were
      wrong in the other direction.
    */
    assert.equal(
      await count(
        `select count(*)::text as n from (
           select hash from drizzle.__drizzle_migrations
            group by hash having count(*) > 1
         ) as duplicated`,
      ),
      0,
      "no migration is recorded twice",
    );
  });

  test("the application can use the table it just got", async () => {
    /*
      A column existing is not the same as the application being able to
      write it. This inserts through the real schema definition, which is the
      thing the deployed build uses, so a name or type disagreement between
      the migration and `schema.ts` would fail here.
    */
    const { certificateDrafts } = await import("../../src/lib/db/schema");
    const { seed } = await import("../support/fixtures");

    const fixture = await seed(conn);
    await conn.client.query(
      "update job set assigned_engineer_id = $1 where id = $2",
      [fixture.engineerUserId, fixture.jobId],
    );

    await (conn.db as never as {
      insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> };
    })
      .insert(certificateDrafts)
      .values({
        jobId: fixture.jobId,
        agentOrganisationId: fixture.organisationId,
        fields: { certNo: "TEST-NOT-VALID-UPGRADE" },
        revision: 1,
        signatures: { issued: { dataUrl: "data:image/png;base64,AAAA", contentHash: "x" } },
        submissionStartedAt: new Date(),
      });

    const [row] = await rows<{ signatures: unknown; submission_started_at: string | null }>(
      `select signatures, submission_started_at from certificate_draft
        where job_id = $1`,
      [fixture.jobId],
    );
    assert.ok(row, "the draft was written");
    assert.ok(row.signatures, "the signature column round-trips");
    assert.ok(row.submission_started_at, "the lease column round-trips");
  });
});

describe("the guard stops a bad journal before the database is opened", () => {
  test("db:migrate refuses, and applies nothing, when the order is wrong", async () => {
    await stagePilotBaseline();
    const ledgerBefore = await applied();
    assert.equal(ledgerBefore.length, BASELINE_COUNT);

    /*
      The real journal is not touched. A copy carrying the original broken
      timestamps is put where the command reads it, by pointing the command
      at a working directory whose `drizzle/` is that copy — the guard reads
      `drizzle/meta/_journal.json` relative to the process, so this is the
      honest way to exercise it without editing the repository.
    */
    const sandbox = mkdtempSync(path.join(tmpdir(), "bscj-badjournal-"));
    const broken = stageFolder({
      upTo: ALL_COUNT,
      overrideWhen: {
        "0010_engineer_certificate_drafts": 1_790_036_674_090,
        "0011_certificate_submission_lease": 1_790_037_869_192,
        "0012_certificate_draft_signatures": 1_790_196_713_112,
      },
    });

    let failed = false;
    let message = "";
    try {
      execFileSync(
        "node",
        [
          "--experimental-strip-types",
          "--import",
          path.resolve("scripts/test-resolver.mjs"),
          path.resolve("scripts/check-migration-journal.mjs"),
        ],
        {
          cwd: sandbox,
          env: { ...process.env },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      failed = true;
      const e = error as { stderr?: string; stdout?: string; status?: number };
      message = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      assert.equal(e.status, 1, "a non-zero exit, so && stops the command");
    }
    assert.equal(failed, true, "a missing journal is refused");
    assert.match(message, /could not be read|not in a state/);

    /* Now with the broken journal actually in place. */
    mkdirSync(path.join(sandbox, "drizzle", "meta"), { recursive: true });
    copyFileSync(
      path.join(broken, "meta", "_journal.json"),
      path.join(sandbox, "drizzle", "meta", "_journal.json"),
    );
    for (const entry of JOURNAL.entries) {
      copyFileSync(
        `drizzle/${entry.tag}.sql`,
        path.join(sandbox, "drizzle", `${entry.tag}.sql`),
      );
    }

    let refused = false;
    let reason = "";
    try {
      execFileSync(
        "node",
        [
          "--experimental-strip-types",
          "--import",
          path.resolve("scripts/test-resolver.mjs"),
          path.resolve("scripts/check-migration-journal.mjs"),
        ],
        {
          cwd: sandbox,
          env: { ...process.env },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      refused = true;
      const e = error as { stderr?: string; stdout?: string; status?: number };
      reason = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      assert.equal(e.status, 1);
    }

    assert.equal(refused, true, "the guard refused the broken ordering");
    assert.match(reason, /0010_engineer_certificate_drafts/);
    assert.match(reason, /skipped silently/);
    assert.match(reason, /no database was opened/);

    assert.equal(
      (await applied()).length,
      BASELINE_COUNT,
      "and the database is untouched",
    );
  });
});
