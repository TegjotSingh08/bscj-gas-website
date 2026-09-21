import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import type { ExistingProperty } from "./lookup";
import type { ImportEnvelope, PlannedWrite } from "./envelope";
import type { ImportRecord } from "./rows";

/**
 * **Who a landlord is, and what an import is allowed to assume about it.**
 *
 * A unique matching name is evidence. It is not identity: two landlords can
 * share a name and the second may simply not be on file yet. Attaching a
 * property — and the invoices that follow it — to the wrong person of that
 * name puts it in front of a stranger, and nothing downstream would notice.
 *
 * Two halves, and they have to agree:
 *
 * - the **plan**, which may only *suggest*, proved against plain fixtures;
 * - the **commit**, which writes, proved against recording fakes of the four
 *   mutations and the one lookup it uses. A preview promise that the commit
 *   does not keep is the specific defect these close.
 */

// ---------------------------------------------------------------------------
// Recording fakes
// ---------------------------------------------------------------------------

type Call = { name: string; args: unknown[] };

let calls: Call[] = [];
let currentPortfolio: Map<string, ExistingProperty> = new Map();
/** Whether the claim insert wins. A second submission of one plan loses. */
let claimWins = true;

function record(name: string, result: unknown) {
  return async (...args: unknown[]) => {
    calls.push({ name, args });
    return result;
  };
}

const called = (name: string) => calls.filter((call) => call.name === name);

mock.module("../mutations", {
  namedExports: {
    createProperty: record("createProperty", { status: "ok", value: "p-new" }),
    updateLandlord: record("updateLandlord", { status: "ok", value: undefined }),
    replaceTenancy: record("replaceTenancy", { status: "ok", value: undefined }),
    setCompliancePosition: record("setCompliancePosition", {
      status: "ok",
      value: undefined,
    }),
  },
});

mock.module("./lookup", {
  namedExports: {
    lookupExistingByPostcode: async () => currentPortfolio,
  },
});

/** Just enough of Drizzle to claim the import row and record its result. */
function makeDb() {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => (claimWins ? [{ id: "import-1" }] : []),
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => undefined }),
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  };
}

mock.module("@/lib/db/client", {
  namedExports: { getDb: () => makeDb() },
});

const { buildImportPlan, fingerprintOf } = await import("./plan");
const { commitImport } = await import("./commit");
const { DEFAULT_PROFILE } = await import("./profile");
import type { NameMatch } from "./lookup";
import type { RowValues } from "./rows";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    existing: new Map((options.held ?? []).map((property) => [property.key, property])),
    existingLandlordEmails: new Set(options.emails ?? []),
    landlordsByName: options.byName
      ? new Map(Object.entries(options.byName))
      : undefined,
    profile: {
      ...DEFAULT_PROFILE,
      landlordMatch: options.landlordMatch ?? "match_existing_by_name",
    },
  });

const ONE_MATCH: Record<string, NameMatch> = {
  "ada fixture": { outcome: "one", id: "c-held", name: "Ada Fixture" },
};

function heldProperty(overrides: Partial<ExistingProperty> = {}): ExistingProperty {
  return {
    id: "p-1",
    key: "WV1 1AA|14",
    houseOrName: "14",
    street: "Fixture Street",
    town: null,
    postcode: "WV1 1AA",
    landlordId: "c-held",
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
    ...overrides,
  };
}

/** An envelope carrying exactly the writes a plan produced. */
function envelopeOf(writes: PlannedWrite[]): ImportEnvelope {
  return {
    organisationId: "org-1",
    nonce: "nonce",
    issuedAt: Date.now(),
    filename: "portfolio.csv",
    reviewed: writes.length,
    profileDigest: "digest",
    writes,
  };
}

async function commit(
  writes: PlannedWrite[],
  options: {
    resolutions?: Record<number, "skip" | "update">;
    identities?: Record<number, "unanswered" | "existing" | "new">;
  } = {},
) {
  return commitImport({
    organisationId: "org-1",
    actorUserId: "user-1",
    envelope: envelopeOf(writes),
    planDigest: "plan-digest",
    resolutions: new Map(
      Object.entries(options.resolutions ?? {}).map(([line, value]) => [
        Number(line),
        value,
      ]),
    ),
    identities: new Map(
      Object.entries(options.identities ?? {}).map(([line, value]) => [
        Number(line),
        value,
      ]),
    ),
  });
}

