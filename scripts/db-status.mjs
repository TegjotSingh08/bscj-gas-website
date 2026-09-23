/**
 * What is actually in the database, and whether it matches the repository.
 *
 * **Read-only. It runs no DDL and writes nothing.** Safe to run against
 * production at any time, including before and after a migration.
 *
 * It exists because `drizzle-kit migrate` is silent on success: a run that
 * applies every migration perfectly prints a driver line, a websocket warning
 * and then nothing, which is indistinguishable from a run that did nothing at
 * all. Guessing from silence is how a migration gets applied twice, or gets
 * assumed to have been applied when it was not.
 *
 * It prints the **target** it is talking to — host and database name, never
 * a credential — because the first question before any migration is "which
 * database is this?", and in a two-environment world that is not rhetorical.
 *
 * Usage:
 *   npm run db:status
 *
 * The connection string is never printed. Any error is scrubbed of anything
 * that looks like a URL before it reaches the terminal.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { exit } from "node:process";

const { loadEnvironment, scrub } = await import("./load-env.mjs");
const { resolveTarget, assertConfirmedEndpoint, TargetError } = await import(
  "../src/lib/ops/db-target.ts"
);
const { checkJournalFile, describeJournalProblems } = await import(
  "../src/lib/ops/migration-journal.ts"
);

/*
  **The journal is checked before the target is even resolved.**

  This command's whole job is to tell an operator whether the database and the
  repository agree, and it used to compare them positionally: journal entry
  *n* against applied row *n*, ordered by `created_at`. That comparison is
  only meaningful while the journal's own order and `created_at` order are the
  same thing — and the defect that made this necessary was precisely a journal
  whose timestamps did not increase. Read against that, `db:status` would have
  paired the wrong hash with the wrong tag and reported drift, or worse, not
  reported it.

  It needs no connection, so it happens first and costs nothing.
*/
const journalCheck = checkJournalFile(
  (path) => readFileSync(path, "utf8"),
  "drizzle",
);
if (!journalCheck.ok) {
  console.error(`\n${describeJournalProblems(journalCheck.problems)}\n`);
  console.error("  Nothing was read from any database.\n");
  exit(1);
}

let mode;
try {
  ({ mode } = await loadEnvironment());
} catch (error) {
  console.error(scrub(error.message));
  exit(1);
}

/*
  The target is resolved **before a connection is opened**, and a disagreement
  between the pooled and direct URLs stops the command rather than warning it
  onward. Warning and continuing means the operator has to catch a line of
  output mid-run; refusing means they cannot miss it, and nothing has been
  read from the wrong database in the meantime.
*/
let target;
try {
  target = resolveTarget(process.env);

  /*
    **Checked here too, before the first query.**

    This command is read-only, so the instinct is that it needs no such guard.
    It is the wrong instinct: `db:status` is what an operator reads to decide
    the target is correct, and it was only *printing* the confirmed endpoint
    rather than testing it against the connection. A reassuring screenful from
    the wrong database is worse than no check at all, because the migration
    that follows is run with confidence.

    So in pilot mode the same assertion the writing commands use runs first,
    and a mismatch refuses before a single request is made.
  */
  if (mode === "pilot") {
    assertConfirmedEndpoint(target, process.env.BSCJ_PILOT_ENDPOINT);
  }
} catch (error) {
  if (error instanceof TargetError) {
    console.error(`\n${error.message}\n`);
    exit(1);
  }
  console.error(scrub(error.message ?? error));
  exit(1);
}

console.log(`Mode               : ${mode}`);
console.log(`Target             : ${target.identity}`);
console.log(`Using              : ${target.source}`);
if (mode === "pilot") {
  // Printed after the assertion above, so this line means "checked and agrees".
  console.log(`Confirmed endpoint : ${process.env.BSCJ_PILOT_ENDPOINT} — matches`);
}
console.log("");

const url = target.url;

const { neon } = await import("@neondatabase/serverless");
const sql = neon(url);

