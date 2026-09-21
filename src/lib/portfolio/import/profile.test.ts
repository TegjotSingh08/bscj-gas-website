import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PROFILE,
  NEW_PROFILE,
  parseProfile,
  parseProfileForm,
  profileDigest,
  PROFILE_VERSION,
  type ImportProfile,
} from "./profile";
import { parseImportRow } from "./rows";

/**
 * One agency's import profile.
 *
 * Fictional throughout. A profile is configuration — the whole point is that
 * adding an agency is data, not a release — so these assert the *rules*, not
 * any particular agency's headings.
 */

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
};

describe("defaults", () => {
  test("an unconfigured agency behaves as the importer always did", () => {
    /*
      No profile means the downloadable template, whose column is headed
      `tenant_name` and documented as the tenant. Treating that as unconfirmed
      would silently stop recording tenancies the importer has always recorded.
    */
    assert.equal(DEFAULT_PROFILE.occupierRole, "tenant");
    assert.equal(DEFAULT_PROFILE.addressMode, "auto");
    assert.equal(DEFAULT_PROFILE.dateOrder, "uk");
    assert.equal(DEFAULT_PROFILE.landlordMatch, "reject_row");
  });

  test("a NEW profile starts from the cautious reading instead", () => {
    // The doubt arises when somebody maps another system's column onto it,
    // which is exactly when a person is looking at a spreadsheet.
    assert.equal(NEW_PROFILE.occupierRole, "unknown");
    assert.equal(NEW_PROFILE.landlordMatch, "reject_row");
  });
});

describe("reading a stored profile", () => {
  test("anything unexpected falls back to the cautious default", () => {
    // It comes from a jsonb column, so it is data, not something to trust.
    for (const bad of [null, "nonsense", 42, { version: 99 }, {}]) {
      assert.deepEqual(parseProfile(bad), DEFAULT_PROFILE);
    }
  });

  test("an unknown option never becomes a more permissive reading", () => {
    const parsed = parseProfile({
      version: PROFILE_VERSION,
      columns: {},
      occupierRole: "whatever",
      landlordMatch: "do_anything",
      addressMode: "magic",
      dateOrder: "guess",
    });
    assert.equal(parsed.occupierRole, "unknown");
    assert.equal(parsed.landlordMatch, "reject_row");
    assert.equal(parsed.addressMode, "auto");
    assert.equal(parsed.dateOrder, "uk");
  });

  test("a profile cannot name a column the code does not define", () => {
    const parsed = parseProfile({
      version: PROFILE_VERSION,
      columns: { landlordName: "Owner", notAColumn: "x", postcode: 42 },
    });
    assert.deepEqual(parsed.columns, { landlordName: "Owner" });
  });
});

describe("what an administrator may submit", () => {
  test("headings and settings are recorded", () => {
    const parsed = parseProfileForm(
      form({
        "column-fullAddress": " Property ",
        "column-landlordName": "Owner",
        occupierRole: "tenant",
        dateOrder: "iso_only",
        notes: "Their export has one address column.",
      }),
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.value.columns.fullAddress, "Property");
    assert.equal(parsed.value.occupierRole, "tenant");
    assert.equal(parsed.value.dateOrder, "iso_only");
    assert.equal(parsed.value.notes, "Their export has one address column.");
  });

  test("an option the code does not define falls back, never through", () => {
    // A server action is a public endpoint; the option sets are code.
    const parsed = parseProfileForm(
      form({ occupierRole: "anything", landlordMatch: "whatever" }),
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.value.occupierRole, "unknown");
    assert.equal(parsed.value.landlordMatch, "reject_row");
  });

  test("a column the code does not define is dropped", () => {
    const parsed = parseProfileForm(form({ "column-notAColumn": "Whatever" }));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.columns, {});
  });

  test("one heading cannot feed two columns", () => {
    /*
      Letting the last one win would put a landlord's phone number in the
      tenant's field, and the import would look perfectly successful.
    */
    const parsed = parseProfileForm(
      form({ "column-landlordPhone": "Phone", "column-tenantPhone": "phone" }),
    );
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && Object.keys(parsed.errors).length === 1);
  });

  test("a blank heading means the export does not have it", () => {
    const parsed = parseProfileForm(
      form({ "column-landlordName": "Owner", "column-tenantName": "   " }),
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.value.columns.tenantName, undefined);
  });
});