const RECORD: ImportRecord = {
  key: "WV1 1AA|14",
  landlord: { name: "Ada Fixture", company: null, email: null, phone: null },
  property: {
    houseOrName: "14",
    street: "Fixture Street",
    town: null,
    postcode: "WV1 1AA",
    accessNotes: null,
  },
  tenancy: null,
  compliance: null,
} as unknown as ImportRecord;

beforeEach(() => {
  calls = [];
  currentPortfolio = new Map();
  claimWins = true;
});

// ---------------------------------------------------------------------------
// The plan may suggest. It may not decide.
// ---------------------------------------------------------------------------

describe("a matching name is a suggestion, not an identity", () => {
  test("exactly one match is offered, and the row is held until somebody chooses", () => {
    const result = plan([row(2)], { byName: ONE_MATCH });

    assert.equal(result.counts.create, 1);
    assert.equal(result.rows[0].landlordMatch, "one");
    assert.equal(result.rows[0].suggestedLandlordId, "c-held");
    assert.equal(result.rows[0].suggestedLandlordName, "Ada Fixture");
    assert.equal(result.rows[0].landlordChoiceRequired, true);
  });

  test("it is not reported as a landlord already on file", () => {
    /*
      `landlordExisting` is the screen's "will be reused" note, and it is only
      ever true for a matching **email**, which identifies a person. Saying it
      for a name match would present the guess as a finding.
    */
    assert.equal(plan([row(2)], { byName: ONE_MATCH }).rows[0].landlordExisting, false);
  });

  test("a matching email needs no choice — an address does identify somebody", () => {
    const result = plan([row(2, { landlordEmail: "ada@fixture.example.invalid" })], {
      emails: ["ada@fixture.example.invalid"],
      byName: ONE_MATCH,
    });

    assert.equal(result.rows[0].landlordExisting, true);
    assert.equal(result.rows[0].landlordChoiceRequired, undefined);
    assert.equal(result.rows[0].suggestedLandlordId, undefined);
    // The weaker name match is never consulted for a row that carries an email.
    assert.equal(result.rows[0].landlordMatch, undefined);
  });

  test("no match needs no choice: a new contactless landlord is what the file says", () => {
    const result = plan([row(2)], { byName: { "ada fixture": { outcome: "none" } } });

    assert.equal(result.counts.create, 1);
    assert.equal(result.rows[0].landlordChoiceRequired, undefined);
    assert.equal(result.rows[0].suggestedLandlordId, undefined);
  });

  test("matching by name stays off unless the profile asks for it", () => {
    const result = plan([row(2)], {
      landlordMatch: "reject_row",
      byName: ONE_MATCH,
    });

    assert.equal(result.rows[0].landlordMatch, undefined);
    assert.equal(result.rows[0].landlordChoiceRequired, undefined);
  });

  test("an ambiguous name holds the row without telling anyone to merge people", () => {
    /*
      Two landlords of one name may be two people. Being told to merge them
      because a spreadsheet repeated a name is advice to destroy a record.
    */
    const result = plan([row(2)], {
      byName: { "ada fixture": { outcome: "ambiguous", count: 2 } },
    });

    assert.equal(result.counts.error, 1);
    assert.equal(result.counts.create, 0);
    const message = result.rows[0].errors?.[0]?.message ?? "";
    assert.match(message, /more than one landlord/i);
    assert.match(message, /add an email/i);
    assert.equal(/merge/i.test(message), false);
  });

  test("names are compared ignoring case and spacing", () => {
    const result = plan([row(2, { landlordName: "  ADA   FIXTURE " })], {
      byName: ONE_MATCH,
    });
    assert.equal(result.rows[0].suggestedLandlordId, "c-held");
  });
});

// ---------------------------------------------------------------------------
// The commit writes only what somebody chose.
// ---------------------------------------------------------------------------

