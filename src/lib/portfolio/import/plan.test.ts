import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { buildImportPlan, fingerprintOf } from "./plan";
import type { ExistingProperty } from "./lookup";
import { parseImportRow, type RowValues } from "./rows";

/**
 * What an import would do, decided before it does any of it.
 *
 * Pure throughout: the plan takes the file and a snapshot of what exists, so
 * every rule about what an import *means* is provable without a database.
 */

const ROW: RowValues = {
  houseOrName: "14",
  street: "Example Street",
  postcode: "WV1 1AA",
  landlordName: "A Landlord",
  landlordEmail: "landlord@example.invalid",
  landlordPhone: "01902 000000",
};

const row = (line: number, overrides: RowValues = {}) => ({
  line,
  values: { ...ROW, ...overrides },
});

const existing = (overrides: Partial<ExistingProperty> = {}): ExistingProperty => ({
  id: "p1",
  key: "WV1 1AA|14",
  houseOrName: "14",
  street: "Example Street",
  town: null,
  postcode: "WV1 1AA",
  landlordId: "c1",
  landlordName: "A Landlord",
  landlordEmail: "landlord@example.invalid",
  landlordPhone: "+441902000000",
  landlordCompany: null,
  tenancyId: null,
  tenantName: null,
  tenantEmail: null,
  tenantPhone: null,
  dueDate: null,
  inspectionDate: null,
  ...overrides,
});

const plan = (
  rows: { line: number; values: RowValues }[],
  held: ExistingProperty[] = [],
  landlordEmails: string[] = [],
) =>
  buildImportPlan({
    rows,
    existing: new Map(held.map((property) => [property.key, property])),
    existingLandlordEmails: new Set(landlordEmails),
  });

describe("a row becomes a record, by the same rules as the manual form", () => {
  test("a minimal valid row parses", () => {
    const parsed = parseImportRow(ROW);
    assert.ok(parsed.ok);
    assert.equal(parsed.record.property.postcode, "WV1 1AA");
    assert.equal(parsed.record.landlord.email, "landlord@example.invalid");
    // No tenant columns and no dates: both absent rather than empty.
    assert.equal(parsed.record.tenancy, null);
    assert.equal(parsed.record.compliance, null);
  });

  test("every missing required column is named, not just the first", () => {
    // An agent fixing a spreadsheet wants one pass with all the problems on
    // it, not five uploads that each reveal one more.
    const parsed = parseImportRow({ street: "Example Street" });
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.errors.length >= 3);
  });

  test("errors name the spreadsheet column, not a form field", () => {
    const parsed = parseImportRow({ ...ROW, postcode: "not a postcode" });
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.errors.some((e) => e.column === "postcode"));
  });

  test("an ambiguous date fails the row rather than being guessed", () => {
    const parsed = parseImportRow({ ...ROW, certificateExpiry: "01/02/26" });
    assert.equal(parsed.ok, false);
    assert.ok(
      !parsed.ok &&
        parsed.errors.some((e) => e.column === "certificate_expiry"),
    );
  });

  test("a blank certificate expiry is 'not known', never a guessed date", () => {
    const parsed = parseImportRow({ ...ROW, certificateExpiry: "" });
    assert.ok(parsed.ok);
    assert.equal(parsed.record.compliance, null);
  });

  test("a tenant is optional, and a blank one is no tenancy rather than an empty one", () => {
    const withTenant = parseImportRow({
      ...ROW,
      tenantName: "A Tenant",
      tenantEmail: "tenant@example.invalid",
    });
    assert.ok(withTenant.ok);
    assert.equal(withTenant.record.tenancy?.name, "A Tenant");

    const without = parseImportRow(ROW);
    assert.ok(without.ok);
    assert.equal(without.record.tenancy, null);
  });
});

describe("duplicates within one file", () => {
  test("the first wins and the rest are reported", () => {
    const result = plan([row(2), row(3)]);
    assert.equal(result.counts.create, 1);
    assert.equal(result.counts.duplicate_in_file, 1);
    assert.equal(result.rows[1].duplicateOfLine, 2);
  });

  test("matching ignores case and spacing, as the database index does", () => {
    const result = plan([
      row(2, { houseOrName: "Rose Cottage", postcode: "WV1 1AA" }),
      row(3, { houseOrName: "  rose   cottage ", postcode: "wv11aa" }),
    ]);
    assert.equal(result.counts.duplicate_in_file, 1);
  });

  test("two different properties at one postcode are not duplicates", () => {
    const result = plan([row(2, { houseOrName: "14" }), row(3, { houseOrName: "16" })]);
    assert.equal(result.counts.create, 2);
    assert.equal(result.counts.duplicate_in_file, 0);
  });
});

