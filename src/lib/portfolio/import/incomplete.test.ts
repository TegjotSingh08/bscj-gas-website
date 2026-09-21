import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildImportPlan } from "./plan";
import { DEFAULT_PROFILE } from "./profile";
import type { ExistingProperty, NameMatch } from "./lookup";
import type { RowValues } from "./rows";

/**
 * Importing a portfolio whose landlords have no contact details.
 *
 * Isolated fixtures: every case is a plain object. No database is touched, and
 * migration 0008 is **not applied anywhere** — these prove the rules that
 * decide what would be written.
 */

const ROW: RowValues = {
  houseOrName: "14",
  street: "Fixture Street",
  postcode: "WV1 1AA",
  landlordName: "Ada Fixture",
};

const row = (line: number, overrides: RowValues = {}) => ({
  line,
  values: { ...ROW, ...overrides },
});

const plan = (
  rows: { line: number; values: RowValues }[],
  options: {
    held?: ExistingProperty[];
    emails?: string[];
    byName?: Record<string, NameMatch>;
    landlordMatch?: "reject_row" | "match_existing_by_name";
  } = {},
) =>
  buildImportPlan({
    rows,
    existing: new Map((options.held ?? []).map((p) => [p.key, p])),
    existingLandlordEmails: new Set(options.emails ?? []),
    landlordsByName: options.byName
      ? new Map(Object.entries(options.byName))
      : undefined,
    profile: {
      ...DEFAULT_PROFILE,
      landlordMatch: options.landlordMatch ?? "reject_row",
    },
  });

describe("a first import with names but no contact details", () => {
  test("a property with a named owner and no contact is importable", () => {
    /*
      The whole point. Before this, `customer.email` and `customer.phone` were
      NOT NULL, so such a row could not be recorded at all — the only ways
      through were inventing a contact or refusing the portfolio.
    */
    const result = plan([row(2)]);
    assert.equal(result.counts.create, 1);
    assert.equal(result.counts.error, 0);
    assert.equal(result.rows[0].record?.landlord.name, "Ada Fixture");
    assert.equal(result.rows[0].record?.landlord.email, null);
    assert.equal(result.rows[0].record?.landlord.phone, null);
  });

  test("a row with no owner at all stays unresolved", () => {
    // Ownership unknown is not the same as contact unknown. A property still
    // belongs to an identified owner; there is no placeholder landlord.
    const result = plan([row(2, { landlordName: "" })]);
    assert.equal(result.counts.error, 1);
    assert.ok(
      result.rows[0].errors?.some((e) => e.column === "landlord_name"),
    );
  });

  test("a malformed address is still refused, blank is not", () => {
    // "Not known" and "wrong" are different answers.
    assert.equal(plan([row(2, { landlordEmail: "   " })]).counts.create, 1);
    assert.equal(plan([row(2, { landlordEmail: "nonsense" })]).counts.error, 1);
  });

  test("a contactless row is never reported as a landlord already on file", () => {
    /*
      That claim would be about whichever landlord was created first. Two
      landlords with no email are two landlords.
    */
    const result = plan([row(2)], { emails: ["someone@fixture.example.invalid"] });
    assert.equal(result.rows[0].landlordExisting, false);
  });
});

describe("two contactless landlords are two landlords", () => {
  test("different names in one file do not collapse into one", () => {
    const result = plan([
      row(2, { landlordName: "Ada Fixture", houseOrName: "14" }),
      row(3, { landlordName: "Ben Fixture", houseOrName: "16" }),
    ]);
    assert.equal(result.counts.create, 2);
    assert.notEqual(
      result.rows[0].record?.landlord.name,
      result.rows[1].record?.landlord.name,
    );
    // Neither carries a contact that could make them compare equal.
    assert.equal(result.rows[0].record?.landlord.email, null);
    assert.equal(result.rows[1].record?.landlord.email, null);
  });
});

