import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  parseCompliance,
  parseLandlord,
  parseProperty,
  parseTenancy,
  propertyKey,
} from "./validation";

/**
 * The portfolio's rules.
 *
 * Validation is pure and tested directly. Isolation is asserted structurally —
 * that no query or mutation can be called without an organisation, and that
 * none of them will take one from a form — because a test that mocked a
 * database would only prove the mock. The behavioural half is proved against
 * the live development database; see `docs/V2_CURRENT_STATE.md`.
 */

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const LANDLORD = {
  name: "A Landlord",
  email: "landlord@example.invalid",
  phone: "07700900123",
};
const PROPERTY = {
  houseOrName: "24",
  street: "Example Road",
  postcode: "wv1 1aa",
};

describe("landlords", () => {
  test("name, email and a number are required", () => {
    assert.equal(parseLandlord(form(LANDLORD)).ok, true);

    const empty = parseLandlord(form({ name: "", email: "", phone: "" }));
    assert.equal(empty.ok, false);
    assert.ok(!empty.ok && empty.errors.name && empty.errors.email && empty.errors.phone);
  });

  test("contact details are normalised the way the rest of the system stores them", () => {
    const parsed = parseLandlord(
      form({ ...LANDLORD, name: "  A   Landlord ", email: " Landlord@EXAMPLE.invalid " }),
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.value.name, "A Landlord");
    assert.equal(parsed.value.email, "landlord@example.invalid");
    assert.equal(parsed.value.phone, "+447700900123");
  });

  test("a landlord's landline is kept rather than refused", () => {
    // The mobile rule was written for customers. Refusing a real office number
    // would stop an agency recording their own client.
    const parsed = parseLandlord(form({ ...LANDLORD, phone: "01902 123456" }));
    assert.ok(parsed.ok);
    assert.equal(parsed.value.phone, "01902 123456");
  });
});

describe("properties", () => {
  test("an address and a real-shaped postcode are required", () => {
    assert.equal(parseProperty(form(PROPERTY)).ok, true);

    const bad = parseProperty(form({ ...PROPERTY, postcode: "not a postcode" }));
    assert.equal(bad.ok, false);
    assert.ok(!bad.ok && bad.errors.postcode);
  });

  test("the postcode is stored canonically", () => {
    const parsed = parseProperty(form(PROPERTY));
    assert.ok(parsed.ok);
    assert.equal(parsed.value.postcode, "WV1 1AA");
  });

  test("coverage is not checked, because an agency portfolio is wider than the booking radius", () => {
    /*
      The twelve-mile radius decides what the public site will take an online
      booking for. It is not a rule about what BSCJ will do for a managed
      agency, and refusing an out-of-area property here would refuse real work
      the business already does.
    */
    const birmingham = parseProperty(form({ ...PROPERTY, postcode: "B1 1AA" }));
    assert.equal(birmingham.ok, true);
  });

  test("the duplicate key ignores case and spacing", () => {
    // "Flat 2a" and "FLAT 2A" at "wv11aa" are the same flat.
    assert.equal(
      propertyKey("wv1 1aa", " Flat 2a "),
      propertyKey("WV11AA", "FLAT 2A"),
    );
    assert.notEqual(propertyKey("WV1 1AA", "24"), propertyKey("WV1 1AA", "25"));
  });
});

describe("tenancies", () => {
  test("an empty form is no tenancy, not an empty one", () => {
    // A blank row would assert that somebody lives there and we know who.
    const parsed = parseTenancy(form({}));
    assert.ok(parsed.ok);
    assert.equal(parsed.value, null);
  });

  test("a name alone is enough to record one", () => {
    // An agency often knows who the tenant is before it has their number.
    const parsed = parseTenancy(form({ tenantName: "A Tenant" }));
    assert.ok(parsed.ok);
    assert.equal(parsed.value?.name, "A Tenant");
    assert.equal(parsed.value?.phone, null);
  });

  test("a tenant's number is held to the mobile rule", () => {
    // It is the number a scheduling link is sent to, and a landline cannot
    // receive one.
    const landline = parseTenancy(
      form({ tenantName: "A Tenant", tenantPhone: "01902 123456" }),
    );
    assert.equal(landline.ok, false);
    assert.ok(!landline.ok && landline.errors.tenantPhone);

    const mobile = parseTenancy(
      form({ tenantName: "A Tenant", tenantPhone: "07700 900123" }),
    );
    assert.ok(mobile.ok);
    assert.equal(mobile.value?.phone, "+447700900123");
  });

  test("a malformed start date is refused rather than stored", () => {
    const parsed = parseTenancy(
      form({ tenantName: "A Tenant", tenancyStartedOn: "01/02/2026" }),
    );
    assert.equal(parsed.ok, false);
  });
});

describe("the compliance position a property arrives with", () => {
  test("absent means not known, never compliant and never overdue", () => {
    const parsed = parseCompliance(form({}));
    assert.ok(parsed.ok);
    assert.equal(parsed.value, null);
  });

  test("an expiry date is enough", () => {
    const parsed = parseCompliance(form({ certificateExpiry: "2027-03-01" }));
    assert.ok(parsed.ok);
    assert.equal(parsed.value?.dueDate, "2027-03-01");
    assert.equal(parsed.value?.inspectionDate, null);
  });

  test("an inspection date without an expiry is refused", () => {
    // The expiry is what an agency actually has written down. Deriving it here
    // would apply the renewal rule to a date nobody verified.
    const parsed = parseCompliance(form({ lastInspection: "2026-03-01" }));
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.errors.certificateExpiry);
  });
});