describe("properties the agency already holds", () => {
  test("an identical row is 'unchanged' and does nothing", () => {
    const result = plan([row(2)], [existing()]);
    assert.equal(result.counts.unchanged, 1);
    assert.equal(result.wouldWrite, 0);
  });

  test("a new tenant on an empty property is a conflict, not a silent write", () => {
    const result = plan(
      [row(2, { tenantName: "A Tenant", tenantEmail: "tenant@example.invalid" })],
      [existing()],
    );
    assert.equal(result.counts.conflict, 1);
    assert.equal(result.rows[0].conflicts?.[0].field, "Tenant");
  });

  test("a different tenant is a conflict that says it ends the current tenancy", () => {
    const result = plan(
      [row(2, { tenantName: "New Tenant", tenantEmail: "new@example.invalid" })],
      [existing({ tenantName: "Old Tenant", tenantEmail: "old@example.invalid" })],
    );
    const conflict = result.rows[0].conflicts?.find((c) => c.field === "Tenant");
    assert.ok(conflict);
    // "Update" means something specific here, and the agent has to be told it.
    assert.match(conflict.effect, /ends the current tenancy/i);
    assert.match(conflict.effect, /old tenancy is kept/i);
  });

  test("a BLANK tenant column never ends a tenancy", () => {
    /*
      The most destructive thing a spreadsheet could express by accident. An
      omitted column means "this file does not say", not "nobody lives there",
      and reading it as an instruction would erase a real tenancy in bulk.
    */
    const result = plan([row(2)], [existing({ tenantName: "Current Tenant" })]);
    assert.equal(result.counts.unchanged, 1);
    assert.equal(result.counts.conflict, 0);
  });

  test("a different certificate date is a conflict that supersedes, not overwrites", () => {
    const result = plan(
      [row(2, { certificateExpiry: "2027-01-31" })],
      [existing({ dueDate: "2026-11-30" })],
    );
    const conflict = result.rows[0].conflicts?.find(
      (c) => c.field === "Certificate expiry",
    );
    assert.ok(conflict);
    assert.match(conflict.effect, /supersedes/i);
    assert.match(conflict.effect, /history/i);
    // Shown long, so a day/month misread is visible before anything is written.
    assert.equal(conflict.incoming, "31 January 2027");
    assert.equal(conflict.current, "30 November 2026");
  });

  test("a blank certificate column never clears a date already held", () => {
    const result = plan([row(2)], [existing({ dueDate: "2026-11-30" })]);
    assert.equal(result.counts.unchanged, 1);
  });
});

describe("what an import will never do, however the file is written", () => {
  test("moving a property to a different landlord is reported and refused", () => {
    const result = plan(
      [row(2, { landlordEmail: "someone.else@example.invalid" })],
      [existing()],
    );
    const conflict = result.rows[0].conflicts?.find((c) => c.field === "Landlord");
    assert.ok(conflict);
    assert.equal(conflict.applicable, false);
    // Reported, so nothing is silently ignored — but not offered as a choice.
    assert.equal(result.rows[0].conflictsApplicable, false);
  });

  test("changing the street an engineer is sent to is reported and refused", () => {
    const result = plan(
      [row(2, { street: "A Completely Different Road" })],
      [existing()],
    );
    const conflict = result.rows[0].conflicts?.find((c) => c.field === "Street");
    assert.ok(conflict);
    assert.equal(conflict.applicable, false);
  });

  test("landlord details on the same address may be applied", () => {
    const result = plan(
      [row(2, { landlordPhone: "01902 111111" })],
      [existing()],
    );
    assert.equal(result.rows[0].conflictsApplicable, true);
  });

  test("the same number written two ways is not a conflict", () => {
    /*
      The stored form came through the booking normaliser as `+4419…`; the
      spreadsheet has `01902 000000`. They are the same number. Reporting it
      would put a conflict on every row of every import and bury the two that
      matter.
    */
    const result = plan([row(2, { landlordPhone: "01902 000000" })], [
      existing({ landlordPhone: "+441902000000" }),
    ]);
    assert.equal(result.counts.unchanged, 1);
    assert.equal(result.counts.conflict, 0);
  });
});

describe("the headline number never overstates what will happen", () => {
  test("only creations count towards 'would write'", () => {
    // Every conflict defaults to `skip`, so the number an agent reads before
    // ticking anything is exactly what happens if they tick nothing.
    const result = plan(
      [row(2, { houseOrName: "16" }), row(3, { tenantName: "A Tenant" })],
      [existing()],
    );
    assert.equal(result.counts.create, 1);
    assert.equal(result.counts.conflict, 1);
    assert.equal(result.wouldWrite, 1);
  });

  test("an unreadable row is counted and carries its address for the table", () => {
    const result = plan([row(2, { postcode: "nonsense" })]);
    assert.equal(result.counts.error, 1);
    assert.ok(result.rows[0].address.includes("Example Street"));
    assert.equal(result.wouldWrite, 0);
  });

  test("a landlord already on file is marked for reuse, never duplicated", () => {
    const result = plan([row(2)], [], ["landlord@example.invalid"]);
    assert.equal(result.rows[0].landlordExisting, true);
  });
});