try {
  const journal = JSON.parse(
    readFileSync("drizzle/meta/_journal.json", "utf8"),
  );

  const journalTable = await sql`
    SELECT to_regclass('drizzle.__drizzle_migrations') AS present`;

  if (!journalTable[0].present) {
    /*
      No journal is **not** proof of an empty database.

      A database can carry tables from a hand-run script, an older tool, a
      restored dump or a half-finished attempt, and have no drizzle journal at
      all. Reporting "empty" on that evidence is how a migration gets run
      against something that already holds data — so what is actually there is
      counted and shown, and the recommendation depends on the answer.
    */
    const existing = await sql`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public'`;
    const existingEnums = await sql`
      SELECT count(*)::int AS n FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype = 'e'`;

    console.log(`Migrations on disk : ${journal.entries.length}`);
    console.log("Migrations applied : none — no drizzle journal in this database");
    console.log(`Tables in public   : ${existing[0].n}`);
    console.log(`Enum types         : ${existingEnums[0].n}`);

    if (existing[0].n === 0 && existingEnums[0].n === 0) {
      console.log("\nPublic schema is empty. Next: npm run db:migrate");
      exit(0);
    }

    console.log("");
    console.log("  WARNING: this database already contains objects but has no");
    console.log("  migration journal. It is NOT a fresh database. Find out what");
    console.log("  created them before running db:migrate — a migration run here");
    console.log("  may fail part-way or collide with what is already present.");
    exit(1);
  }

  const applied = await sql`
    SELECT hash, created_at FROM drizzle.__drizzle_migrations
    ORDER BY created_at`;

  console.log(`Migrations on disk : ${journal.entries.length}`);
  console.log(`Migrations applied : ${applied.length}`);
  console.log("");

  /*
    drizzle-kit records the SHA-256 of each migration's SQL. Comparing it to
    the file on disk catches the mistake that is otherwise invisible: editing
    a migration after it has been applied, so the database and the repository
    quietly disagree about what ran.
  */
  let drifted = 0;
  for (const [index, entry] of journal.entries.entries()) {
    const file = readFileSync(`drizzle/${entry.tag}.sql`, "utf8");
    const expected = createHash("sha256").update(file).digest("hex");
    const actual = applied[index]?.hash;

    let state;
    if (!actual) state = "NOT APPLIED";
    else if (actual === expected) state = "applied";
    else {
      state = "DIFFERS FROM DISK";
      drifted += 1;
    }
    console.log(`  ${entry.tag.padEnd(32)} ${state}`);
  }

  const tables = await sql`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public'`;
  const enums = await sql`
    SELECT count(*)::int AS n FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'`;
  const sequence = await sql`
    SELECT start_value, last_value FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = 'invoice_number_seq'`;

  console.log("");
  console.log(`Tables in public   : ${tables[0].n}`);
  console.log(`Enum types         : ${enums[0].n}`);

  if (sequence.length === 0) {
    console.log("Invoice sequence   : missing");
  } else {
    const { start_value: start, last_value: last } = sequence[0];
    // `last_value` is null until the sequence has been drawn from at all.
    const next = last === null ? start : String(BigInt(last) + 1n);
    const formatted = `BSCJ-${next.padStart(6, "0")}`;
    console.log(
      `Invoice sequence   : starts at ${start}, next number ${formatted}` +
        (last === null ? " (none issued yet)" : ""),
    );
  }

  if (drifted > 0) {
    console.log(
      `\n${drifted} migration(s) differ from the files on disk. Do not run db:migrate until that is understood.`,
    );
    exit(1);
  }

  const outstanding = journal.entries.length - applied.length;
  console.log(
    outstanding > 0
      ? `\n${outstanding} migration(s) outstanding. Next: npm run db:migrate`
      : "\nUp to date. Nothing to apply.",
  );
} catch (error) {
  console.error("Could not read the database state:", scrub(error?.message));
  exit(1);
}