describe("the digest is what invalidates an outstanding preview", () => {
  const base: ImportProfile = { ...DEFAULT_PROFILE, columns: { landlordName: "Owner" } };

  test("the same profile digests the same", () => {
    assert.equal(profileDigest(base), profileDigest({ ...base }));
  });

  test("every setting that changes an import changes the digest", () => {
    const moved: Partial<ImportProfile>[] = [
      { occupierRole: "unknown" },
      { addressMode: "combined" },
      { dateOrder: "iso_only" },
      { landlordMatch: "match_existing_by_name" },
      { columns: { landlordName: "Landlord" } },
      { columns: { landlordName: "Owner", tenantName: "Occupier" } },
    ];
    for (const change of moved) {
      assert.notEqual(
        profileDigest({ ...base, ...change }),
        profileDigest(base),
        JSON.stringify(change),
      );
    }
  });

  test("an internal note does not invalidate a live preview", () => {
    // It changes nothing about the import, so tearing up somebody's review
    // over a typo fixed in a note would be gratuitous.
    assert.equal(
      profileDigest({ ...base, notes: "anything", updatedAt: "2026-01-01" }),
      profileDigest(base),
    );
  });

  test("column order does not matter", () => {
    assert.equal(
      profileDigest({ ...base, columns: { landlordName: "Owner", postcode: "PC" } }),
      profileDigest({ ...base, columns: { postcode: "PC", landlordName: "Owner" } }),
    );
  });
});

describe("the settings actually change what a row becomes", () => {
  const sparse = {
    fullAddress: "Flat 2, 14 Fixture Street, Wolverhampton, WV1 1AA",
    landlordName: "A Fixture Landlord",
    landlordEmail: "landlord@fixture.example.invalid",
    landlordPhone: "01902 000001",
    tenantName: "Sam Occupier",
  };

  test("an unconfirmed occupier becomes an access note, not a tenancy", () => {
    /*
      A tenancy asserts somebody lives there and is who we contact to arrange
      access — it is what a scheduling link is sent to. Creating one from a
      column whose meaning nobody confirmed is how a caretaker receives a
      tenant's link.
    */
    const parsed = parseImportRow(sparse, { ...DEFAULT_PROFILE, occupierRole: "unknown" });
    assert.ok(parsed.ok);
    assert.equal(parsed.record.tenancy, null);
    assert.match(parsed.record.property.accessNotes ?? "", /Sam Occupier/);
    assert.match(parsed.record.property.accessNotes ?? "", /not confirmed/i);
  });

  test("a confirmed occupier becomes a tenancy", () => {
    const parsed = parseImportRow(sparse, { ...DEFAULT_PROFILE, occupierRole: "tenant" });
    assert.ok(parsed.ok);
    assert.equal(parsed.record.tenancy?.name, "Sam Occupier");
    assert.equal(parsed.record.property.accessNotes, null);
  });

  test("iso_only refuses a day-first date rather than reading it", () => {
    const withDate = { ...sparse, certificateExpiry: "31/01/2027" };

    const uk = parseImportRow(withDate, { ...DEFAULT_PROFILE, dateOrder: "uk" });
    assert.ok(uk.ok);
    assert.equal(uk.record.compliance?.dueDate, "2027-01-31");

    const iso = parseImportRow(withDate, { ...DEFAULT_PROFILE, dateOrder: "iso_only" });
    assert.equal(iso.ok, false);
    assert.ok(!iso.ok && iso.errors.some((e) => e.column === "certificate_expiry"));
  });

  test("addressMode separate ignores the combined column entirely", () => {
    const parsed = parseImportRow(
      { ...sparse, houseOrName: "9", street: "Other Road", postcode: "WV3 3CC" },
      { ...DEFAULT_PROFILE, addressMode: "separate" },
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.record.property.houseOrName, "9");
    assert.equal(parsed.record.property.postcode, "WV3 3CC");
  });

  test("addressMode combined wins over separate columns", () => {
    const parsed = parseImportRow(
      { ...sparse, houseOrName: "9", street: "Other Road", postcode: "WV3 3CC" },
      { ...DEFAULT_PROFILE, addressMode: "combined" },
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.record.property.houseOrName, "Flat 2, 14");
    assert.equal(parsed.record.property.postcode, "WV1 1AA");
  });
});
