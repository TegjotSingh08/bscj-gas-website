import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { ExistingProperty, NameMatch } from "./lookup";
import type { ImportProfile } from "./profile";

/**
 * **The whole import, driven through the real server actions.**
 *
 * The pieces were each tested on their own. This is the path an agency
 * actually takes — BSCJ configures a profile, the agency uploads a file, the
 * preview is computed, the agent answers what it asks, and the confirmation
 * writes — run end to end over the fictional CSVs in `docs/acceptance/csv`.
 *
 * **What is real here**, and it is most of it: `previewImportAction` and
 * `confirmImportAction` themselves, the CSV parser, the header resolver, the
 * profile, the planner, the address splitter, the date reader, the signed
 * envelope and its digest, the allow-listed resolutions and identity answers,
 * and `commitImport`'s ordering and idempotency.
 *
 * **What is faked**, and only this: the database and the mutations, at their
 * boundary. There is no Postgres on this machine, so the fakes *record* what
 * the production code asked to be written rather than writing it. That proves
 * what an import decides and asks for. It is **not** a live-database pass and
 * nothing here may be reported as one — the unique index, the foreign keys and
 * the real transaction semantics are not exercised.
 *
 * The CSVs are read from the acceptance pack rather than written inline, so
 * the files the owner is handed in the morning are literally the ones these
 * assertions were made against.
 */

const CSV_DIR = path.resolve(process.cwd(), "docs/acceptance/csv");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

// ---------------------------------------------------------------------------
// Fakes, at the database and mutation boundary only
// ---------------------------------------------------------------------------

type Call = { name: string; args: unknown[] };

let calls: Call[] = [];
/** Properties the agency already holds, by key. */
let portfolio = new Map<string, ExistingProperty>();
/** Landlord emails the agency already holds, lower-cased. */
let landlordEmails = new Set<string>();
/** Landlords by normalised name, as `matchLandlordsByName` returns them. */
let landlordsByName = new Map<string, NameMatch>();
/** The profile BSCJ has configured for this agency. */
let profile: ImportProfile;
let profileConfigured = true;
/** Plan digests already claimed, so a repeat submission is recognised. */
let claimed = new Set<string>();
/** Whether `createProperty` should report the address as already taken. */
let duplicateOnCreate = new Set<string>();
/** The organisation `requireAgent()` reports. */
let sessionOrg = ORG;

const called = (name: string) => calls.filter((call) => call.name === name);
const record = (name: string, result: unknown) =>
  async (...args: unknown[]) => {
    calls.push({ name, args });
    return result;
  };

mock.module("@/lib/auth/session", {
  namedExports: {
    requireAgent: async () => ({
      user: { id: USER, email: "agent@fixture.example.invalid", role: "agent_admin" },
      organisationId: sessionOrg,
      scope: { kind: "organisation", organisationId: sessionOrg },
    }),
    requireCapability: () => undefined,
  },
});

mock.module("@/lib/audit/record", {
  namedExports: { recordAudit: record("recordAudit", undefined) },
});

mock.module("@/lib/booking/rate-limit", {
  namedExports: { rateLimit: async () => ({ ok: true }) },
});

mock.module("./profile-store", {
  namedExports: {
    readProfile: async () => ({ profile, configured: profileConfigured }),
  },
});

mock.module("./lookup", {
  namedExports: {
    lookupExistingByPostcode: async () => portfolio,
    lookupLandlordsByEmail: async () =>
      new Map([...landlordEmails].map((email) => [email, { id: `c-${email}` }])),
    matchLandlordsByName: async () => landlordsByName,
  },
});

mock.module("../mutations", {
  namedExports: {
    createProperty: async (
      organisationId: string,
      input: { property: { postcode: string; houseOrName: string } },
      actorUserId: string,
    ) => {
      calls.push({ name: "createProperty", args: [organisationId, input, actorUserId] });
      const key = `${input.property.postcode}|${input.property.houseOrName}`;
      if (duplicateOnCreate.has(key)) return { status: "duplicate", existingId: "p-dup" };
      return { status: "ok", value: `p-${key}` };
    },
    updateLandlord: record("updateLandlord", { status: "ok", value: undefined }),
    replaceTenancy: record("replaceTenancy", { status: "ok", value: undefined }),
    setCompliancePosition: record("setCompliancePosition", {
      status: "ok",
      value: undefined,
    }),
  },
});

