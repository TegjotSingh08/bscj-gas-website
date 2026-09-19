import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildCp12Fields,
  buildCp12Payload,
  CP12_PAYLOAD_KIND,
  CP12_PREFILL_FIELDS,
  cp12MissingFields,
  cp12PrefillFilename,
  cp12PropertyLabel,
  type Cp12PrefillFacts,
} from "./cp12-prefill";

/**
 * The prefill is a strict subset, and stays one.
 *
 * Most of what matters about this module is what it refuses to include. A
 * reading, a safety outcome, a signature, a date or a certificate number
 * that reached the payload would be the application asserting something
 * nobody has checked — on a document that says an inspection happened.
 */

const GENERATOR = readFileSync(
  path.resolve(process.cwd(), "vendor/cp12-generator/index.html"),
  "utf8",
);

const facts = (over: Partial<Cp12PrefillFacts> = {}): Cp12PrefillFacts => ({
  reference: "BSCJ-AB1234",
  property: {
    houseOrName: "12 Ash Grove",
    street: "Ash Grove",
    town: "Wolverhampton",
    postcode: "WV1 1AA",
  },
  tenancy: null,
  customer: { name: "A Landlord", company: null, phone: "07700 900001" },
  engineerName: "An Engineer",
  business: {
    displayName: null,
    addressLines: [],
    postcode: null,
    phone: null,
    gasSafeNumber: null,
  },
  ...over,
});

describe("what the payload may never contain", () => {
  const forbidden = [
    // The verdict
    "coFitted",
    "coTested",
    "chkEmergency",
    "chkTightness",
    "chkPipework",
    "chkBonding",
    // The findings
    "defects",
    "labelsIssued",
    "comments",
    // The signatures
    "issuedPrintName",
    "receivedPrintName",
    // The dates and the number
    "sigDate",
    "nextInspection",
    "certNo",
  ];

  test("none of them is on the allow-list", () => {
    for (const id of forbidden) {
      assert.equal(
        (CP12_PREFILL_FIELDS as readonly string[]).includes(id),
        false,
        `${id} is on the allow-list`,
      );
    }
  });

  test("no appliance cell is either", () => {
    // The appliance rows are generated as `a<row>_<key>`; nothing matching
    // that shape may ever be sent.
    for (const id of CP12_PREFILL_FIELDS) {
      assert.equal(/^a\d/.test(id), false, `${id} looks like an appliance cell`);
    }
  });

  test("a built payload contains only allow-listed keys", () => {
    const payload = buildCp12Payload(
      facts({
        tenancy: { name: "A Tenant", phone: "07700 900002" },
        business: {
          displayName: "A Company",
          addressLines: ["1 Street", "A Town"],
          postcode: "WV2 2BB",
          phone: "01902 000000",
          gasSafeNumber: "000000",
        },
      }),
      new Date("2026-09-19T10:00:00Z"),
    );
    for (const key of Object.keys(payload.fields)) {
      assert.ok(
        (CP12_PREFILL_FIELDS as readonly string[]).includes(key),
        `${key} escaped the allow-list`,
      );
    }
  });

  test("the renewal rule is not reachable from here", () => {
    // Deferred deliberately: it is derived from a date the engineer has not
    // confirmed yet, by the one implementation in compliance/renewal.ts.
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/jobs/cp12-prefill.ts"),
      "utf8",
    );
    assert.equal(source.includes("@/lib/compliance/renewal"), false);
    assert.equal(/nextDueDate|RENEWAL_INTERVAL/.test(source), false);
  });
});