describe("importing is record-keeping, not work", () => {
  test("no module in the import path reaches for jobs, the outbox or the calendar", () => {
    /*
      A structural assertion, because the failure it prevents is a *later*
      edit. A file of 200 properties that quietly raised 200 jobs would book
      out the diary for a month and email 200 tenants about visits nobody
      arranged — and every behavioural test here would still pass.
    */
    const directory = path.resolve(process.cwd(), "src/lib/portfolio/import");
    const forbidden = [
      "@/lib/notifications",
      "@/lib/google",
      "@/lib/jobs/create",
      "outboundEmails",
      "schedulingTokens",
      "createJob",
    ];

    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".ts") || name.includes(".test.")) continue;
      const source = readFileSync(path.join(directory, name), "utf8");
      for (const term of forbidden) {
        assert.equal(
          source.includes(term),
          false,
          `${name} reaches for ${term}`,
        );
      }
    }
  });

  test("the portal import action does not raise work either", () => {
    const source = readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/(portal)/portal/portfolio/import/actions.ts",
      ),
      "utf8",
    );
    for (const term of ["@/lib/notifications", "@/lib/google", "createJob"]) {
      assert.equal(source.includes(term), false, term);
    }
  });
});

describe("an approval is for the record the agent actually saw", () => {
  /*
    The defect this closes was real and was found by running the scenario: an
    agent approved "replace Nina with Priya", a colleague changed the tenant to
    Sam in between, and Confirm ended Sam's tenancy under an approval nobody
    had given for Sam. The preview is a snapshot; Confirm happens minutes or
    hours later.

    The fingerprint covers exactly what `conflictsBetween` reads, so anything
    that would have produced a different conflict list changes it — and nothing
    else does.
  */

  test("a conflict row carries the state it was judged against", () => {
    const result = plan(
      [row(2, { tenantName: "New Tenant", tenantEmail: "new@example.invalid" })],
      [existing({ tenantName: "Old Tenant", tenantEmail: "old@example.invalid" })],
    );
    assert.equal(result.rows[0].action, "conflict");
    assert.equal(typeof result.rows[0].observed, "string");
    assert.ok((result.rows[0].observed ?? "").length > 0);
  });

  test("rows that write nothing carry no fingerprint, having judged nothing", () => {
    const created = plan([row(2)]);
    assert.equal(created.rows[0].action, "create");
    assert.equal(created.rows[0].observed, undefined);
  });

  test("every field a conflict is judged on changes the fingerprint", () => {
    const before = fingerprintOf(existing());
    const moved: [string, Parameters<typeof existing>[0]][] = [
      ["a different tenant", { tenantName: "Somebody Else" }],
      ["a tenant's address", { tenantEmail: "else@example.invalid" }],
      ["a tenant's number", { tenantPhone: "07700 900999" }],
      ["a replaced tenancy row", { tenancyId: "t-2" }],
      ["a moved certificate date", { dueDate: "2027-01-31" }],
      ["a different landlord", { landlordEmail: "other@example.invalid" }],
      ["a renamed landlord", { landlordName: "Other Name" }],
      ["a landlord's number", { landlordPhone: "01902 999999" }],
      ["a landlord's company", { landlordCompany: "New Co" }],
      ["a re-parented property", { landlordId: "c-2" }],
      ["a changed street", { street: "Another Road" }],
      ["a recreated property", { id: "p-2" }],
    ];
    for (const [what, change] of moved) {
      assert.notEqual(fingerprintOf(existing(change)), before, what);
    }
  });

  test("a cosmetic reformatting is not somebody's edit", () => {
    /*
      `+441902000000` and `01902 000000` are the same number written by two
      different parts of the system. Treating that as a change would make every
      confirmation fail with "this moved" and teach agents to ignore the
      message that matters.
    */
    assert.equal(
      fingerprintOf(existing({ landlordPhone: "+441902000000" })),
      fingerprintOf(existing({ landlordPhone: "01902 000000" })),
    );
    assert.equal(
      fingerprintOf(existing({ tenantName: "  Tom  Tenant " })),
      fingerprintOf(existing({ tenantName: "tom  tenant" })),
    );
  });

  test("null and empty are the same absence", () => {
    assert.equal(
      fingerprintOf(existing({ tenantName: null, tenantEmail: null })),
      fingerprintOf(existing({ tenantName: "", tenantEmail: "  " })),
    );
  });
});