/** Just enough Drizzle for the import-claim row. */
function makeDb() {
  return {
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            const digest = String(row.planDigest);
            if (claimed.has(digest)) return [];
            claimed.add(digest);
            return [{ id: `import-${claimed.size}` }];
          },
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  };
}

mock.module("@/lib/db/client", { namedExports: { getDb: () => makeDb() } });

const { previewImportAction, confirmImportAction } = await import(
  "@/app/(portal)/portal/portfolio/import/actions"
);
const { DEFAULT_PROFILE } = await import("./profile");

// ---------------------------------------------------------------------------
// Driving the actions
// ---------------------------------------------------------------------------

function upload(file: string): FormData {
  const bytes = readFileSync(path.join(CSV_DIR, file));
  const form = new FormData();
  form.set("file", new File([bytes], file, { type: "text/csv" }));
  return form;
}

async function preview(file: string) {
  return previewImportAction({}, upload(file));
}

/** Confirms a sealed plan with the answers an agent would have ticked. */
async function confirm(
  sealed: string,
  answers: {
    resolutions?: Record<number, "update">;
    identities?: Record<number, "existing" | "new">;
  } = {},
) {
  const form = new FormData();
  form.set("plan", sealed);
  for (const [line, value] of Object.entries(answers.resolutions ?? {})) {
    form.set(`resolution-${line}`, value);
  }
  for (const [line, value] of Object.entries(answers.identities ?? {})) {
    form.set(`landlord-${line}`, value);
  }
  return confirmImportAction({}, form);
}

/**
 * A property the agency already holds.
 *
 * Keyed exactly as the planner keys one, and defaulting to values that
 * **agree** with the fixture rows, so "unchanged" means unchanged rather than
 * a conflict the fixture accidentally created.
 */
const held = (key: string, overrides: Partial<ExistingProperty> = {}): ExistingProperty => {
  const [postcode, houseOrName] = key.split("|");
  return {
    id: `p-${key}`,
    key,
    houseOrName,
    street: "Fixture Street",
    town: "Wolverhampton",
    postcode,
    landlordId: "c-held",
    landlordName: "Ada Fixture",
    landlordEmail: "ada@fixture.example.invalid",
    landlordPhone: "07700900001",
    landlordCompany: null,
    tenancyId: null,
    tenantName: null,
    tenantEmail: null,
    tenantPhone: null,
    dueDate: null,
    inspectionDate: null,
    ...overrides,
  };
};

beforeEach(() => {
  calls = [];
  portfolio = new Map();
  landlordEmails = new Set();
  landlordsByName = new Map();
  claimed = new Set();
  duplicateOnCreate = new Set();
  sessionOrg = ORG;
  profileConfigured = true;
  profile = { ...DEFAULT_PROFILE, updatedAt: "2026-09-21T00:00:00.000Z" };
  process.env.AUTH_SECRET ??= "walkthrough-fixture-secret-not-a-real-one";
});

// ---------------------------------------------------------------------------

