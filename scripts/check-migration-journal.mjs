/**
 * Refuses a migration run whose journal the migrator would not act on.
 *
 * **Why this runs before `drizzle-kit migrate` and not inside it.** The
 * migrator's decision to apply a migration is one comparison — the entry's
 * `when` against the newest `created_at` already in the database — and an
 * entry that loses that comparison is skipped in silence. No error, no
 * warning, exit code zero. The operator reads the same nothing a successful
 * run prints, `db:status` still says migrations are outstanding, and the only
 * way to find out why is to read the ORM's source.
 *
 * That is not a class of bug to leave to vigilance, so it is a gate: this
 * runs first, it opens no connection and mutates nothing, and a bad journal
 * stops the command with the reason printed. `db:migrate` is
 * `check-migration-journal && drizzle-kit migrate`, so the gate cannot be
 * skipped by running the normal command.
 *
 * Read-only and offline. It touches `drizzle/` and nothing else — no
 * environment, no credentials, no database. Safe to run at any time.
 *
 * Usage:
 *   node --experimental-strip-types --import ./scripts/test-resolver.mjs \
 *     scripts/check-migration-journal.mjs
 */

import { readFileSync } from "node:fs";
import { exit } from "node:process";

const { checkJournalFile, describeJournalProblems } = await import(
  "../src/lib/ops/migration-journal.ts"
);

const result = checkJournalFile(
  (path) => readFileSync(path, "utf8"),
  "drizzle",
);

if (!result.ok) {
  console.error(`\n${describeJournalProblems(result.problems)}\n`);
  exit(1);
}

/*
  One line on success, naming the count and the last entry.

  Deliberately not silent. The whole failure this guards against was a
  command that said nothing and did nothing, so a gate that also says nothing
  would be teaching the same lesson: that silence means it worked.
*/
const last = result.entries[result.entries.length - 1];
console.log(
  `Journal            : ${result.entries.length} migrations, ordered, ` +
    `newest ${last.tag} (${last.when})`,
);