describe("the mapping", () => {
  test("the occupier is the tenant when there is one", () => {
    const f = facts({ tenancy: { name: "A Tenant", phone: "07700 900002" } });
    const fields = buildCp12Fields(f);
    assert.equal(fields.jobName, "A Tenant");
    assert.equal(fields.jobTel, "07700 900002");
    // And the landlord block still names the customer.
    assert.equal(fields.landlordName, "A Landlord");
  });

  test("the customer is the occupier when there is no tenancy", () => {
    const fields = buildCp12Fields(facts());
    assert.equal(fields.jobName, "A Landlord");
    assert.equal(fields.jobTel, "07700 900001");
  });

  test("the property address is joined for a textarea", () => {
    assert.equal(
      buildCp12Fields(facts()).jobAddress,
      "12 Ash Grove\nAsh Grove\nWolverhampton",
    );
  });

  test("an agency job never puts the agency on the certificate", () => {
    /*
      The focused party test.

      The sheet's "Customer / Landlord" block names **the party the
      certificate is issued to**. A job routed through a letting agency is
      still the landlord's certificate, and the agency's trading name and
      billing postcode are somebody else's details. An earlier version
      filled the company line from the agency when the customer had none,
      and the postcode line from the agency's *billing* postcode — a finance
      address. Both produced a certificate naming the wrong party.

      The strongest guarantee available is structural: the agency is not in
      `Cp12PrefillFacts` at all, so the mapping cannot reach it however it
      is later edited, and there is no postcode key for it to land in.
    */
    const agencyJob = facts({
      customer: { name: "A Landlord", company: null, phone: "07700 900001" },
    });
    const fields = buildCp12Fields(agencyJob);

    // Only the recorded customer. Nothing is invented to fill the gap.
    assert.equal(fields.landlordName, "A Landlord");
    assert.equal("landlordCompany" in fields, false);

    // No key exists for either address line, so neither can ever be filled.
    for (const id of ["landlordAddress", "landlordPostcode"]) {
      assert.equal(
        (CP12_PREFILL_FIELDS as readonly string[]).includes(id),
        false,
        `${id} is on the allow-list`,
      );
      assert.equal(id in fields, false);
    }

    // And the facts the mapping is given carry no agency to draw on.
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/jobs/cp12-prefill.ts"),
      "utf8",
    );
    const factsType = source.slice(
      source.indexOf("export type Cp12PrefillFacts"),
      source.indexOf("/** Trims, and treats blank as absent"),
    );
    for (const term of ["organisation", "billingPostcode", "agentOrganisation"]) {
      assert.equal(
        factsType.includes(term),
        false,
        `the mapping can still see ${term}`,
      );
    }
  });

  test("the customer's own company is used when they have one", () => {
    assert.equal(
      buildCp12Fields(
        facts({
          customer: { name: "A Landlord", company: "Their Ltd", phone: "1" },
        }),
      ).landlordCompany,
      "Their Ltd",
    );
  });

  test("both customer address lines are reported as needing completion", () => {
    const missing = cp12MissingFields(buildCp12Fields(facts()));
    const address = missing.find((m) => m.id === "landlordAddress");
    const postcode = missing.find((m) => m.id === "landlordPostcode");
    assert.ok(address, "the address is not reported");
    assert.ok(postcode, "the postcode is not reported");
    // And each says why, including that an agency's is not a substitute.
    assert.match(address.reason, /agency/i);
    assert.match(postcode.reason, /agency|billing/i);
  });

  test("an absent value is omitted, not sent as an empty string", () => {
    /*
      An empty string clears a box the engineer may have filled from their own
      saved defaults. An omission leaves it alone. The business settings are
      empty today, so this is the common case rather than the edge one.
    */
    const fields = buildCp12Fields(facts());
    for (const key of ["instCompany", "instAddress", "instPostcode", "instTel"]) {
      assert.equal(key in fields, false, `${key} was sent as a blank`);
    }
  });

  test("whitespace is not a value", () => {
    const fields = buildCp12Fields(
      facts({ engineerName: "   ", customer: { name: "A", company: "  ", phone: "1" } }),
    );
    assert.equal("instEngineer" in fields, false);
    assert.equal("landlordCompany" in fields, false);
  });
});

describe("what the engineer is told is missing", () => {
  test("the four permanent gaps are always reported", () => {
    const missing = cp12MissingFields(buildCp12Fields(facts()));
    const ids = missing.map((m) => m.id);
    for (const id of ["landlordAddress", "instIdCard", "certNo", "sigDate"]) {
      assert.ok(ids.includes(id), `${id} is not reported as missing`);
    }
  });

  test("empty business settings are reported, with a reason", () => {
    const missing = cp12MissingFields(buildCp12Fields(facts()));
    const company = missing.find((m) => m.id === "instCompany");
    assert.ok(company);
    assert.match(company.reason, /business details/i);
  });

  test("a filled business is not reported as missing", () => {
    const missing = cp12MissingFields(
      buildCp12Fields(
        facts({
          business: {
            displayName: "A Company",
            addressLines: ["1 Street"],
            postcode: "WV2 2BB",
            phone: "01902 000000",
            gasSafeNumber: "000000",
          },
        }),
      ),
    );
    assert.equal(missing.some((m) => m.id === "instCompany"), false);
    // The permanent four remain.
    assert.ok(missing.some((m) => m.id === "sigDate"));
  });

  test("every reported gap says what it is and why", () => {
    for (const m of cp12MissingFields(buildCp12Fields(facts()))) {
      assert.ok(m.label.length > 0, m.id);
      assert.ok(m.reason.length > 0, m.id);
    }
  });
});