describe("no parser will accept an organisation", () => {
  const validation = readFileSync(
    path.resolve(process.cwd(), "src/lib/portfolio/validation.ts"),
    "utf8",
  );

  test("the word does not appear in any parsed field", () => {
    /*
      Which agency a record belongs to is never a submitted field. A parser
      that read one would be the exact shape of the bug this design exists to
      prevent, so the absence is asserted rather than assumed.
    */
    assert.equal(/form\.get\(\s*["']organisation/i.test(validation), false);
    assert.equal(/agentOrganisationId/.test(validation), false);
  });

  test("an organisation sent in a form is ignored by every parser", () => {
    const hostile = form({
      ...LANDLORD,
      ...PROPERTY,
      organisationId: "22222222-2222-4222-8222-222222222222",
      agentOrganisationId: "22222222-2222-4222-8222-222222222222",
    });

    const landlord = parseLandlord(hostile);
    const property = parseProperty(hostile);
    assert.ok(landlord.ok && property.ok);

    for (const value of [landlord.value, property.value] as Record<string, unknown>[]) {
      assert.equal("organisationId" in value, false);
      assert.equal("agentOrganisationId" in value, false);
    }
  });
});

describe("every portfolio query and mutation is scoped", () => {
  const queries = readFileSync(
    path.resolve(process.cwd(), "src/lib/portfolio/queries.ts"),
    "utf8",
  );
  const mutations = readFileSync(
    path.resolve(process.cwd(), "src/lib/portfolio/mutations.ts"),
    "utf8",
  );

  test("both modules are server-only", () => {
    assert.match(queries, /import "server-only"/);
    assert.match(mutations, /import "server-only"/);
  });

  test("every exported function takes an organisation as its first argument", () => {
    for (const [name, source] of [
      ["queries", queries],
      ["mutations", mutations],
    ] as const) {
      const exported = [
        ...source.matchAll(/export async function (\w+)\(\s*([^),]*)/g),
      ];
      assert.ok(exported.length > 0, `${name} exports nothing to check`);

      for (const [, fn, firstParam] of exported) {
        assert.match(
          firstParam,
          /organisationId/,
          `${name}.${fn} can be called without an organisation`,
        );
      }
    }
  });

  test("every mutation filters or stamps the organisation", () => {
    const bodies = mutations.split("export async function").slice(1);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      assert.match(
        body,
        /agentOrganisationId/,
        `${name} neither filters nor stamps the organisation`,
      );
    }
  });

  test("no query or mutation reads an id from a form", () => {
    for (const source of [queries, mutations]) {
      assert.equal(/form\.get\(/.test(source), false);
      assert.equal(/FormData/.test(source), false);
    }
  });

  test("every portal action verifies the session before reading a field", () => {
    /*
      A server action is a public endpoint with a generated name. That only a
      portal page renders a form pointing at it protects nothing.
    */
    const actions = readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/(portal)/portal/portfolio/actions.ts",
      ),
      "utf8",
    );
    const bodies = actions.split("export async function").slice(1);
    assert.ok(bodies.length >= 6, "not all actions were found");

    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      const guard = body.indexOf("requireAgent()");
      const firstRead = body.indexOf("form.get(");
      const parse = body.search(/parse(Property|Landlord|Tenancy|Compliance)\(/);

      assert.ok(guard > -1, `${name} does not verify the session`);
      if (firstRead > -1) {
        assert.ok(guard < firstRead, `${name} reads the form before the guard`);
      }
      if (parse > -1) {
        assert.ok(guard < parse, `${name} parses before the guard`);
      }
    }
  });

  test("no action passes a client-supplied organisation to a mutation", () => {
    const actions = readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/(portal)/portal/portfolio/actions.ts",
      ),
      "utf8",
    );
    // The only organisation any mutation may receive is the session's.
    const passed = [...actions.matchAll(/\n\s*(\w*[Oo]rganisation\w*),?\n/g)].map(
      (match) => match[1],
    );
    for (const value of passed) {
      assert.equal(
        value.startsWith("session.organisationId") || value === "",
        true,
        `an organisation other than the session's is passed: ${value}`,
      );
    }
    assert.match(actions, /session\.organisationId/);
    assert.equal(/form\.get\(["']organisationId["']\)/.test(actions), false);
  });
});

describe("the duplicate-property guarantee", () => {
  test("the application checks before it inserts", () => {
    const mutations = readFileSync(
      path.resolve(process.cwd(), "src/lib/portfolio/mutations.ts"),
      "utf8",
    );
    assert.match(mutations, /findDuplicateProperty\(/);
    assert.match(mutations, /status: "duplicate"/);
  });

  test("a unique index is the backstop for two submissions racing", () => {
    /*
      A check before an insert catches the ordinary case. Two submissions that
      both see "not there" both write, and only the database can refuse that.
    */
    const migration = readFileSync(
      path.resolve(process.cwd(), "drizzle/0002_property_uniqueness.sql"),
      "utf8",
    );
    assert.match(migration, /CREATE UNIQUE INDEX/);
    assert.match(migration, /lower\("house_or_name"\)/);
    // Partial, so consumer bookings — which have no organisation — are exempt.
    assert.match(migration, /WHERE "agent_organisation_id" IS NOT NULL/);
  });

  test("a unique violation is reported as a duplicate, not as a failure", () => {
    const mutations = readFileSync(
      path.resolve(process.cwd(), "src/lib/portfolio/mutations.ts"),
      "utf8",
    );
    assert.match(mutations, /23505/);
  });
});