describe("01 — an ordinary file against the template", () => {
  test("the preview writes nothing at all", async () => {
    const state = await preview("01-template-ordinary.csv");

    assert.equal(state.plan?.counts.create, 3);
    assert.ok(state.sealed, "a signed plan comes back");
    /*
      **The property this whole two-step design exists for.** Not "no property
      was created" — *no business write was attempted*, by any path.
    */
    assert.deepEqual(
      calls.filter((call) => call.name !== "recordAudit").map((call) => call.name),
      [],
    );
  });

  test("confirming writes exactly the three properties reviewed", async () => {
    const state = await preview("01-template-ordinary.csv");
    const result = await confirm(state.sealed!);

    assert.equal(result.done?.created, 3);
    assert.equal(result.done?.failed, 0);
    assert.equal(called("createProperty").length, 3);
  });

  test("the tenancy on the first row is carried, and the blank one is not invented", async () => {
    const state = await preview("01-template-ordinary.csv");
    await confirm(state.sealed!);

    const inputs = called("createProperty").map(
      (call) => call.args[1] as { tenancy: { name: string } | null },
    );
    assert.equal(inputs[0].tenancy?.name, "Tom Tenant");
    assert.equal(inputs[1].tenancy, null);
  });

  test("a blank certificate date records no compliance position rather than a wrong one", async () => {
    const state = await preview("01-template-ordinary.csv");
    await confirm(state.sealed!);

    const inputs = called("createProperty").map(
      (call) => call.args[1] as { compliance: unknown },
    );
    assert.notEqual(inputs[0].compliance, null);
    assert.equal(inputs[2].compliance, null);
  });

  test("day-first dates are read day-first", async () => {
    const state = await preview("01-template-ordinary.csv");
    const [first] = state.plan!.rows;
    // 31/10/2026 — unambiguous, and the long form proves which way it was read.
    assert.match(first.dueDateLong ?? "", /31 October 2026/);
  });

  test("submitting the same reviewed plan twice does not write twice", async () => {
    const state = await preview("01-template-ordinary.csv");
    await confirm(state.sealed!);
    const again = await confirm(state.sealed!);

    assert.equal(again.done?.repeat, true);
    assert.equal(called("createProperty").length, 3);
  });

  test("uploading the same file again is a new review, and finds it already held", async () => {
    const first = await preview("01-template-ordinary.csv");
    await confirm(first.sealed!);

    // Keyed exactly as the planner computes it, from the plan it just built.
    portfolio = new Map(
      first.plan!.rows
        .filter((row) => row.record)
        .map((row) => [row.record!.key, held(row.record!.key)]),
    );
    calls = [];

    const second = await preview("01-template-ordinary.csv");
    assert.equal(second.plan?.counts.create, 0);
    assert.equal(second.plan?.wouldWrite, 0);
  });
});

describe("02 — landlords with no email address", () => {
  test("the default policy holds those rows and records nothing for them", async () => {
    // DEFAULT_PROFILE is `reject_row` — "hold the row, do not import it".
    const state = await preview("02-missing-landlord-contact.csv");

    assert.equal(state.plan?.counts.error, 2);
    assert.equal(state.plan?.counts.create, 1);

    const result = await confirm(state.sealed!);
    assert.equal(result.done?.created, 1);
    // Only the row that carried an address was written.
    const [only] = called("createProperty");
    const input = only.args[1] as { newLandlord: { email: string | null } };
    assert.equal(input.newLandlord.email, "dev@holding.example.invalid");
  });

  test("a held row names the column, and nothing is invented to get it through", async () => {
    const state = await preview("02-missing-landlord-contact.csv");
    const heldRow = state.plan!.rows.find((row) => row.action === "error");

    assert.equal(heldRow?.errors?.[0]?.column, "landlord_email");
    assert.equal(heldRow?.landlordContactMissing, true);
    assert.equal(heldRow?.record, undefined);
  });

  test("switching the agency to `record_without_contact` records them, with no contact", async () => {
    profile = { ...profile, landlordMatch: "record_without_contact" };
    const state = await preview("02-missing-landlord-contact.csv");

    assert.equal(state.plan?.counts.create, 3);
    assert.equal(state.plan?.counts.error, 0);

    await confirm(state.sealed!);
    const landlords = called("createProperty").map(
      (call) =>
        (call.args[1] as { newLandlord?: { email: string | null; phone: string | null } })
          .newLandlord,
    );

    // Recorded as they are. No address and no number is conjured from anywhere.
    assert.equal(landlords[0]?.email, null);
    assert.equal(landlords[0]?.phone, null);
    assert.equal(landlords[1]?.email, null);
    // Normalised on the way in by the same parser the manual form uses. Not
    // invented — the digits are the ones in the file.
    assert.equal(landlords[1]?.phone, "+447700900003");
  });

  test("the preview says which properties will have an uncontactable landlord", async () => {
    profile = { ...profile, landlordMatch: "record_without_contact" };
    const state = await preview("02-missing-landlord-contact.csv");

    const flagged = state.plan!.rows.filter(
      (row) => row.action === "create" && row.landlordContactMissing === true,
    );
    assert.equal(flagged.length, 2);
  });
});

