import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { scopeFor } from "@/lib/auth/scope";

/**
 * Job reads are scoped, structurally.
 *
 * A behavioural test here would need a database and would only prove the query
 * that happens to be written today. These are repository-level assertions
 * instead, for the same reason `admin-access.test.ts` is: the failure worth
 * preventing is a *new query* added later that filters on nothing and quietly
 * returns another agency's jobs.
 */

const SOURCE = readFileSync(
  path.resolve(process.cwd(), "src/lib/jobs/queries.ts"),
  "utf8",
);

describe("every job read is scoped", () => {
  test("the module is server-only", () => {
    assert.match(SOURCE, /import "server-only"/);
  });

  test("every exported query takes a scope", () => {
    const exported = [...SOURCE.matchAll(/export async function (\w+)\(([^)]*)\)/g)];
    assert.ok(exported.length > 0, "no queries were found to check");

    for (const [, name, params] of exported) {
      assert.match(
        params,
        /scope: AccessScope/,
        `${name} can be called without a scope`,
      );
    }
  });

  test("every query builds its filter with the shared helper", () => {
    /*
      `organisationCondition` is the only sanctioned way to build the filter:
      it takes the column, so a table without an organisation column cannot be
      queried through it by accident, and an engineer gets a condition that
      matches nothing rather than no condition at all.
    */
    const selects = SOURCE.split("export async function").slice(1);
    for (const body of selects) {
      const name = body.slice(0, body.indexOf("("));
      assert.match(
        body,
        /organisationCondition\(/,
        `${name} builds its own filter instead of using the helper`,
      );
    }
  });

  test("no query hand-writes an organisation comparison", () => {
    // The one thing that would silently bypass the helper.
    assert.equal(
      /eq\(\s*jobs\.agentOrganisationId/.test(SOURCE),
      false,
      "a query compares the organisation column directly",
    );
  });
});

describe("what each role's scope means for a job list", () => {
  const admin = scopeFor({ id: "a", role: "admin", agentOrganisationId: null });
  const agent = scopeFor({
    id: "b",
    role: "agent_owner",
    agentOrganisationId: "11111111-1111-4111-8111-111111111111",
  });
  const engineer = scopeFor({
    id: "c",
    role: "engineer",
    agentOrganisationId: null,
  });

  test("an administrator is unfiltered, which is what makes consumer work visible", () => {
    // A website booking has no organisation. Only an unfiltered scope sees it,
    // and only an administrator gets one.
    assert.deepEqual(admin, { kind: "all" });
  });

  test("an agency user is confined to their own organisation", () => {
    assert.equal(agent.kind, "organisation");
  });

  test("an engineer is scoped by assignment, so a job list gives them nothing", () => {
    assert.equal(engineer.kind, "assigned");
  });
});

describe("the admin job pages verify the session themselves", () => {
  const pages = [
    "src/app/admin/jobs/page.tsx",
    "src/app/admin/jobs/[id]/page.tsx",
  ];

  test("each calls requireAdmin and passes the verified scope to the query", () => {
    /*
      The scope must come from the session, never from a search param or a
      route segment. Taking the organisation from the request is precisely how
      one agency reads another's portfolio.
    */
    for (const file of pages) {
      const source = readFileSync(path.resolve(process.cwd(), file), "utf8");
      assert.match(source, /requireAdmin\(\)/, file);
      /*
        Destructured from the session, whatever else is taken alongside it.
        The point is that `scope` has one source — not that the line is
        spelled a particular way.
      */
      assert.match(
        source,
        /const \{[^}]*\bscope\b[^}]*\} = await requireAdmin\(\)/,
        file,
      );
    }
  });

  test("neither page is indexable", () => {
    for (const file of pages) {
      const source = readFileSync(path.resolve(process.cwd(), file), "utf8");
      assert.match(source, /index: false/, file);
    }
  });

  test("the detail page does not distinguish 'not yours' from 'not found'", () => {
    // Distinguishing them turns an id into a probe for which records exist.
    const source = readFileSync(
      path.resolve(process.cwd(), "src/app/admin/jobs/[id]/page.tsx"),
      "utf8",
    );
    assert.match(source, /notFound\(\)/);
  });
});

