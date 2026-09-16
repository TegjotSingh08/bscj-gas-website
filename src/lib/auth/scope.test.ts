import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  assertOrganisationAccess,
  canAccessAssignedJob,
  canAccessOrganisation,
  MissingOrganisationError,
  organisationCondition,
  OutOfScopeError,
  scopeFor,
  type AccessScope,
} from "./scope";
import { APP_ROLES, type AppRole } from "./roles";

/**
 * Organisation isolation.
 *
 * The single most important property in V2: one letting agency must never be
 * able to reach another's landlords, properties, jobs, certificates or
 * invoices. These tests are written as an adversary — every case is "can the
 * wrong person get at this", not "can the right person".
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ENGINEER = "33333333-3333-4333-8333-333333333333";

const agent = (organisationId: string | null, role: AppRole = "agent_owner") =>
  scopeFor({ id: "user", role, agentOrganisationId: organisationId });

describe("what scope a role gets", () => {
  test("an administrator reaches everything", () => {
    assert.deepEqual(
      scopeFor({ id: "a", role: "admin", agentOrganisationId: null }),
      { kind: "all" },
    );
  });

  test("an administrator's scope ignores an organisation they happen to have", () => {
    // A staff account should not carry one, but if a row ever did, it must not
    // narrow an administrator into one agency's data.
    assert.deepEqual(
      scopeFor({ id: "a", role: "admin", agentOrganisationId: ACME }),
      { kind: "all" },
    );
  });

  test("an agency user is confined to their organisation", () => {
    assert.deepEqual(agent(ACME), {
      kind: "organisation",
      organisationId: ACME,
    });
    assert.deepEqual(agent(ACME, "agent_member"), {
      kind: "organisation",
      organisationId: ACME,
    });
  });

  test("an engineer is scoped by assignment, not by organisation", () => {
    /*
      Modelling an engineer as an organisation-less administrator would hand
      them everyone's data. Assignment is the whole permission.
    */
    assert.deepEqual(
      scopeFor({ id: ENGINEER, role: "engineer", agentOrganisationId: null }),
      { kind: "assigned", userId: ENGINEER },
    );
  });

  test("an agency user with no organisation is refused, not widened", () => {
    // The alternatives are "sees nothing", a silent outage, and "sees
    // everything", a breach. Throwing is the only safe reading.
    for (const role of ["agent_owner", "agent_member"] as const) {
      assert.throws(() => agent(null, role), MissingOrganisationError, role);
    }
  });

  test("every role produces a scope or an explicit refusal", () => {
    for (const role of APP_ROLES) {
      try {
        const scope = scopeFor({ id: "u", role, agentOrganisationId: ACME });
        assert.ok(["all", "organisation", "assigned"].includes(scope.kind));
      } catch (error) {
        assert.ok(error instanceof MissingOrganisationError, role);
      }
    }
  });
});

describe("reaching another organisation's rows", () => {
  test("an agency reaches its own and nothing else", () => {
    const scope = agent(ACME);
    assert.equal(canAccessOrganisation(scope, ACME), true);
    assert.equal(canAccessOrganisation(scope, OTHER), false);
  });

  test("consumer work belongs to nobody, so no agency may claim it", () => {
    /*
      A row with a null organisation is a booking taken on the public site. If
      null matched an agency's scope, the null case would become a shared pool
      every agency could read.
    */
    assert.equal(canAccessOrganisation(agent(ACME), null), false);
  });

  test("an administrator reaches consumer work as well as every agency's", () => {
    const scope: AccessScope = { kind: "all" };
    assert.equal(canAccessOrganisation(scope, null), true);
    assert.equal(canAccessOrganisation(scope, ACME), true);
    assert.equal(canAccessOrganisation(scope, OTHER), true);
  });

  test("an engineer reaches nothing by organisation", () => {
    const scope: AccessScope = { kind: "assigned", userId: ENGINEER };
    for (const organisation of [ACME, OTHER, null]) {
      assert.equal(canAccessOrganisation(scope, organisation), false);
    }
  });

  test("a refusal says nothing about whether the row exists", () => {
    // A message distinguishing "not yours" from "not there" turns an id into a
    // probe for which records exist.
    assert.throws(
      () => assertOrganisationAccess(agent(ACME), OTHER),
      (error: unknown) => {
        assert.ok(error instanceof OutOfScopeError);
        assert.equal(error.message, "Not found.");
        return true;
      },
    );
  });

  test("an allowed access is silent", () => {
    assert.doesNotThrow(() => assertOrganisationAccess(agent(ACME), ACME));
  });
});

describe("an engineer's access to a job", () => {
  const assigned = { assignedEngineerId: ENGINEER, agentOrganisationId: ACME };
  const somebodyElses = {
    assignedEngineerId: "44444444-4444-4444-8444-444444444444",
    agentOrganisationId: ACME,
  };
  const unassigned = { assignedEngineerId: null, agentOrganisationId: ACME };
  const scope: AccessScope = { kind: "assigned", userId: ENGINEER };

  test("their own assignment, and only that", () => {
    assert.equal(canAccessAssignedJob(scope, assigned), true);
    assert.equal(canAccessAssignedJob(scope, somebodyElses), false);
    assert.equal(canAccessAssignedJob(scope, unassigned), false);
  });

  test("an engineer on one agency's job cannot reach another's", () => {
    assert.equal(
      canAccessAssignedJob(scope, {
        assignedEngineerId: "44444444-4444-4444-8444-444444444444",
        agentOrganisationId: OTHER,
      }),
      false,
    );
  });

  test("an agency reaches its jobs whoever is assigned to them", () => {
    assert.equal(canAccessAssignedJob(agent(ACME), somebodyElses), true);
    assert.equal(canAccessAssignedJob(agent(OTHER), somebodyElses), false);
  });

  test("an administrator reaches any job", () => {
    for (const job of [assigned, somebodyElses, unassigned]) {
      assert.equal(canAccessAssignedJob({ kind: "all" }, job), true);
    }
  });
});

describe("the query filter", () => {
  /*
    A fake column is enough: what matters is which branch is taken, not the SQL
    that comes out. The condition is built through this helper precisely so a
    handler cannot forget the `WHERE` — an admin gets no condition, an agency
    gets an equality, and an engineer gets something that matches nothing.
  */
  const column = { name: "agent_organisation_id" } as never;

  test("an administrator is unfiltered", () => {
    assert.equal(organisationCondition(column, { kind: "all" }), undefined);
  });

  test("an agency is filtered to one organisation", () => {
    const condition = organisationCondition(column, agent(ACME));
    assert.ok(condition, "an agency query was left unfiltered");
  });

  test("an engineer's organisation filter matches nothing rather than everything", () => {
    /*
      The dangerous failure would be widening to "no condition". An engineer
      has no organisation, so organisation-scoped reads must return nothing and
      engineer queries must filter on assignment instead.
    */
    const condition = organisationCondition(column, {
      kind: "assigned",
      userId: ENGINEER,
    });
    assert.ok(condition, "an engineer query was left unfiltered");
    assert.match(JSON.stringify(condition), /"false"/);
  });
});
