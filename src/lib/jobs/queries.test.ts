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
      assert.match(source, /const \{ scope \} = await requireAdmin\(\)/, file);
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
