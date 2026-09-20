import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * `db:status` must refuse a mismatched pilot target **before** it connects.
 *
 * It is read-only, so the instinct is that it needs no such guard. That is the
 * wrong instinct: this command is what an operator reads to decide the target
 * is correct, and it was only *printing* the confirmed endpoint rather than
 * testing it. A reassuring screenful from the wrong database is worse than no
 * check, because the migration that follows is run with confidence.
 *
 * Driving the script needs a database, so what is asserted here is ordering —
 * which is exactly where the fault was. No database is contacted.
 */

const SOURCE = readFileSync(
  path.resolve(process.cwd(), "scripts/db-status.mjs"),
  "utf8",
);

/** Source with comments removed, so prose about a rule cannot satisfy it. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const body = code(SOURCE);

describe("the pilot endpoint is asserted, not merely printed", () => {
  test("it calls the shared assertion", () => {
    assert.match(body, /assertConfirmedEndpoint\s*\(/);
  });

  test("the assertion runs before any query is issued", () => {
    /*
      `neon(...)` creates the client and the first tagged-template call is the
      first request. Both must come after the guard, or a mismatched target has
      already been read from by the time anyone sees the refusal.
    */
    const guard = body.indexOf("assertConfirmedEndpoint(");
    const client = body.indexOf("neon(");
    const firstQuery = body.indexOf("await sql`");

    assert.ok(guard > 0, "the guard must be present");
    assert.ok(client > 0, "the client must be created");
    assert.ok(firstQuery > 0, "there must be a query");
    assert.ok(guard < client, "the guard must precede the client");
    assert.ok(guard < firstQuery, "the guard must precede the first query");
  });

  test("it is scoped to pilot mode, leaving development alone", () => {
    // Development is one local database with no confirmed endpoint to supply.
    // Requiring one there would be friction with nothing to protect.
    const guard = body.indexOf("assertConfirmedEndpoint(");
    const window = body.slice(Math.max(0, guard - 200), guard);
    assert.match(window, /mode === "pilot"/);
  });

  test("a failed assertion exits non-zero rather than carrying on", () => {
    const guard = body.indexOf("assertConfirmedEndpoint(");
    const after = body.slice(guard, guard + 600);
    assert.match(after, /TargetError/);
    assert.match(after, /exit\(1\)/);
  });
});

describe("the resolver is what decides the target", () => {
  test("status resolves through the shared module", () => {
    // Not its own copy of the precedence rule: a migration and a status that
    // disagree about which database they mean is the failure all of this
    // exists to prevent.
    assert.match(body, /resolveTarget\s*\(/);
    assert.match(SOURCE, /ops\/db-target/);
  });

  test("it does not reimplement pooler normalisation locally", () => {
    assert.equal(body.includes('replace("-pooler"'), false);
    assert.equal(body.includes("-pooler$"), false);
  });
});