describe("03 — two landlords who share a name", () => {
  beforeEach(() => {
    profile = { ...profile, landlordMatch: "match_existing_by_name" };
    landlordsByName = new Map<string, NameMatch>([
      // One on file: a suggestion, and a question.
      ["ada fixture", { outcome: "one", id: "c-ada", name: "Ada Fixture" }],
      // Two on file: nothing sensible to suggest.
      ["j smith", { outcome: "ambiguous", count: 2 }],
    ]);
  });

  test("an ambiguous name is held outright", async () => {
    const state = await preview("03-same-name-distinct-landlords.csv");
    const ambiguous = state.plan!.rows.find((row) => row.line === 2);

    assert.equal(ambiguous?.action, "error");
    assert.match(ambiguous?.errors?.[0]?.message ?? "", /more than one landlord/i);
    // It does not tell anybody to merge two people because of a shared name.
    assert.equal(/merge/i.test(ambiguous?.errors?.[0]?.message ?? ""), false);
  });

  test("a unique name is a question, and leaving it unanswered writes nothing", async () => {
    const state = await preview("03-same-name-distinct-landlords.csv");
    const asked = state.plan!.rows.find((row) => row.line === 3);
    assert.equal(asked?.landlordChoiceRequired, true);

    const result = await confirm(state.sealed!);
    assert.equal(result.done?.created, 0);
    assert.equal(result.done?.skipped, 1);
    assert.equal(called("createProperty").length, 0);
  });

  test("answering `same person` attaches to the suggested landlord by id", async () => {
    const state = await preview("03-same-name-distinct-landlords.csv");
    await confirm(state.sealed!, { identities: { 3: "existing" } });

    const [call] = called("createProperty");
    const input = call.args[1] as { landlordId?: string; newLandlord?: unknown };
    assert.equal(input.landlordId, "c-ada");
    assert.equal(input.newLandlord, undefined);
  });

  test("answering `different person` records a second landlord of that name", async () => {
    const state = await preview("03-same-name-distinct-landlords.csv");
    await confirm(state.sealed!, { identities: { 3: "new" } });

    const [call] = called("createProperty");
    const input = call.args[1] as {
      landlordId?: string;
      newLandlord?: { name: string; email: string | null };
    };
    assert.equal(input.landlordId, undefined);
    assert.equal(input.newLandlord?.name, "Ada Fixture");
    assert.equal(input.newLandlord?.email, null);
  });

  test("changing the answer is a new submission, not a blocked repeat", async () => {
    const state = await preview("03-same-name-distinct-landlords.csv");
    await confirm(state.sealed!, { identities: { 3: "existing" } });
    const second = await confirm(state.sealed!, { identities: { 3: "new" } });

    assert.notEqual(second.done?.repeat, true);
  });

  test("the browser cannot name a landlord the preview did not suggest", async () => {
    const state = await preview("03-same-name-distinct-landlords.csv");

    const form = new FormData();
    form.set("plan", state.sealed!);
    form.set("landlord-3", "existing");
    // An id the agent's browser invented. Nothing reads it.
    form.set("landlordId-3", "c-somebody-else");
    await confirmImportAction({}, form);

    const [call] = called("createProperty");
    assert.equal((call.args[1] as { landlordId?: string }).landlordId, "c-ada");
  });
});

