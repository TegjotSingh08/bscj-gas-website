import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_ROLES,
  APP_ROLES,
  assertCan,
  can,
  capabilitiesFor,
  CAPABILITIES,
  isAgentRole,
  isAppRole,
  isStaffRole,
  NotPermittedError,
  STAFF_ROLES,
  type AppRole,
  type Capability,
} from "./roles";

/**
 * The permission matrix, asserted against an independently written copy.
 *
 * Restating the table rather than deriving from it is the point: a test that
 * reads the implementation and agrees with it proves nothing. Every capability
 * a role does *not* have is checked too, because a permission model is judged
 * on what it refuses.
 */
describe("the capability matrix", () => {
  const EXPECTED: Record<AppRole, Capability[]> = {
    admin: [...CAPABILITIES],
    engineer: [
      "job:read",
      "job:work",
      "certificate:read",
      "certificate:issue",
      "message:read",
      "message:write",
    ],
    agent_owner: [
      "portfolio:read",
      "portfolio:write",
      "job:create",
      "job:read",
      "pricing:read",
      "invoice:read",
      "certificate:read",
      "message:read",
      "message:write",
      "user:manage",
    ],
    agent_member: [
      "portfolio:read",
      "portfolio:write",
      "job:create",
      "job:read",
      "pricing:read",
      "invoice:read",
      "certificate:read",
      "message:read",
      "message:write",
    ],
  };

  test("every role and capability pair is decided the same way", () => {
    for (const role of APP_ROLES) {
      for (const capability of CAPABILITIES) {
        assert.equal(
          can(role, capability),
          EXPECTED[role].includes(capability),
          `${role} / ${capability} disagreed with the table`,
        );
      }
    }
  });

  test("an administrator can do everything", () => {
    assert.deepEqual(capabilitiesFor("admin"), [...CAPABILITIES].sort());
  });

  test("an engineer never sees money", () => {
    /*
      The restricted interface exists so an engineer can work a day without
      being handed an agency's negotiated rate. A capability that leaked here
      would put pricing on a phone screen in somebody's hallway.
    */
    for (const capability of [
      "pricing:read",
      "pricing:write",
      "invoice:read",
      "invoice:write",
    ] as const) {
      assert.equal(can("engineer", capability), false, capability);
    }
  });

  test("an engineer cannot reach a portfolio at all", () => {
    for (const capability of [
      "portfolio:read",
      "portfolio:write",
      "job:create",
      "job:assign",
    ] as const) {
      assert.equal(can("engineer", capability), false, capability);
    }
  });

  test("an agent can read invoices and never write one", () => {
    // Issuing is BSCJ's, and an issued invoice is immutable regardless.
    for (const role of AGENT_ROLES) {
      assert.equal(can(role, "invoice:read"), true, role);
      assert.equal(can(role, "invoice:write"), false, role);
    }
  });

  test("an agent can never issue or correct a safety record", () => {
    for (const role of AGENT_ROLES) {
      assert.equal(can(role, "certificate:read"), true, role);
      assert.equal(can(role, "certificate:issue"), false, role);
      assert.equal(can(role, "certificate:correct"), false, role);
    }
  });

  test("only an administrator corrects a certificate", () => {
    for (const role of APP_ROLES) {
      assert.equal(
        can(role, "certificate:correct"),
        role === "admin",
        role,
      );
    }
  });

  test("the two agency roles differ only in managing users", () => {
    const owner = new Set(capabilitiesFor("agent_owner"));
    const member = new Set(capabilitiesFor("agent_member"));

    const extra = [...owner].filter((capability) => !member.has(capability));
    assert.deepEqual(extra, ["user:manage"]);
    assert.deepEqual(
      [...member].filter((capability) => !owner.has(capability)),
      [],
      "a member can do something an owner cannot",
    );
  });

  test("nobody but an administrator impersonates, changes settings or reads the audit log", () => {
    for (const capability of [
      "impersonate",
      "settings:write",
      "audit:read",
      "pricing:write",
      "job:assign",
    ] as const) {
      for (const role of APP_ROLES) {
        assert.equal(can(role, capability), role === "admin", `${role} / ${capability}`);
      }
    }
  });
});

describe("role classification", () => {
  test("every role is either BSCJ's or an agency's, never both or neither", () => {
    for (const role of APP_ROLES) {
      assert.equal(
        isAgentRole(role) !== isStaffRole(role),
        true,
        `${role} is classified ambiguously`,
      );
    }
    assert.deepEqual([...STAFF_ROLES].sort(), ["admin", "engineer"]);
    assert.deepEqual([...AGENT_ROLES].sort(), ["agent_member", "agent_owner"]);
  });

  test("anything that is not a role is refused", () => {
    for (const role of APP_ROLES) assert.equal(isAppRole(role), true);
    for (const value of ["ADMIN", "agent", "owner", "", null, undefined, 1, {}]) {
      assert.equal(isAppRole(value), false, String(value));
    }
  });
});

describe("asserting a capability", () => {
  test("a permitted action is silent", () => {
    assert.doesNotThrow(() => assertCan("agent_owner", "portfolio:write"));
  });

  test("a refused one names what was refused, for a log", () => {
    assert.throws(
      () => assertCan("engineer", "invoice:read"),
      (error: unknown) => {
        assert.ok(error instanceof NotPermittedError);
        assert.equal(error.role, "engineer");
        assert.equal(error.capability, "invoice:read");
        return true;
      },
    );
  });
});
