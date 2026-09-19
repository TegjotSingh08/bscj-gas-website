import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseOrganisation, parseOwner } from "./validation";
import { scopeFor, canAccessOrganisation } from "@/lib/auth/scope";
import { can } from "@/lib/auth/roles";

/**
 * Agency accounts: what an administrator may type, and what the result may
 * reach.
 *
 * The validation is pure, so it is tested directly. The isolation rules are
 * tested through the scope model, which is what every query actually uses —
 * a test that mocked a database would only prove the mock.
 */

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const VALID_ORG = { name: "Acme Lettings", email: "office@acme.invalid" };
const VALID_OWNER = {
  name: "A Person",
  email: "owner@acme.invalid",
};

describe("opening an agency account", () => {
  test("a name and a contact email are enough", () => {
    // An agency is opened from a phone call. Refusing to record one until
    // somebody has found its company number is how it ends up in a spreadsheet.
    const parsed = parseOrganisation(form(VALID_ORG));
    assert.equal(parsed.ok, true);
  });

  test("a blank optional field stays blank, and is never invented", () => {
    const parsed = parseOrganisation(form(VALID_ORG));
    assert.ok(parsed.ok);
    for (const field of [
      "legalName",
      "companyNumber",
      "phone",
      "billingLine1",
      "billingTown",
      "billingPostcode",
      "notes",
    ] as const) {
      assert.equal(parsed.value[field], null, field);
    }
  });

  test("a name and an email are required", () => {
    const missing = parseOrganisation(form({ name: "A", email: "nope" }));
    assert.equal(missing.ok, false);
    assert.ok(!missing.ok && missing.errors.name);
    assert.ok(!missing.ok && missing.errors.email);
  });

  test("input is normalised server-side, whatever the browser sent", () => {
    const parsed = parseOrganisation(
      form({
        name: "  Acme   Lettings  ",
        email: "  Office@ACME.invalid ",
        companyNumber: " ab123456 ",
        billingPostcode: "wv1  1aa",
      }),
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.value.name, "Acme Lettings");
    assert.equal(parsed.value.email, "office@acme.invalid");
    assert.equal(parsed.value.companyNumber, "AB123456");
    assert.equal(parsed.value.billingPostcode, "WV1 1AA");
  });

  test("an agency landline is kept rather than refused", () => {
    // The mobile rule exists for customers. An office number is not a mobile
    // and rejecting it would refuse a real agency.
    const parsed = parseOrganisation(
      form({ ...VALID_ORG, phone: "01902 123456" }),
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.value.phone, "01902 123456");
  });

  test("absurdly long values are refused rather than truncated", () => {
    const parsed = parseOrganisation(
      form({ ...VALID_ORG, name: "x".repeat(200) }),
    );
    assert.equal(parsed.ok, false);
  });
});

describe("the agency's first user", () => {
  test("a name and an email are enough — there is no password to set", () => {
    const parsed = parseOwner(form(VALID_OWNER));
    assert.equal(parsed.ok, true);
  });

  test("the email is normalised the same way sign-in normalises it", () => {
    // Or the account could be created under an address nobody can sign in with
    // — and, now, under an address the invitation would never reach.
    const parsed = parseOwner(
      form({ ...VALID_OWNER, email: "  Owner@ACME.Invalid  " }),
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.value.email, "owner@acme.invalid");
  });

  test("a password submitted anyway is ignored, not honoured", () => {
    /*
      The form no longer offers the field, but a server action is a public
      endpoint and anyone can post whatever they like at it. The parser must
      **drop** an unexpected password rather than carry it through to a place
      that might one day hash it — which would quietly restore the flow this
      milestone removed, with no field on screen to show it.
    */
    const parsed = parseOwner(
      form({ ...VALID_OWNER, password: "smuggled-in-anyway" }),
    );
    assert.ok(parsed.ok);
    assert.deepEqual(Object.keys(parsed.value).sort(), ["email", "name"]);
  });
});