describe("writing a row whose landlord had to be identified", () => {
  const needsChoice: PlannedWrite = {
    line: 2,
    action: "create",
    record: RECORD,
    suggestedLandlordId: "c-held",
    landlordChoiceRequired: true,
  };

  test("UNANSWERED holds the row — nothing is created and nothing is attached", async () => {
    const result = await commit([needsChoice]);

    assert.equal(called("createProperty").length, 0);
    assert.equal(result.status === "done" && result.created, 0);
    assert.equal(result.status === "done" && result.skipped, 1);
    const [outcome] = result.status === "done" ? result.rows : [];
    assert.equal(outcome.outcome, "skipped");
    assert.match(
      outcome.outcome === "skipped" ? outcome.reason : "",
      /could not tell whether it is the same person/i,
    );
  });

  test("EXISTING attaches to the landlord the preview suggested, by id", async () => {
    await commit([needsChoice], { identities: { 2: "existing" } });

    const [call] = called("createProperty");
    assert.ok(call);
    const input = call.args[1] as { landlordId?: string; newLandlord?: unknown };
    assert.equal(input.landlordId, "c-held");
    assert.equal(input.newLandlord, undefined);
  });

  test("NEW records a second landlord of that name — distinct people share names", async () => {
    await commit([needsChoice], { identities: { 2: "new" } });

    const [call] = called("createProperty");
    const input = call.args[1] as {
      landlordId?: string;
      newLandlord?: { name: string; email: string | null };
    };
    assert.equal(input.landlordId, undefined);
    assert.equal(input.newLandlord?.name, "Ada Fixture");
    // Created with no contact, which is exactly what the file said.
    assert.equal(input.newLandlord?.email, null);
  });

  test("the id can only come from the envelope, so accepting an absent one writes nothing", async () => {
    /*
      The browser submits "existing" and never an id. A submission that accepts
      a suggestion the preview did not make has nothing to attach to, and is
      held rather than quietly creating a landlord the agent did not choose.
    */
    const result = await commit(
      [{ ...needsChoice, suggestedLandlordId: undefined }],
      { identities: { 2: "existing" } },
    );

    assert.equal(called("createProperty").length, 0);
    assert.equal(result.status === "done" && result.skipped, 1);
  });

  test("a row that never needed a choice is unaffected by an absent answer", async () => {
    await commit([{ line: 2, action: "create", record: RECORD }]);

    const [call] = called("createProperty");
    const input = call.args[1] as { newLandlord?: { name: string } };
    assert.equal(input.newLandlord?.name, "Ada Fixture");
  });

  test("the agency comes from the session, never from the row", async () => {
    await commit([needsChoice], { identities: { 2: "existing" } });
    assert.equal(called("createProperty")[0].args[0], "org-1");
  });
});

// ---------------------------------------------------------------------------
// The preview's promise about landlord details, and what is actually written.
// ---------------------------------------------------------------------------

describe("a difference in landlord details, with no email to identify them", () => {
  test("the preview reports it and does NOT offer to apply it", () => {
    /*
      **The mismatch this closes.** Both sides had no email, so the planner fell
      through to "Landlord details" and marked it applicable — while the commit
      skipped the landlord entirely for want of anything to match on. The agent
      ticked a box and nothing happened.
    */
    const result = plan(
      [row(2, { landlordName: "Ada Fixture", landlordPhone: "07700900123" })],
      { held: [heldProperty()] },
    );

    assert.equal(result.counts.conflict, 1);
    const conflict = result.rows[0].conflicts?.[0];
    assert.equal(conflict?.field, "Landlord details");
    assert.equal(conflict?.applicable, false);
    assert.match(conflict?.effect ?? "", /no email on one side/i);
    assert.equal(result.rows[0].conflictsApplicable, false);
  });

  test("and the commit writes nothing to the landlord either", async () => {
    const existing = heldProperty();
    currentPortfolio = new Map([[existing.key, existing]]);

    await commit(
      [
        {
          line: 2,
          action: "conflict",
          record: RECORD,
          existingPropertyId: "p-1",
          applicable: true,
          observed: fingerprintOf(existing),
        },
      ],
      { resolutions: { 2: "update" } },
    );

    assert.equal(called("updateLandlord").length, 0);
  });

  test("a matching email on both sides is applicable, and is applied", async () => {
    const withEmail = { landlordEmail: "ada@fixture.example.invalid" };
    const existing = heldProperty({
      landlordEmail: "ada@fixture.example.invalid",
      landlordPhone: "01902000000",
    });

    const previewed = plan([row(2, { ...withEmail, landlordPhone: "07700900123" })], {
      held: [existing],
    });
    const conflict = previewed.rows[0].conflicts?.[0];
    assert.equal(conflict?.field, "Landlord details");
    assert.equal(conflict?.applicable, true);

    currentPortfolio = new Map([[existing.key, existing]]);
    await commit(
      [
        {
          line: 2,
          action: "conflict",
          record: {
            ...RECORD,
            landlord: {
              name: "Ada Fixture",
              company: null,
              email: "ada@fixture.example.invalid",
              phone: "07700900123",
            },
          } as ImportRecord,
          existingPropertyId: "p-1",
          applicable: true,
          observed: fingerprintOf(existing),
        },
      ],
      { resolutions: { 2: "update" } },
    );

    const [call] = called("updateLandlord");
    assert.ok(call, "the landlord the property belongs to is updated");
    // By the id of the owner freshly read, not by a search across the agency.
    assert.equal(call.args[1], "c-held");
  });

  test("a different email is a re-parenting, which an import never does", async () => {
    const existing = heldProperty({ landlordEmail: "ada@fixture.example.invalid" });
    const previewed = plan(
      [row(2, { landlordEmail: "someone.else@fixture.example.invalid" })],
      { held: [existing] },
    );

    const conflict = previewed.rows[0].conflicts?.[0];
    assert.equal(conflict?.field, "Landlord");
    assert.equal(conflict?.applicable, false);
    // Nothing invented into the wording where a contact is missing.
    assert.equal(/null|undefined/.test(conflict?.current ?? ""), false);

    /*
      And the landlord named in the file is **not** edited on the way past. The
      commit used to look the incoming email up across the agency and update
      whoever held it — a landlord who has nothing to do with this property.
    */
    currentPortfolio = new Map([[existing.key, existing]]);
    await commit(
      [
        {
          line: 2,
          action: "conflict",
          record: {
            ...RECORD,
            landlord: {
              name: "Someone Else",
              company: null,
              email: "someone.else@fixture.example.invalid",
              phone: null,
            },
          } as ImportRecord,
          existingPropertyId: "p-1",
          applicable: true,
          observed: fingerprintOf(existing),
        },
      ],
      { resolutions: { 2: "update" } },
    );

    assert.equal(called("updateLandlord").length, 0);
  });

  test("a file that supplies an email we do not hold is reported, not written", () => {
    // Valuable, and still not proof that it is the same person.
    const result = plan(
      [row(2, { landlordEmail: "ada@fixture.example.invalid" })],
      { held: [heldProperty()] },
    );

    assert.equal(result.counts.conflict, 1);
    assert.equal(result.rows[0].conflicts?.[0]?.applicable, false);
    assert.equal(result.wouldWrite, 0);
  });
});

