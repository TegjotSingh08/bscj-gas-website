import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  mappingFrom,
  MAPPING_VERSION,
  parseSavedMapping,
  resolveHeaders,
  sameMapping,
} from "./mapping";
import { parseImportRow } from "./rows";

/**
 * Understanding one agency's headings.
 *
 * The fixture below is a **fictional sparse export**: one combined address
 * column, two person-name columns whose roles are not obvious from the
 * heading, a bare "phone", and a date column that could mean several things.
 * That shape is the point — it is what an agency's own system produces, and
 * what the template does not.
 *
 * No real agency's headings are encoded here, and no mapping is presumed for
 * one. Which column means what is a decision for the agency whose export it
 * is, made once in the preview and then remembered.
 */

const SPARSE = [
  "Property",
  "Owner",
  "Owner Email",
  "Phone",
  "Occupier",
  "Cert Due",
  "Ref",
];

describe("resolving headings", () => {
  test("template headings match with no mapping at all", () => {
    const resolved = resolveHeaders({
      headers: ["property_number_or_name", "street", "postcode"],
    });
    assert.equal(resolved.byKey.houseOrName, 0);
    assert.equal(resolved.byKey.street, 1);
    assert.equal(resolved.byKey.postcode, 2);
    assert.equal(resolved.unmapped.length, 0);
    assert.ok(resolved.columns.every((column) => column.via === "template"));
  });

  test("a sparse export leaves the unknown headings reported, not dropped", () => {
    const resolved = resolveHeaders({ headers: SPARSE });
    // "Occupier", "Cert Due" and "Ref" mean nothing to the template. Silently
    // ignoring them is how a hundred tenant records go missing.
    assert.ok(resolved.unmapped.includes("Occupier"));
    assert.ok(resolved.unmapped.includes("Ref"));
  });

  test("a saved mapping teaches it the agency's own words", () => {
    const resolved = resolveHeaders({
      headers: SPARSE,
      saved: {
        fullAddress: "Property",
        landlordName: "Owner",
        landlordEmail: "Owner Email",
        landlordPhone: "Phone",
        tenantName: "Occupier",
        certificateExpiry: "Cert Due",
      },
    });
    assert.equal(resolved.byKey.fullAddress, 0);
    assert.equal(resolved.byKey.tenantName, 4);
    assert.equal(resolved.byKey.certificateExpiry, 5);
    assert.deepEqual(resolved.unmapped, ["Ref"]);
  });

  test("what the agent chose now beats what was saved before", () => {
    /*
      The most recent human decision wins. An agency that realises "Occupier"
      is actually the access contact must be able to say so without first
      unpicking last month's mapping.
    */
    const resolved = resolveHeaders({
      headers: SPARSE,
      saved: { tenantName: "Occupier" },
      chosen: { tenantEmail: "Occupier" },
    });
    assert.equal(resolved.byKey.tenantEmail, 4);
    assert.equal(resolved.byKey.tenantName, undefined);
    assert.equal(resolved.columns[4].via, "chosen");
  });

  test("a saved mapping beats a built-in alias", () => {
    /*
      `notes` is an alias for access notes. An agency that has said their
      `notes` column is something else must not be silently overridden by the
      alias list on the next upload.
    */
    const resolved = resolveHeaders({
      headers: ["notes"],
      saved: { tenancyStartedOn: "notes" },
    });
    assert.equal(resolved.byKey.tenancyStartedOn, 0);
    assert.equal(resolved.byKey.accessNotes, undefined);
  });

  test("case, spacing and underscores do not defeat a mapping", () => {
    const resolved = resolveHeaders({
      headers: ["  OWNER EMAIL  "],
      saved: { landlordEmail: "owner_email" },
    });
    assert.equal(resolved.byKey.landlordEmail, 0);
  });

  test("two headings claiming one column is reported, not picked between", () => {
    // A fault in the file or the mapping. Choosing one at random is the worst
    // available answer.
    const resolved = resolveHeaders({
      headers: ["postcode", "post code"],
    });
    assert.deepEqual(resolved.duplicated, ["postcode"]);
    assert.equal(resolved.byKey.postcode, 0);
  });

  test("a mapping cannot invent a column that does not exist", () => {
    const resolved = resolveHeaders({
      headers: ["Mystery"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      saved: { notARealColumn: "Mystery" } as any,
    });
    assert.equal(resolved.columns[0].key, null);
    assert.deepEqual(resolved.unmapped, ["Mystery"]);
  });
});

describe("remembering it", () => {
  test("what was used is what is saved", () => {
    const resolved = resolveHeaders({
      headers: SPARSE,
      saved: { fullAddress: "Property", landlordName: "Owner" },
    });
    const mapping = mappingFrom(resolved);
    assert.equal(mapping.fullAddress, "Property");
    assert.equal(mapping.landlordName, "Owner");
    // Nothing claimed "Ref", so nothing is remembered about it.
    assert.equal(Object.values(mapping).includes("Ref"), false);
  });

  test("an unchanged mapping is recognised, so the row is not rewritten", () => {
    assert.equal(
      sameMapping({ landlordName: "Owner" }, { landlordName: "  owner  " }),
      true,
    );
    assert.equal(
      sameMapping({ landlordName: "Owner" }, { landlordName: "Landlord" }),
      false,
    );
    assert.equal(sameMapping({ landlordName: "Owner" }, {}), false);
  });

  test("a stored value is read defensively", () => {
    // It comes from a jsonb column, so anything unexpected is "no mapping"
    // rather than something trusted into the import path.
    assert.equal(parseSavedMapping(null), null);
    assert.equal(parseSavedMapping("nonsense"), null);
    assert.equal(parseSavedMapping({ version: 99, columns: {} }), null);
    assert.equal(parseSavedMapping({ version: MAPPING_VERSION }), null);

    const parsed = parseSavedMapping({
      version: MAPPING_VERSION,
      columns: { landlordName: "Owner", notAColumn: "x", postcode: 42 },
      updatedAt: "2026-09-21T00:00:00.000Z",
    });
    assert.ok(parsed);
    assert.deepEqual(parsed.columns, { landlordName: "Owner" });
  });
});

describe("a mapped sparse row parses end to end", () => {
  test("a combined address and mapped names become a real record", () => {
    /*
      The whole point, in one assertion: an export with one address column and
      the agency's own headings produces the same record the template would,
      with the flat identifier intact.
    */
    const parsed = parseImportRow({
      fullAddress: "Flat 2, 14 Fixture Street, Wolverhampton, WV1 1AA",
      landlordName: "A Fixture Landlord",
      landlordEmail: "landlord@fixture.example.invalid",
      landlordPhone: "01902 000001",
    });

    assert.ok(parsed.ok);
    assert.equal(parsed.record.property.houseOrName, "Flat 2, 14");
    assert.equal(parsed.record.property.street, "Fixture Street");
    assert.equal(parsed.record.property.town, "Wolverhampton");
    assert.equal(parsed.record.property.postcode, "WV1 1AA");
  });

  test("separate columns win where both are present", () => {
    // Explicit beats derived: an export carrying both is saying the same thing
    // twice, and the four columns are the unambiguous half.
    const parsed = parseImportRow({
      fullAddress: "Flat 9, 99 Wrong Road, Elsewhere, WV9 9ZZ",
      houseOrName: "14",
      street: "Fixture Street",
      postcode: "WV1 1AA",
      landlordName: "A Fixture Landlord",
      landlordEmail: "landlord@fixture.example.invalid",
      landlordPhone: "01902 000001",
    });
    assert.ok(parsed.ok);
    assert.equal(parsed.record.property.houseOrName, "14");
    assert.equal(parsed.record.property.postcode, "WV1 1AA");
  });

  test("an address it cannot split names the cell, not a column the file lacks", () => {
    /*
      Telling an agent to fix `postcode` when their file has no such column is
      an instruction they cannot follow.
    */
    const parsed = parseImportRow({
      fullAddress: "Flat 2, Fixture Street, Wolverhampton, WV1 1AA",
      landlordName: "A Fixture Landlord",
      landlordEmail: "landlord@fixture.example.invalid",
      landlordPhone: "01902 000001",
    });
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.errors.some((e) => e.column === "full_address"));
    assert.ok(!parsed.ok && !parsed.errors.some((e) => e.column === "postcode"));
  });
});
