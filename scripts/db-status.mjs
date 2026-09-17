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
 * Usage:
 *   npm run db:status
 *
 * The connection string is never printed. Any error is scrubbed of anything
 * that looks like a URL before it reaches the terminal.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { exit } from "node:process";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No such file. The environment is expected to be populated already.
}

/** Never let a connection string reach the terminal, even inside an error. */
function scrub(value) {
  return String(value).replace(/postgres(?:ql)?:\/\/\S+/gi, "<redacted>");
}

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Add it to .env.local.");
  exit(1);
}

const { neon } = await import("@neondatabase/serverless");
const sql = neon(url);

try {
  const journal = JSON.parse(
    readFileSync("drizzle/meta/_journal.json", "utf8"),
  );

  const journalTable = await sql`
    SELECT to_regclass('drizzle.__drizzle_migrations') AS present`;

  if (!journalTable[0].present) {
    console.log("Migrations applied : none — this database is empty of V2.");
    console.log(`Migrations on disk : ${journal.entries.length}`);
    console.log("\nNext: npm run db:migrate");
    exit(0);
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