/**
 * The engineer's reads are scoped by assignment, not by organisation.
 *
 * Structural for the same reason the block above is: the failure worth
 * preventing is a *new query* added later that filters on nothing and hands
 * one engineer another's day — or, worse, an agency's.
 */
describe("every engineer read is scoped by assignment", () => {
  const SOURCE = readFileSync(
    path.resolve(process.cwd(), "src/lib/jobs/engineer-queries.ts"),
    "utf8",
  );

  test("the module is server-only", () => {
    assert.match(SOURCE, /import "server-only"/);
  });

  test("every exported query takes a scope and filters with the helper", () => {
    const exported = [...SOURCE.matchAll(/export async function (\w+)\(([^)]*)\)/g)];
    assert.ok(exported.length > 0, "no queries were found to check");

    for (const [, name, params] of exported) {
      assert.match(params, /scope: AccessScope/, `${name} takes no scope`);
    }

    for (const body of SOURCE.split("export async function").slice(1)) {
      const name = body.slice(0, body.indexOf("("));
      assert.match(
        body,
        /assignmentCondition\(/,
        `${name} builds its own filter instead of using the helper`,
      );
    }
  });

  test("no query hand-writes the assignment comparison", () => {
    // The one thing that would silently bypass the helper.
    assert.equal(
      /eq\(\s*jobs\.assignedEngineerId/.test(SOURCE),
      false,
      "a query compares the assignment column directly",
    );
  });

  test("no money column is ever selected", () => {
    /*
      The engineer role carries neither `pricing:read` nor `invoice:read`.
      Leaving the columns out of the *query* is stronger than leaving them out
      of the markup: a value that is never loaded cannot be leaked by a later
      change to what a page renders.
    */
    for (const column of [
      "priceTotalPence",
      "priceSnapshot",
      "applianceCount",
      "remedialAuthorityPence",
    ]) {
      assert.equal(
        SOURCE.includes(column),
        false,
        `the engineer queries load ${column}`,
      );
    }
  });
});

/**
 * Nothing that decides an outcome comes from the browser.
 *
 * The V2 rule, asserted rather than trusted: a price, a duration, a status
 * or an ownership that arrived in a request is re-derived on the server. The
 * work actions take an id and — for completion — a note, and everything else
 * is read from the row.
 */
describe("the work actions trust nothing they are handed", () => {
  const SOURCE = readFileSync(
    path.resolve(process.cwd(), "src/lib/jobs/work-actions.ts"),
    "utf8",
  );

  test("the module is server-only", () => {
    assert.match(SOURCE, /import "server-only"/);
  });

  test("every write asserts the transition before making it", () => {
    // An impossible status must fail where it is attempted, not become a row
    // nobody can explain.
    const writes = [...SOURCE.matchAll(/\.update\(jobs\)/g)];
    const asserts = [...SOURCE.matchAll(/assertTransition\(/g)];
    assert.ok(writes.length > 0, "no writes were found to check");
    assert.ok(
      asserts.length >= writes.length,
      `${writes.length} writes but only ${asserts.length} transition assertions`,
    );
  });

  test("every write is conditional on the state that was read", () => {
    /*
      Two taps on a phone with a bad signal, or an engineer and an
      administrator acting at the same moment, must produce one change and one
      honest refusal — not two writes racing.
    */
    const updates = SOURCE.split(".update(jobs)").slice(1);
    for (const update of updates) {
      const clause = update.slice(0, update.indexOf(".returning("));
      assert.match(clause, /\.where\(/, "a job update has no WHERE at all");
      assert.match(
        clause,
        /eq\(jobs\.lifecycleStatus,/,
        "a job update is not guarded on the status it read",
      );
    }
    assert.match(SOURCE, /updated\.length === 0/);
  });

  test("the caller's access is checked against the row, every time", () => {
    assert.match(SOURCE, /canAccessAssignedJob\(/);
    // And the capability, which is the other half and not a substitute.
    const bodies = SOURCE.split("\nexport async function ").slice(1);
    assert.ok(bodies.length > 0);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      assert.match(
        body,
        /assertCan\(session\.user\.role,/,
        `${name} does not assert a capability`,
      );
    }
  });

  test("no status, price or time is taken from the input", () => {
    for (const field of [
      "input.lifecycleStatus",
      "input.status",
      "input.price",
      "input.completedAt",
      "input.startedAt",
      "input.assignedEngineerId",
    ]) {
      assert.equal(SOURCE.includes(field), false, `${field} comes from the caller`);
    }
    // The clocks are the server's.
    assert.match(SOURCE, /const startedAt = new Date\(\)/);
    assert.match(SOURCE, /const completedAt = new Date\(\)/);
  });

  test("every change writes its own timeline entry", () => {
    const entries = [...SOURCE.matchAll(/kind: "job\.[a-z_]+"/g)];
    assert.ok(entries.length >= 4, "a change is made without recording it");
  });
});

/**
 * The dashboard's figures add up.
 *
 * The private/agency split is the distinction BSCJ runs the business on, and
 * a reader is invited to check the page by adding the two together. That only
 * holds if the three counts are derived the same way — so this asserts the
 * derivation rather than the arithmetic, which is the part a later edit could
 * quietly break.
 */
describe("the totals are one pass, and the split is exhaustive", () => {
  const TOTALS = SOURCE.slice(
    SOURCE.indexOf("export async function jobTotals"),
    SOURCE.indexOf("/** Counts rows matching a condition"),
  );

  test("there is a jobTotals to check", () => {
    assert.ok(TOTALS.length > 0);
  });

  test("the total and both halves come from one select over one where", () => {
    /*
      Separate queries could disagree with each other if a job moved between
      them, and a total that disagrees with its own breakdown is a dashboard
      nobody trusts again.
    */
    const selects = [...TOTALS.matchAll(/\.select\(\{/g)];
    assert.equal(selects.length, 2, "the buckets are no longer one pass");

    const bucketPass = TOTALS.slice(
      TOTALS.indexOf(".select({"),
      TOTALS.indexOf(".from(jobs)"),
    );
    for (const field of ["all: count()", "private:", "agency:"]) {
      assert.ok(bucketPass.includes(field), `${field} is not in the single pass`);
    }
    // And that pass is filtered by the scope and nothing else.
    assert.match(TOTALS, /\.from\(jobs\)\s*\.where\(scopeOnly\)/);
  });

  test("private and agency are exact complements, so nothing is double-counted", () => {
    // `IS NULL` and `IS NOT NULL` over the same column: mutually exclusive,
    // and between them they cover every row the scope returned.
    assert.match(TOTALS, /const isPrivate = isNull\(jobs\.agentOrganisationId\)/);
    assert.match(TOTALS, /agency: sum\(isNotNull\(jobs\.agentOrganisationId\)\)/);
    assert.match(TOTALS, /private: sum\(isPrivate\)/);
  });

  test("the open halves are the same split, narrowed the same way", () => {
    // privateOpen and agencyOpen must be the halves AND the open condition,
    // or the "still open" lines below each figure describe a different set.
    assert.match(TOTALS, /privateOpen: sum\(and\(isPrivate, open\)!\)/);
    assert.match(
      TOTALS,
      /agencyOpen: sum\(and\(isNotNull\(jobs\.agentOrganisationId\), open\)!\)/,
    );
  });

  test("the dashboard actually shows the total, not only the split", () => {
    /*
      `all` was computed and not rendered for the whole of the first pass at
      this page: the breakdown was on screen and the number it breaks down
      was not.
    */
    const dashboard = readFileSync(
      path.resolve(process.cwd(), "src/app/admin/page.tsx"),
      "utf8",
    );
    assert.match(dashboard, /\{totals\.all\}/, "the overall total is not rendered");
    assert.match(dashboard, /\{totals\.private\}/);
    assert.match(dashboard, /\{totals\.agency\}/);
  });

  test("every figure on the dashboard links to the rows it counted", () => {
    // A number nobody can open is a number nobody can check.
    const dashboard = readFileSync(
      path.resolve(process.cwd(), "src/app/admin/page.tsx"),
      "utf8",
    );
    for (const href of [
      '"/admin/jobs"',
      '"/admin/jobs?view=today"',
      '"/admin/jobs?view=open"',
      '"/admin/jobs?view=unassigned"',
      '"/admin/jobs?view=attention"',
      '"/admin/jobs?client=private"',
      '"/admin/jobs?client=agency"',
      '"/admin/jobs?view=closed"',
    ]) {
      assert.ok(dashboard.includes(href), `${href} is not linked from a figure`);
    }
  });
});