// ---------------------------------------------------------------------------
// Importing the same file twice.
// ---------------------------------------------------------------------------

describe("repeat imports", () => {
  test("a contactless row already on file is unchanged, not a conflict", () => {
    const result = plan([row(2)], { held: [heldProperty()] });
    assert.equal(result.counts.unchanged, 1);
    assert.equal(result.counts.conflict, 0);
    assert.equal(result.wouldWrite, 0);
  });

  test("a row already imported needs no identity choice the second time", () => {
    /*
      The address matches, so the property is recognised and the landlord
      question does not arise again. Being asked "which Ada Fixture is this?"
      about a property already attached to one would be a question with no
      consequence.
    */
    const result = plan([row(2)], { held: [heldProperty()], byName: ONE_MATCH });
    assert.equal(result.rows[0].landlordChoiceRequired, undefined);
  });

  test("the same address twice in one file is still one property", () => {
    const result = plan([row(2), row(3)], { byName: ONE_MATCH });
    assert.equal(result.counts.create, 1);
    assert.equal(result.counts.duplicate_in_file, 1);
  });

  test("resubmitting one plan is recognised rather than written twice", async () => {
    claimWins = false;
    const result = await commit([{ line: 2, action: "create", record: RECORD }]);

    assert.equal(result.status, "already_submitted");
    assert.equal(called("createProperty").length, 0);
  });
});

// ---------------------------------------------------------------------------
// The digest covers the choice, so answering later is a new import.
// ---------------------------------------------------------------------------

describe("the plan digest", () => {
  test("a different identity answer is a different submission", async () => {
    const { digestFor } = await import("./envelope");
    const envelope = envelopeOf([
      {
        line: 2,
        action: "create",
        record: RECORD,
        suggestedLandlordId: "c-held",
        landlordChoiceRequired: true,
      },
    ]);
    const resolutions = new Map<number, "skip" | "update">();

    const unanswered = digestFor(envelope, resolutions, new Map());
    const reused = digestFor(
      envelope,
      resolutions,
      new Map([[2, "existing" as const]]),
    );
    const separate = digestFor(
      envelope,
      resolutions,
      new Map([[2, "new" as const]]),
    );

    assert.notEqual(unanswered, reused);
    assert.notEqual(reused, separate);
  });
});