describe("one agency cannot reach another", () => {
  const ACME = "11111111-1111-4111-8111-111111111111";
  const RIVAL = "22222222-2222-4222-8222-222222222222";

  const acmeOwner = scopeFor({
    id: "u1",
    role: "agent_owner",
    agentOrganisationId: ACME,
  });
  const acmeMember = scopeFor({
    id: "u2",
    role: "agent_member",
    agentOrganisationId: ACME,
  });

  test("an owner reaches their own organisation and no other", () => {
    assert.equal(canAccessOrganisation(acmeOwner, ACME), true);
    assert.equal(canAccessOrganisation(acmeOwner, RIVAL), false);
  });

  test("a member is confined identically — the roles differ only in management rights", () => {
    assert.equal(canAccessOrganisation(acmeMember, ACME), true);
    assert.equal(canAccessOrganisation(acmeMember, RIVAL), false);
  });

  test("knowing another agency's id changes nothing", () => {
    /*
      The URL-manipulation case. The scope is built from the session's user
      row, so an id typed into an address bar is only ever the *subject* of a
      check, never the authority for one.
    */
    for (const scope of [acmeOwner, acmeMember]) {
      assert.equal(canAccessOrganisation(scope, RIVAL), false);
    }
  });

  test("consumer records stay out of every agency's reach", () => {
    // A website booking has no organisation. If null matched an agency scope,
    // the null case would become a pool every agency could read.
    assert.equal(canAccessOrganisation(acmeOwner, null), false);
    assert.equal(canAccessOrganisation(acmeMember, null), false);
  });

  test("an administrator stays cross-organisation, including consumer work", () => {
    const admin = scopeFor({ id: "a", role: "admin", agentOrganisationId: null });
    for (const organisation of [ACME, RIVAL, null]) {
      assert.equal(canAccessOrganisation(admin, organisation), true);
    }
  });

  test("only an owner may manage the agency's users", () => {
    assert.equal(can("agent_owner", "user:manage"), true);
    assert.equal(can("agent_member", "user:manage"), false);
  });

  test("no agency role can manage accounts, pricing or the audit log", () => {
    for (const role of ["agent_owner", "agent_member"] as const) {
      assert.equal(can(role, "settings:write"), false, role);
      assert.equal(can(role, "pricing:write"), false, role);
      assert.equal(can(role, "audit:read"), false, role);
      assert.equal(can(role, "impersonate"), false, role);
    }
  });
});

describe("suspension actually locks people out", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "src/lib/auth/app-user.ts"),
    "utf8",
  );

  test("both sign-in and every later request go through the same check", () => {
    /*
      `authenticateUser` and `currentIdentity` both map their row through
      `toIdentity`. One shared check is what stops "we remembered to refuse a
      suspended agency at sign-in but not on request 2".
    */
    const calls = [...source.matchAll(/return toIdentity\(row\)/g)];
    assert.equal(calls.length, 2, "the two entry points disagree");
  });

  test("a deactivated user is refused", () => {
    assert.match(source, /if \(!user\.isActive\) return null/);
  });

  test("a deactivated organisation refuses its agency users", () => {
    // Suspending an agency has to lock out its people, or "inactive" means
    // nothing.
    assert.match(source, /!organisation\.isActive[\s\S]*return null/);
  });

  test("the check is on the agency role, so staff are unaffected by it", () => {
    assert.match(source, /if \(isAgentRole\(user\.role\)\)/);
  });
});

describe("the admin surface guards itself", () => {
  const pages = [
    "src/app/admin/organisations/page.tsx",
    "src/app/admin/organisations/[id]/page.tsx",
  ];
  const actions = readFileSync(
    path.resolve(process.cwd(), "src/app/admin/organisations/actions.ts"),
    "utf8",
  );

  test("every agency page verifies the session", () => {
    for (const file of pages) {
      const source = readFileSync(path.resolve(process.cwd(), file), "utf8");
      assert.match(source, /requireAdmin\(\)/, file);
      assert.match(source, /index: false/, file);
    }
  });

  test("every server action verifies the session before it reads a field", () => {
    /*
      A server action is a public HTTP endpoint with a generated name. That only
      an admin page renders a form pointing at it protects nothing.
    */
    const bodies = actions.split("export async function").slice(1);
    assert.ok(bodies.length >= 4, "not all actions were found");

    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      const guard = body.indexOf("requireAdmin()");
      const firstRead = body.indexOf("form.get(");

      assert.ok(guard > -1, `${name} does not verify the session`);
      if (firstRead > -1) {
        assert.ok(
          guard < firstRead,
          `${name} reads the form before verifying the session`,
        );
      }
    }
  });

  test("no password or hash is ever selected for display", () => {
    const admin = readFileSync(
      path.resolve(process.cwd(), "src/lib/organisations/admin.ts"),
      "utf8",
    );
    // The user list picks its columns explicitly and omits the hash, so a
    // later change to what the page renders cannot leak one.
    assert.equal(/passwordHash: appUsers\.passwordHash/.test(admin), false);
    assert.equal(/\.select\(\)\s*\.from\(appUsers\)/.test(admin), false);
  });

  test("the audit log records account changes without recording secrets", () => {
    assert.match(actions, /recordAudit/);
    assert.equal(/password/i.test(actions.split("recordAudit")[1] ?? ""), false);
  });

  test("a user can only be suspended within their own organisation", () => {
    const admin = readFileSync(
      path.resolve(process.cwd(), "src/lib/organisations/admin.ts"),
      "utf8",
    );
    // Scoped to the organisation as well as the id, so a mistyped user id
    // cannot deactivate somebody in another agency — or a member of staff.
    assert.match(admin, /eq\(appUsers\.agentOrganisationId, organisationId\)/);
  });
});
