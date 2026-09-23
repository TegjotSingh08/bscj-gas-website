import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CERTIFICATE_DRAFT_APPLIANCE_COLUMNS,
  CERTIFICATE_DRAFT_APPLIANCE_ROWS,
  CERTIFICATE_DRAFT_FIELDS,
  CERTIFICATE_DRAFT_MAX_FIELD_LENGTH,
  CERTIFICATE_DRAFT_STATIC_FIELDS,
  CERTIFICATE_OUTCOME_FIELDS,
  describeIncompleteDraft,
  sanitiseDraftFields,
  unassessedOutcomes,
} from "./certificate-draft-fields";

/**
 * The contract between the server's idea of a draft and the generator's.
 *
 * A draft is stored as the generator's own flat `{ elementId: value }` map, so
 * the two have to agree on what those ids are. They are in different
 * languages, in different files, and nothing but a test can keep them in step
 * — which is why this reads the generator's markup rather than a copy of it.
 */

const GENERATOR = readFileSync(
  path.resolve(process.cwd(), "vendor/cp12-generator/index.html"),
  "utf8",
);

/** Every form control inside `#sheet`, which is exactly what a draft is. */
function sheetFieldIds(): string[] {
  const start = GENERATOR.indexOf('<div class="sheet" id="sheet">');
  const end = GENERATOR.indexOf('<div class="modal-overlay" id="landlordModal">');
  assert.ok(start > 0 && end > start, "the sheet was found in the generator");

  const sheet = GENERATOR.slice(start, end);
  return [
    ...sheet.matchAll(/<(?:input|select|textarea)[^>]*\bid="([^"]+)"/g),
  ].map((match) => match[1]);
}

describe("the generator is a working document, not just the right text", () => {
  /*
    **Why this is worth asserting.** An HTML comment that is opened and never
    closed swallows everything after it as far as the next `-->`. The file
    still loads, the sheet still renders, every field this suite checks is
    still present in the markup — and the generator's entire `<script>` is
    inert inside a comment node, which is a silent, total failure that reads
    as a page with no JavaScript rather than as an error.

    It happened once, while the signature boxes were being added. It cost an
    afternoon to find. It never gets to happen twice.
  */
  const withoutComments = GENERATOR.replace(/<!--[\s\S]*?-->/g, "");

  test("no comment is left open", () => {
    assert.equal(
      withoutComments.includes("<!--"),
      false,
      "an unclosed comment would swallow the rest of the file",
    );
  });

  test("the script tags are real elements, not comment text", () => {
    /* The two libraries, and the generator's own inline script. */
    assert.equal((withoutComments.match(/<script/g) ?? []).length, 3);
    assert.ok(
      withoutComments.includes("connectedBoot()"),
      "connected mode is inside a live script",
    );
  });

  test("the signature pad is markup the page will actually build", () => {
    assert.ok(withoutComments.includes('id="signaturePad"'));
    assert.ok(withoutComments.includes('id="sigImgIssued"'));
    assert.ok(withoutComments.includes('id="sigImgReceived"'));
    assert.ok(withoutComments.includes('data-sign="issued"'));
    assert.ok(withoutComments.includes('data-sign="received"'));
  });

  test("the signature pad is outside the sheet, so it cannot become a field", () => {
    const sheetStart = withoutComments.indexOf('<div class="sheet" id="sheet">');
    const sheetEnd = withoutComments.indexOf(
      '<div class="modal-overlay" id="signatureModal">',
    );
    assert.ok(sheetStart > 0 && sheetEnd > sheetStart);
    assert.equal(
      withoutComments.slice(sheetStart, sheetEnd).includes("<canvas"),
      false,
      "nothing `collectSheet()` walks may be a drawing surface",
    );
  });

  test("the PDF clone strips the signature controls", () => {
    /*
      `.sig-actions` holds the Sign and Clear buttons. They are screen
      affordances; a certificate with "Sign" printed next to the signature
      would be a different document from the one the office has always had.
    */
    assert.ok(
      /clone\.querySelectorAll\('button, \.landlord-select-line, \.sig-actions'\)/.test(
        withoutComments,
      ),
    );
  });
});