describe("04 — duplicates, and dates in two conventions", () => {
  test("the same address twice in one file is imported once and reported once", async () => {
    const state = await preview("04-duplicates-and-dates.csv");

    assert.equal(state.plan?.counts.duplicate_in_file, 1);
    const repeat = state.plan!.rows.find((row) => row.action === "duplicate_in_file");
    assert.equal(repeat?.duplicateOfLine, 2);

    await confirm(state.sealed!);
    assert.equal(called("createProperty").length, 3);
  });

  test("a day-first date and its ISO twin are read as the same day", async () => {
    const state = await preview("04-duplicates-and-dates.csv");
    const rows = state.plan!.rows;

    const dayFirst = rows.find((row) => row.line === 4)?.dueDateLong;
    const iso = rows.find((row) => row.line === 5)?.dueDateLong;
    assert.equal(dayFirst, iso);
    assert.match(dayFirst ?? "", /3 April 2027/);
  });

  test("`iso_only` refuses the ambiguous convention instead of guessing", async () => {
    profile = { ...profile, dateOrder: "iso_only" };
    const state = await preview("04-duplicates-and-dates.csv");

    // Three day-first dates refused, the ISO one accepted.
    assert.equal(state.plan?.counts.error, 3);
    assert.equal(state.plan?.counts.create, 1);
  });

  test("a property already held with a different expiry is a conflict, not a silent write", async () => {
    portfolio = new Map([
      ["WV5 5EE|40", held("WV5 5EE|40", { dueDate: "2026-06-30" })],
    ]);
    const state = await preview("04-duplicates-and-dates.csv");

    assert.equal(state.plan?.counts.conflict, 1);
    assert.equal(state.plan?.wouldWrite, 2);

    // Confirmed without ticking it: the date is left exactly as it was.
    await confirm(state.sealed!);
    assert.equal(called("setCompliancePosition").length, 0);
  });

  test("ticking it supersedes the position, and the history is kept by the mutation", async () => {
    portfolio = new Map([
      ["WV5 5EE|40", held("WV5 5EE|40", { dueDate: "2026-06-30" })],
    ]);
    const state = await preview("04-duplicates-and-dates.csv");
    await confirm(state.sealed!, { resolutions: { 2: "update" } });

    assert.equal(called("setCompliancePosition").length, 1);
  });

  test("a blank column never erases what is already held", async () => {
    // Row 4 has an expiry; the property on file has one too. Row 3 in file 01
    // has none — a blank means "this spreadsheet does not say".
    const first = await preview("01-template-ordinary.csv");
    const sampleCourt = first.plan!.rows.find((r) => r.line === 4)!.record!;
    /*
      Held exactly as the file describes it, except that we already know a
      certificate expiry and the file's column is blank. Everything else
      agreeing is what isolates the question to the blank.
    */
    portfolio = new Map([
      [
        sampleCourt.key,
        held(sampleCourt.key, {
          street: sampleCourt.property.street,
          landlordName: sampleCourt.landlord.name,
          landlordEmail: sampleCourt.landlord.email,
          landlordPhone: sampleCourt.landlord.phone,
          tenancyId: "t-1",
          tenantName: sampleCourt.tenancy?.name ?? null,
          tenantEmail: sampleCourt.tenancy?.email ?? null,
          tenantPhone: sampleCourt.tenancy?.phone ?? null,
          dueDate: "2027-01-01",
        }),
      ],
    ]);
    calls = [];

    const state = await preview("01-template-ordinary.csv");
    const row = state.plan!.rows.find((r) => r.line === 4);
    assert.equal(row?.action, "unchanged");
    await confirm(state.sealed!);
    assert.equal(called("setCompliancePosition").length, 0);
  });
});