describe("the download carries nothing private in its name", () => {
  test("the filename is the reference and nothing else", () => {
    assert.equal(cp12PrefillFilename("BSCJ-AB1234"), "BSCJ-AB1234-cp12-details.json");
  });

  test("a reference that is not one cannot become a path", () => {
    assert.equal(cp12PrefillFilename("../../etc/passwd"), "etcpasswd-cp12-details.json");
    assert.equal(cp12PrefillFilename(""), "job-cp12-details.json");
  });

  test("the property label is for the confirmation prompt, not the filename", () => {
    assert.equal(cp12PropertyLabel(facts()), "12 Ash Grove, Ash Grove · WV1 1AA");
    assert.equal(cp12PrefillFilename("BSCJ-AB1234").includes("Ash"), false);
  });
});

/**
 * The two ends of the bridge agree.
 *
 * The generator is plain vendored JavaScript and cannot import from `src`,
 * so the allow-list exists twice. That is tolerable only if a test fails the
 * moment they diverge — otherwise the server starts sending a field the
 * importer silently drops, or worse, the importer starts accepting one the
 * server was never meant to send.
 */
describe("the generator's importer matches this allow-list", () => {
  const listed = GENERATOR.match(/const IMPORT_ALLOWED = \[([\s\S]*?)\];/);

  test("the importer declares an allow-list", () => {
    assert.ok(listed, "IMPORT_ALLOWED was not found in the generator");
  });

  test("it is exactly the same set of ids", () => {
    const ids = [...listed![1].matchAll(/'([a-zA-Z0-9_]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...ids].sort(), [...CP12_PREFILL_FIELDS].sort());
  });

  test("the payload kind and version agree at both ends", () => {
    assert.ok(GENERATOR.includes(`const IMPORT_KIND = '${CP12_PAYLOAD_KIND}'`));
    assert.ok(GENERATOR.includes("const IMPORT_VERSION = 1"));
  });
});

/**
 * The generator's own guarantees.
 *
 * Structural, for the same reason the rest of this suite is: the failure
 * worth preventing is a later edit that quietly restores a default nobody
 * chose, or lets an imported file reach a field it must not.
 */
describe("the copied generator's safety outcomes", () => {
  test("no safety outcome is pre-ticked in the markup", () => {
    // The original shipped six `checked` checkboxes, so a half-finished
    // record asserted six passes.
    for (const id of [
      "coFitted",
      "coTested",
      "chkEmergency",
      "chkTightness",
      "chkPipework",
      "chkBonding",
    ]) {
      assert.equal(
        new RegExp(`id="${id}"[^>]*checked`).test(GENERATOR),
        false,
        `${id} is still pre-ticked`,
      );
      assert.ok(
        new RegExp(`<select class="outcome" id="${id}"`).test(GENERATOR),
        `${id} is not an explicit outcome`,
      );
    }
  });

  test("every outcome offers not-assessed first, and it is the empty value", () => {
    const selects = [...GENERATOR.matchAll(/<select class="outcome" id="(\w+)"[^>]*>([\s\S]*?)<\/select>/g)];
    assert.equal(selects.length, 6);
    for (const [, , options] of selects) {
      assert.match(options, /^<option value="" data-print="NOT ASSESSED">Not assessed<\/option>/);
      for (const value of ["yes", "no"]) {
        assert.ok(options.includes(`value="${value}"`), `missing ${value}`);
      }
    }
  });

  test("Not applicable is offered nowhere, pending a decision", () => {
    /*
      It was briefly offered on "CO Alarm(s) tested and satisfactory", on the
      reasoning that where no alarm is fitted there is nothing to test. That
      reading came from the form's layout, not from an approved
      specification, and it was never confirmed. An unapproved option on a
      safety record is a claim the business has not made, so it is gone.

      The underlying question — what an engineer should record when no alarm
      is fitted — is real and unresolved. It is recorded in the handoff as a
      decision for BSCJ, not settled here.
    */
    const selects = [...GENERATOR.matchAll(/<select class="outcome" id="(\w+)"[^>]*>([\s\S]*?)<\/select>/g)];
    assert.equal(selects.length, 6);
    for (const [, id, options] of selects) {
      assert.equal(
        options.includes('value="na"'),
        false,
        `${id} still offers an unapproved Not applicable`,
      );
      // Three outcomes, and no more.
      assert.equal((options.match(/<option /g) ?? []).length, 3, id);
    }
  });

  test("a draft that recorded the withdrawn option is not reinterpreted", () => {
    // It goes back to Not assessed and the notice says what was stored.
    assert.match(GENERATOR, /data\[id\] === 'na' && OUTCOME_IDS\.includes\(id\)/);
    assert.match(GENERATOR, /'not applicable'/);
  });

  test("no finding is inferred from a legacy checkbox", () => {
    /*
      A draft saved before the outcomes were explicit stored booleans. A
      `true` was the shipped default and means nothing; a `false` was a
      deliberate untick but a two-state control could not say whether it
      meant unsatisfactory, not applicable or not yet done. Both are
      ambiguous, so both must come back as Not assessed.
    */
    const start = GENERATOR.indexOf("function loadDraft()");
    const load = GENERATOR.slice(
      start,
      GENERATOR.indexOf("document.addEventListener('input'", start),
    );
    assert.match(load, /legacyOutcomes\[id\] = data\[id\];/);
    assert.match(load, /el\.value = '';/);
    // The old inference must be gone.
    assert.equal(
      /data\[id\] \? '' : 'no'/.test(GENERATOR),
      false,
      "a legacy false is still being read as a finding",
    );
  });

  test("the original draft is kept, and the engineer is told to reassess", () => {
    assert.match(GENERATOR, /const LEGACY_DRAFT_KEY = 'gascert_draft_pre_outcomes_v1';/);
    assert.match(GENERATOR, /localStorage\.setItem\(LEGACY_DRAFT_KEY, originalDraft\)/);
    assert.match(GENERATOR, /These safety checks need reassessing/);
  });

  test("an unassessed outcome prints as words, not as a blank", () => {
    // A blank in a checkbox column reads as a box somebody dealt with.
    assert.equal((GENERATOR.match(/data-print="NOT ASSESSED"/g) ?? []).length, 6);
    assert.match(GENERATOR, /pv-unassessed/);
  });

  test("an incomplete working copy carries a prominent mark", () => {
    assert.match(GENERATOR, /id="draftBanner"/);
    assert.match(GENERATOR, /DRAFT — INCOMPLETE/);
    // Driven by the outcomes, so it is right whatever route the sheet takes
    // out of the browser — print, print-to-PDF or a screenshot.
    const from = GENERATOR.indexOf("function refreshOutcomeStates()");
    const refresh = GENERATOR.slice(from, GENERATOR.indexOf("\n}", from));
    assert.match(refresh, /banner\.hidden = unassessedOutcomes\(\)\.length === 0;/);
  });

  test("printing is not claimed to be preventable", () => {
    // Ctrl+P, print-to-PDF and a screenshot are all outside the page.
    assert.match(GENERATOR, /Printing is never blocked|cannot be prevented/i);
    assert.match(GENERATOR, /window\.print\(\);/);
  });

  test("export is gated on every outcome being assessed", () => {
    assert.match(GENERATOR, /const unassessed = unassessedOutcomes\(\);/);
    assert.match(GENERATOR, /if\(unassessed\.length\)\{[\s\S]*?return;/);
  });

  test("the draft is saved before the gate, so incomplete work is never lost", () => {
    const fn = GENERATOR.slice(GENERATOR.indexOf("async function downloadPdf()"));
    const body = fn.slice(0, fn.indexOf("const unassessed"));
    assert.match(body, /saveDraft\(\);/, "the gate can discard an unsaved draft");
  });

  test("the certificate still prints a tick, not a select value", () => {
    // The design is preserved: only the way an outcome is chosen changed.
    assert.match(GENERATOR, /dataset\.print/);
    assert.match(GENERATOR, /data-print="✔"/);
  });
});

describe("the copied generator's importer", () => {
  test("it refuses a file that is not ours, or is the wrong version", () => {
    assert.match(GENERATOR, /data\.kind !== IMPORT_KIND/);
    assert.match(GENERATOR, /data\.version !== IMPORT_VERSION/);
  });

  test("it applies only allow-listed ids, iterating the list rather than the file", () => {
    /*
      The direction matters. Looping over the file's keys and skipping
      unknown ones is one forgotten check away from applying everything;
      looping over the allow-list cannot reach a field that is not on it.
    */
    assert.match(GENERATOR, /for\(const id of IMPORT_ALLOWED\)\{/);
  });

  test("it refuses to combine two jobs", () => {
    assert.match(GENERATOR, /function sheetHasInspectionWork\(\)/);
    assert.match(GENERATOR, /newCertificate\(true\);/);
  });

  test("the fresh-draft guard looks at findings, not at prefilled boxes", () => {
    const fn = GENERATOR.slice(
      GENERATOR.indexOf("function sheetHasInspectionWork()"),
      GENERATOR.indexOf("function applyImport("),
    );
    for (const id of ["defects", "comments", "issuedPrintName", "certNo"]) {
      assert.ok(fn.includes(id), `the guard ignores ${id}`);
    }
    assert.ok(fn.includes("OUTCOME_IDS"), "the guard ignores the safety outcomes");
    assert.ok(fn.includes("table.appliance"), "the guard ignores the readings");
    // And it must not treat an imported field as work in progress.
    for (const id of ["jobAddress", "landlordName", "instCompany"]) {
      assert.equal(fn.includes(id), false, `the guard treats ${id} as findings`);
    }
  });
});