describe("matching a contactless landlord by name", () => {
  /*
    Only the lookup itself is covered here — whether a name is consulted at
    all, and what an ambiguous one does. **What a match may then be used for**
    is `identity.test.ts`: a unique name is a suggestion requiring an explicit
    choice, never an attachment.
  */
  test("off by default — a name alone does not establish identity", () => {
    const result = plan([row(2)], {
      byName: { "ada fixture": { outcome: "one", id: "c-1", name: "Ada Fixture" } },
    });
    assert.equal(result.rows[0].landlordMatch, undefined);
    assert.equal(result.rows[0].suggestedLandlordId, undefined);
  });

  test("exactly one match is suggested, and the row waits for a person", () => {
    const result = plan([row(2)], {
      landlordMatch: "match_existing_by_name",
      byName: { "ada fixture": { outcome: "one", id: "c-1", name: "Ada Fixture" } },
    });
    assert.equal(result.counts.create, 1);
    assert.equal(result.rows[0].landlordMatch, "one");
    assert.equal(result.rows[0].suggestedLandlordId, "c-1");
    assert.equal(result.rows[0].landlordChoiceRequired, true);
    // A name match is not "already on file". That claim needs an address.
    assert.equal(result.rows[0].landlordExisting, false);
  });

  test("AMBIGUOUS holds the row and says how to resolve it", () => {
    /*
      Silently attaching a property to whichever J. Smith came first puts it —
      and eventually an invoice — in front of the wrong person, and nothing
      downstream would notice.
    */
    const result = plan([row(2)], {
      landlordMatch: "match_existing_by_name",
      byName: { "ada fixture": { outcome: "ambiguous", count: 2 } },
    });
    assert.equal(result.counts.error, 1);
    assert.equal(result.counts.create, 0);
    const message = result.rows[0].errors?.[0]?.message ?? "";
    assert.match(message, /more than one landlord/i);
    assert.match(message, /add an email/i);
  });

  test("no match creates a new contactless landlord, which is what the file says", () => {
    const result = plan([row(2)], {
      landlordMatch: "match_existing_by_name",
      byName: { "ada fixture": { outcome: "none" } },
    });
    assert.equal(result.counts.create, 1);
    assert.equal(result.rows[0].suggestedLandlordId, undefined);
    assert.equal(result.rows[0].landlordChoiceRequired, undefined);
  });

  test("a row that HAS an email never uses the weaker name match", () => {
    // An address is stronger evidence. Name matching exists only for rows
    // that carry nothing else.
    const result = plan([row(2, { landlordEmail: "ada@fixture.example.invalid" })], {
      landlordMatch: "match_existing_by_name",
      byName: { "ada fixture": { outcome: "ambiguous", count: 2 } },
    });
    assert.equal(result.counts.create, 1);
    assert.equal(result.rows[0].landlordMatch, undefined);
  });

  test("names are compared ignoring case and spacing", () => {
    const result = plan([row(2, { landlordName: "  ADA   FIXTURE " })], {
      landlordMatch: "match_existing_by_name",
      byName: { "ada fixture": { outcome: "one", id: "c-1", name: "Ada Fixture" } },
    });
    assert.equal(result.rows[0].suggestedLandlordId, "c-1");
  });
});

describe("repeat-import safety is unchanged", () => {
  const held = (): ExistingProperty => ({
    id: "p-1",
    key: "WV1 1AA|14",
    houseOrName: "14",
    street: "Fixture Street",
    town: null,
    postcode: "WV1 1AA",
    landlordId: "c-1",
    landlordName: "Ada Fixture",
    landlordEmail: null,
    landlordPhone: null,
    landlordCompany: null,
    tenancyId: null,
    tenantName: null,
    tenantEmail: null,
    tenantPhone: null,
    dueDate: null,
    inspectionDate: null,
  });

  test("re-importing the same contactless row creates nothing", () => {
    const result = plan([row(2)], { held: [held()] });
    assert.equal(result.counts.unchanged, 1);
    assert.equal(result.counts.create, 0);
    assert.equal(result.wouldWrite, 0);
  });

  test("a contactless landlord on file is not a conflict with a contactless row", () => {
    // Both sides say "not known". That is agreement, not a difference.
    const result = plan([row(2)], { held: [held()] });
    assert.equal(result.counts.conflict, 0);
  });

  test("a row that now HAS an email is a reviewable difference, not a silent write", () => {
    const result = plan([row(2, { landlordEmail: "ada@fixture.example.invalid" })], {
      held: [held()],
    });
    assert.equal(result.counts.conflict, 1);
    /*
      Reported, and **not** offered for applying: there is no email on the
      record's side, so nothing establishes that this is the same landlord.
      The preview says so rather than promising a write the commit would skip.
    */
    assert.equal(result.rows[0].conflicts?.[0]?.applicable, false);
    assert.equal(result.wouldWrite, 0);
  });

  test("the same address twice in one file is still one property", () => {
    const result = plan([row(2), row(3)]);
    assert.equal(result.counts.create, 1);
    assert.equal(result.counts.duplicate_in_file, 1);
  });
});
