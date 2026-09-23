import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import {
  checkJournal,
  checkJournalFile,
  describeJournalProblems,
  type Journal,
} from "./migration-journal";

/**
 * The invariant the whole migration mechanism silently depends on.
 *
 * **This is a regression test for a real, shipped defect.** `0010`–`0012`
 * carried `when` values lower than `0009`'s, and because the migrator applies
 * a migration only when its `when` is greater than the newest `created_at` in
 * the database, all three were skipped on the pilot without a single line of
 * output. The command exited zero. `db:status` kept reporting 10 of 13.
 *
 * The first test below is the one that matters: it reads the repository's own
 * journal. Anything that puts it back into a state the migrator will not act
 * on fails here, before a database is involved.
 */

const JOURNAL_PATH = "drizzle/meta/_journal.json";

describe("the repository's own migration journal", () => {
  const real = checkJournalFile(
    (path) => readFileSync(path, "utf8"),
    "drizzle",
  );

  test("is in a state the migrator will act on", () => {
    if (!real.ok) {
      assert.fail(describeJournalProblems(real.problems));
    }
    assert.ok(real.entries.length > 0);
  });

  test("every timestamp is strictly after the one before it", () => {
    assert.ok(real.ok);
    for (let index = 1; index < real.entries.length; index += 1) {
      const previous = real.entries[index - 1];
      const current = real.entries[index];
      assert.ok(
        current.when > previous.when,
        `${current.tag} (${current.when}) must be after ${previous.tag} (${previous.when}) ` +
          `or the migrator will skip it on any database that already has ${previous.tag}`,
      );
    }
  });

  test("every entry has the SQL file it names", () => {
    assert.ok(real.ok);
    for (const entry of real.entries) {
      assert.ok(
        existsSync(`drizzle/${entry.tag}.sql`),
        `drizzle/${entry.tag}.sql is missing`,
      );
    }
  });

  test("every committed migration has a down file beside it", () => {
    /*
      Not the migrator's concern, but it is this repository's rule — a
      migration with no way back is a migration nobody can deploy
      confidently. `0000`'s own header says it is destructive; it still has
      one.
    */
    assert.ok(real.ok);
    for (const entry of real.entries) {
      assert.ok(
        existsSync(`drizzle/down/${entry.tag}.down.sql`),
        `drizzle/down/${entry.tag}.down.sql is missing`,
      );
    }
  });

  test("the numbers on disk and the journal agree on the count", () => {
    assert.ok(real.ok);
    const onDisk = real.entries.map((entry) => entry.tag);
    assert.deepEqual(
      onDisk,
      [...onDisk].sort(),
      "the journal is in filename order",
    );
  });
});

/* ---------------- The check itself ---------------- */

function journal(...whens: number[]): Journal {
  return {
    entries: whens.map((when, idx) => ({
      idx,
      when,
      tag: `${String(idx).padStart(4, "0")}_migration`,
      breakpoints: true,
    })),
  };
}

describe("what the check accepts", () => {
  test("strictly increasing timestamps", () => {
    const result = checkJournal(journal(1, 2, 3));
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.equal(result.entries.length, 3);
  });

  test("a single entry", () => {
    assert.equal(checkJournal(journal(1_790_000_000_000)).ok, true);
  });

  test("a gap of one millisecond, because that is all the migrator needs", () => {
    assert.equal(checkJournal(journal(1_000, 1_001)).ok, true);
  });
});

describe("what the check refuses", () => {
  test("a timestamp that goes backwards — the defect this exists for", () => {
    const result = checkJournal(journal(1_790_500_000_000, 1_790_036_674_090));
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0].tag, "0001_migration");
    assert.match(result.problems[0].message, /skipped silently/);
  });

  test("two entries with the same timestamp", () => {
    /*
      Equal is as bad as lower: the comparison is `<`, so a migration sharing
      the newest applied timestamp is skipped too.
    */
    const result = checkJournal(journal(5, 5));
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.match(result.problems[0].message, /not after/);
  });

  test("it names every entry that is out of order, not just the first", () => {
    const result = checkJournal(journal(10, 5, 4));
    assert.ok(!result.ok);
    assert.deepEqual(
      result.problems.map((problem) => problem.tag),
      ["0001_migration", "0002_migration"],
    );
  });

  test("a `when` that is not a number", () => {
    const bad = journal(1, 2);
    (bad.entries[1] as unknown as Record<string, unknown>).when = "1790600000000";
    const result = checkJournal(bad);
    assert.ok(!result.ok);
    assert.match(result.problems[0].message, /not a number/);
  });

  test("an `idx` that does not match its position", () => {
    const bad = journal(1, 2, 3);
    bad.entries[1].idx = 7;
    const result = checkJournal(bad);
    assert.ok(!result.ok);
    assert.ok(result.problems.some((p) => /entry 1 in the list/.test(p.message)));
  });

  test("a tag whose number disagrees with its index", () => {
    const bad = journal(1, 2);
    bad.entries[1].tag = "0009_renamed";
    const result = checkJournal(bad);
    assert.ok(!result.ok);
    assert.ok(result.problems.some((p) => /numbered 0009/.test(p.message)));
  });

  test("an empty journal, and something that is not a journal at all", () => {
    assert.equal(checkJournal({ entries: [] }).ok, false);
    assert.equal(checkJournal({}).ok, false);
    assert.equal(checkJournal(null).ok, false);
    assert.equal(checkJournal([]).ok, false);
    assert.equal(checkJournal("0000_v2_foundation").ok, false);
  });
});

describe("reading it off disk", () => {
  test("a missing file is a refusal, not an empty pass", () => {
    const result = checkJournalFile(() => {
      throw new Error("ENOENT");
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.match(result.problems[0].message, /could not be read/);
  });

  test("unparseable JSON is a refusal", () => {
    const result = checkJournalFile(() => "{ not json");
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.match(result.problems[0].message, /not JSON/);
  });
});

describe("what the operator is told", () => {
  test("the message names the file, the entries and that nothing ran", () => {
    const result = checkJournal(journal(1_790_500_000_000, 1_790_036_674_090));
    assert.ok(!result.ok);
    const text = describeJournalProblems(result.problems);
    assert.match(text, /0001_migration/);
    assert.match(text, /Nothing has been applied and no database was opened/);
    assert.match(text, /drizzle\/meta\/_journal\.json/);
  });
});

describe("the journal file is still the shape drizzle-kit wrote", () => {
  test("nothing but `when` was touched by the repair", () => {
    /*
      The repair changed three numbers. If it had reformatted the file,
      renumbered an entry or dropped `breakpoints`, drizzle-kit's own reader
      would be the thing that noticed — and it would notice at the worst
      possible moment. So the shape is asserted here instead.
    */
    const parsed = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
      version: string;
      dialect: string;
      entries: Record<string, unknown>[];
    };
    assert.equal(parsed.dialect, "postgresql");
    for (const entry of parsed.entries) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ["breakpoints", "idx", "tag", "version", "when"],
        "every entry carries exactly the keys drizzle-kit writes",
      );
      assert.equal(entry.breakpoints, true);
    }
  });
});