describe("05 — an agency's own export, with combined addresses", () => {
  beforeEach(() => {
    /*
      What BSCJ would record after looking at this export once. Nothing in the
      code knows the agency; this is the profile doing its job.
    */
    profile = {
      ...profile,
      columns: {
        fullAddress: "Address",
        landlordName: "Owner",
        landlordEmail: "Owner Email",
        certificateExpiry: "Expiry",
      },
      addressMode: "combined",
    };
  });

  test("a flat keeps both identifiers, so two flats stay two properties", async () => {
    const state = await preview("05-combined-addresses.csv");
    const flat = state.plan!.rows.find((row) => row.line === 2);
    const house = state.plan!.rows.find((row) => row.line === 3);

    assert.equal(flat?.record?.property.houseOrName, "Flat 2, 14");
    assert.equal(house?.record?.property.houseOrName, "14");
    assert.notEqual(flat?.record?.key, house?.record?.key);
  });

  test("a unit with no building number is refused rather than split on a guess", async () => {
    const state = await preview("05-combined-addresses.csv");
    const unclear = state.plan!.rows.find((row) => row.line === 4);

    assert.equal(unclear?.action, "error");
    assert.equal(unclear?.errors?.[0]?.column, "full_address");
  });

  test("the export's own reference column is reported as unused, not dropped in silence", async () => {
    const state = await preview("05-combined-addresses.csv");
    assert.ok(state.unknownColumns?.includes("Ref"));
  });

  test("the profile in force is shown, so the agent can see how their file was read", async () => {
    const state = await preview("05-combined-addresses.csv");
    assert.equal(state.profile?.addressMode, "combined");
    assert.equal(state.profileConfigured, true);
  });
});

describe("what a manipulated submission cannot do", () => {
  test("a plan built for one agency cannot be confirmed by another", async () => {
    const state = await preview("01-template-ordinary.csv");
    sessionOrg = OTHER_ORG;

    const result = await confirm(state.sealed!);
    assert.match(result.error ?? "", /no longer valid/i);
    assert.equal(called("createProperty").length, 0);
  });

  test("an edited envelope is refused rather than partly trusted", async () => {
    const state = await preview("01-template-ordinary.csv");
    const [payload, signature] = state.sealed!.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.organisationId = OTHER_ORG;
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;

    const result = await confirm(forged);
    assert.match(result.error ?? "", /no longer valid/i);
    assert.equal(called("createProperty").length, 0);
  });

  test("a profile corrected between preview and confirm invalidates the review", async () => {
    const state = await preview("01-template-ordinary.csv");
    // BSCJ decides the second name column is a caretaker after all.
    profile = { ...profile, occupierRole: "unknown" };

    const result = await confirm(state.sealed!);
    assert.match(result.error ?? "", /no longer valid|settings/i);
    assert.equal(called("createProperty").length, 0);
  });

  test("an unexpected resolution value is read as `leave it alone`", async () => {
    portfolio = new Map([
      ["WV5 5EE|40", held("WV5 5EE|40", { dueDate: "2026-06-30" })],
    ]);
    const state = await preview("04-duplicates-and-dates.csv");

    const form = new FormData();
    form.set("plan", state.sealed!);
    form.set("resolution-2", "UPDATE!");
    await confirmImportAction({}, form);

    assert.equal(called("setCompliancePosition").length, 0);
  });

  test("an unexpected identity value holds the row", async () => {
    profile = { ...profile, landlordMatch: "match_existing_by_name" };
    landlordsByName = new Map<string, NameMatch>([
      ["ada fixture", { outcome: "one", id: "c-ada", name: "Ada Fixture" }],
      ["j smith", { outcome: "none" }],
    ]);
    const state = await preview("03-same-name-distinct-landlords.csv");

    const form = new FormData();
    form.set("plan", state.sealed!);
    form.set("landlord-3", "yes-please");
    const result = await confirmImportAction({}, form);

    assert.equal(result.done?.skipped, 1);
  });
});

describe("a partial failure is reported as one", () => {
  test("a row lost to a race is skipped, the rest still go in", async () => {
    duplicateOnCreate.add("WV1 1AA|16");
    const state = await preview("01-template-ordinary.csv");
    const result = await confirm(state.sealed!);

    assert.equal(result.done?.created, 2);
    assert.equal(result.done?.skipped, 1);
    assert.equal(result.done?.failed, 0);

    const skipped = result.done!.rows.find((row) => row.outcome === "skipped");
    assert.equal(skipped?.line, 3);
    assert.match(
      skipped && skipped.outcome === "skipped" ? skipped.reason : "",
      /already in your portfolio/i,
    );
  });
});