describe("the draft's field list and the generator's sheet", () => {
  test("every static box on the sheet is a field the server will store", () => {
    /*
      A field added to the sheet and not here would be typed by an engineer,
      saved by the generator, dropped silently by the server, and gone when
      they came back to it. That is the failure this catches.
    */
    for (const id of sheetFieldIds()) {
      assert.ok(
        (CERTIFICATE_DRAFT_STATIC_FIELDS as readonly string[]).includes(id),
        `${id} is on the sheet but the server would drop it from a draft`,
      );
    }
  });

  test("and the server names no static field the sheet does not have", () => {
    const onSheet = new Set(sheetFieldIds());
    for (const id of CERTIFICATE_DRAFT_STATIC_FIELDS) {
      assert.ok(onSheet.has(id), `${id} is allowed but is not on the sheet`);
    }
  });

  test("the appliance table's shape matches the generator's", () => {
    const rows = GENERATOR.match(/const APPLIANCE_ROWS = (\d+);/);
    assert.ok(rows, "the generator declares its row count");
    assert.equal(Number(rows[1]), CERTIFICATE_DRAFT_APPLIANCE_ROWS);

    const columns = [...GENERATOR.matchAll(/\{key:'([A-Za-z0-9]+)',\s*label:/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      columns,
      [...CERTIFICATE_DRAFT_APPLIANCE_COLUMNS],
      "the appliance columns are the ones the server will store",
    );
  });

  test("the six safety outcomes are the generator's six", () => {
    const declared = GENERATOR.match(/const OUTCOME_IDS = \[([^\]]+)\]/);
    assert.ok(declared, "the generator declares its outcomes");
    const ids = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(ids, [...CERTIFICATE_OUTCOME_FIELDS]);
  });

  test("a full sheet is 31 boxes plus six rows of twenty-one", () => {
    assert.equal(
      CERTIFICATE_DRAFT_FIELDS.length,
      CERTIFICATE_DRAFT_STATIC_FIELDS.length +
        CERTIFICATE_DRAFT_APPLIANCE_ROWS *
          CERTIFICATE_DRAFT_APPLIANCE_COLUMNS.length,
    );
  });
});

describe("what the server will accept into a draft", () => {
  test("an unknown key is dropped rather than stored", () => {
    /*
      The endpoint takes JSON from a browser. Without this it would be an
      authenticated blob store attached to a job.
    */
    const fields = sanitiseDraftFields({
      certNo: "TEST-NOT-VALID-0001",
      somethingElse: "x",
      __proto__: "no",
      "app_1_location": "Kitchen",
      "app_9_location": "Out of range",
    });
    assert.deepEqual(fields, {
      certNo: "TEST-NOT-VALID-0001",
      app_1_location: "Kitchen",
    });
  });

  test("a non-string value is dropped, whatever it is", () => {
    const fields = sanitiseDraftFields({
      certNo: 12345,
      defects: null,
      comments: { nested: true },
      instEngineer: ["a"],
      jobName: "Fixture Property",
    });
    assert.deepEqual(fields, { jobName: "Fixture Property" });
  });

  test("a very long value is capped rather than refusing the whole save", () => {
    const fields = sanitiseDraftFields({ comments: "x".repeat(50_000) });
    assert.equal(
      fields.comments.length,
      CERTIFICATE_DRAFT_MAX_FIELD_LENGTH,
      "an engineer who typed a long note keeps the save",
    );
  });

  test("nothing at all is an empty draft, not a crash", () => {
    assert.deepEqual(sanitiseDraftFields(null), {});
    assert.deepEqual(sanitiseDraftFields("a string"), {});
    assert.deepEqual(sanitiseDraftFields([1, 2, 3]), {});
    assert.deepEqual(sanitiseDraftFields(undefined), {});
  });
});

describe("whether a record is finished", () => {
  const complete = {
    certNo: "TEST-NOT-VALID-0001",
    instEngineer: "Fixture Engineer",
    jobAddress: "14 Fixture Street, Wolverhampton",
    sigDate: "20/09/2026",
    issuedPrintName: "Fixture Engineer",
    app_1_location: "Kitchen",
    coFitted: "yes",
    coTested: "yes",
    chkEmergency: "yes",
    chkTightness: "yes",
    chkPipework: "yes",
    chkBonding: "yes",
  };

  test("a complete record has nothing missing", () => {
    assert.deepEqual(describeIncompleteDraft(complete), []);
  });

  test("an unassessed outcome is named, and is not assumed satisfactory", () => {
    /*
      The point of the whole outcomes change: a blank is a blank. Nothing here
      decides what the answer should be — only that there has to be one.
    */
    const missing = describeIncompleteDraft({ ...complete, chkTightness: "" });
    assert.equal(missing.length, 1);
    assert.match(missing[0], /Gas tightness/);
    assert.deepEqual(unassessedOutcomes({ ...complete, chkTightness: "" }), [
      "chkTightness",
    ]);
  });

  test("a record with no appliance row at all is not finished", () => {
    const withoutAppliance = { ...complete, app_1_location: "" };
    assert.ok(
      describeIncompleteDraft(withoutAppliance).includes(
        "At least one appliance row",
      ),
    );
  });

  test("any one appliance column counts as a row", () => {
    const rest = { ...complete, app_1_location: "" };
    assert.deepEqual(describeIncompleteDraft({ ...rest, app_4_make: "Fixture" }), []);
  });

  test("the administrative essentials are each named when absent", () => {
    for (const [field, label] of [
      ["certNo", "Certificate number"],
      ["instEngineer", "Engineer name"],
      ["jobAddress", "Property address"],
      ["sigDate", "Inspection date"],
      ["issuedPrintName", "Issued by (print name)"],
    ] as const) {
      const missing = describeIncompleteDraft({ ...complete, [field]: "   " });
      assert.ok(
        missing.includes(label),
        `${field} blank should report "${label}", got ${JSON.stringify(missing)}`,
      );
    }
  });

  test("it asks for nothing the application could not supply", () => {
    /*
      `landlordAddress`, `landlordPostcode` and `instIdCard` are the three
      fields the prefill mapping documents as unavailable. Requiring one here
      would make every connected submission impossible until somebody typed a
      value the application has no way to check.
    */
    const missing = describeIncompleteDraft(complete);
    for (const id of ["landlordAddress", "landlordPostcode", "instIdCard"]) {
      assert.ok(!missing.some((m) => m.toLowerCase().includes(id.toLowerCase())));
    }
  });
});
