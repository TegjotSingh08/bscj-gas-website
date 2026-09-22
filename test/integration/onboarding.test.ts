import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * **Onboarding an agency, through the real actions, against PostgreSQL.**
 *
 * BSCJ reviews an agency's export and records what its columns mean → the
 * agency uploads → the preview says what will happen and asks what it cannot
 * decide → the agent answers → the confirmation writes. Then the same file
 * again, to show what a reimport does.
 *
 * **Why this exists next to `walkthrough.test.ts`.** That one drives the same
 * two server actions and is careful to say what it is: the database and the
 * mutations are faked at their boundary, so it proves what an import
 * *decides*, and its own header says it is not a live-database pass. This is
 * the other half. Only the session is faked here; the profile store, the
 * lookups, the planner, the envelope, `commitImport` and every mutation are
 * the real ones, writing to a real database with real constraints, real
 * foreign keys and the real unique index on an agency's addresses.
 *
 * **Two agencies throughout**, because the thing an agency will ask about
 * first is whether anybody else can see their portfolio.
 *
 * The CSVs are the acceptance pack's own files, so the fixtures the owner is
 * handed in the morning are literally the ones these assertions were made
 * against. Every landlord, address and telephone number in them is fictional.
 *
 * **Nothing about Express Properties' real export is assumed.** The profile
 * written below is a *fictional* agency's, chosen to exercise the policies;
 * what any real agency's columns mean is a thing BSCJ confirms with them.
 */

import {
  connect,
  reset,
  start,
  stop,
  type Connection,
} from "../support/disposable-postgres";
import { setDbForTesting } from "../../src/lib/db/client";
import { seed, type Fixture } from "../support/fixtures";

const CSV_DIR = path.resolve(process.cwd(), "docs/acceptance/csv");

let conn: Connection;
let fixture: Fixture;

/** Which agency the faked session currently belongs to. */
let sessionOrg = "";
let sessionUser = "";

/*
  The session, and **only** the session.

  There is no request here to carry a cookie, so `requireAgent` is the one
  thing that cannot be exercised as itself. Everything it guards is exercised:
  the organisation it returns is what scopes every read and write below, and
  swapping it is how the isolation tests are written.
*/
mock.module("@/lib/auth/session", {
  namedExports: {
    requireAgent: async () => ({
      user: {
        id: sessionUser,
        email: "agent@fixture.example.invalid",
        role: "agent_owner",
      },
      organisationId: sessionOrg,
      scope: { kind: "organisation", organisationId: sessionOrg },
    }),
    requireCapability: () => undefined,
  },
});

/* No Redis here. The limiter's own behaviour is tested where it lives. */
mock.module("@/lib/booking/rate-limit", {
  namedExports: { rateLimit: async () => ({ ok: true }) },
});

before(async () => {
  /*
    Fictional, and long enough to be accepted. The import plan is signed with
    it so a browser cannot edit a reviewed plan; it reaches nothing outside
    this process.
  */
  process.env.AUTH_SECRET ??= "onboarding-integration-fixture-secret-not-real";
  await start();
  conn = await connect();
  setDbForTesting(conn.db as never);
});

after(async () => {
  setDbForTesting(null);
  await stop();
});

beforeEach(async () => {
  await reset(conn);
  fixture = await seed(conn);
  sessionOrg = fixture.organisationId;
  sessionUser = fixture.agentUserId;
});

// ---------------------------------------------------------------------------
// Driving the two actions
// ---------------------------------------------------------------------------

function csvFile(name: string): File {
  const bytes = readFileSync(path.join(CSV_DIR, name));
  return new File([bytes], name, { type: "text/csv" });
}

async function preview(name: string) {
  const { previewImportAction } = await import(
    "../../src/app/(portal)/portal/portfolio/import/actions"
  );
  const form = new FormData();
  form.set("file", csvFile(name));
  return previewImportAction({}, form);
}

/**
 * Confirms a previewed plan.
 *
 * `answers` is keyed by the file's line number, exactly as the wizard's radio
 * buttons are named. Anything not answered is left unanswered on purpose —
 * that is the case the planner has to hold rather than guess.
 */
async function confirm(
  sealed: string,
  answers: Record<number, { resolution?: string; landlord?: string }> = {},
) {
  const { confirmImportAction } = await import(
    "../../src/app/(portal)/portal/portfolio/import/actions"
  );
  const form = new FormData();
  form.set("plan", sealed);
  for (const [line, answer] of Object.entries(answers)) {
    if (answer.resolution) form.set(`resolution-${line}`, answer.resolution);
    if (answer.landlord) form.set(`landlord-${line}`, answer.landlord);
  }
  return confirmImportAction({}, form);
}

/** BSCJ recording what this agency's export means. */
async function configureProfile(
  organisationId: string,
  overrides: Record<string, unknown> = {},
) {
  const { writeProfile } = await import(
    "../../src/lib/portfolio/import/profile-store"
  );
  const { DEFAULT_PROFILE } = await import(
    "../../src/lib/portfolio/import/profile"
  );
  const saved = await writeProfile({
    organisationId,
    profile: {
      ...DEFAULT_PROFILE,
      notes: "Fictional agency. Reviewed with them before the first upload.",
      ...overrides,
    } as never,
    actorUserId: fixture.adminUserId,
  });
  assert.ok(saved.ok, "the profile was saved");
}

async function count(table: string, where = "", params: unknown[] = []) {
  const { rows } = await conn.client.query<{ n: string }>(
    `select count(*)::text as n from ${table} ${where}`,
    params,
  );
  return Number(rows[0].n);
}

async function propertiesOf(organisationId: string) {
  const { rows } = await conn.client.query<{
    house_or_name: string;
    postcode: string;
    customer_id: string | null;
  }>(
    `select house_or_name, postcode, customer_id from property
      where agent_organisation_id = $1 order by house_or_name`,
    [organisationId],
  );
  return rows;
}

// ---------------------------------------------------------------------------

describe("BSCJ configures the agency before they upload anything", () => {
  test("with no profile, the preview says so rather than guessing", async () => {
    const state = await preview("01-template-ordinary.csv");
    assert.equal(
      state.profileConfigured,
      false,
      "an unconfigured agency is told, not silently given the template",
    );
    assert.ok(state.plan, "and the template still reads a template file");
  });

  test("a saved profile is what the preview reads the file with", async () => {
    await configureProfile(fixture.organisationId, { dateOrder: "iso_only" });

    const state = await preview("01-template-ordinary.csv");
    assert.equal(state.profileConfigured, true);
    assert.equal(state.profile?.dateOrder, "iso_only");
  });

  test("one agency's profile is not another's", async () => {
    await configureProfile(fixture.organisationId, { occupierRole: "tenant" });

    sessionOrg = fixture.otherOrganisationId;
    sessionUser = fixture.otherAgentUserId;
    const theirs = await preview("01-template-ordinary.csv");
    assert.equal(
      theirs.profileConfigured,
      false,
      "the rival agency has no profile of its own",
    );
  });
});

describe("the first import writes what the file actually says", () => {
  test("two new properties are created; the third already matches the fixture's own", async () => {
    /*
      The template's first row — 14 Fixture Street, WV1 1AA, Ada Fixture — is
      exactly the property `seed()` already writes as prior state, so the
      planner correctly reports it as already held rather than proposing a
      duplicate. Only the other two rows are genuinely new.
    */
    await configureProfile(fixture.organisationId, { occupierRole: "tenant" });

    const state = await preview("01-template-ordinary.csv");
    assert.ok(state.sealed, "the plan is sealed for the confirmation");
    assert.equal(state.plan?.counts.create, 2);
    assert.ok(
      (state.plan?.counts.unchanged ?? 0) + (state.plan?.counts.conflict ?? 0) >= 1,
      "the row matching the fixture's own property is recognised, not duplicated",
    );

    const done = await confirm(state.sealed);
    assert.equal(done.done?.created, 2);
    assert.equal(done.done?.failed, 0);

    const properties = await propertiesOf(fixture.organisationId);
    /* The fixture's own property, plus the two genuinely new ones. */
    assert.equal(properties.length, 3);

    /*
      The occupier column means "tenant" for this fictional agency because
      that is what the profile says — and a tenancy is only ever created on
      that confirmation.
    */
    assert.ok(
      (await count("tenancy")) > 0,
      "a confirmed occupier role records a tenancy",
    );
  });

  test("an unconfirmed occupier column records no tenancy at all", async () => {
    /*
      **The rule that matters most in onboarding.** A second person-name column
      whose meaning nobody has confirmed is not a tenant. Inventing one is how
      a caretaker receives a tenant's scheduling link. The name is kept where
      an engineer can see it and claims nothing.
    */
    await configureProfile(fixture.organisationId, { occupierRole: "unknown" });

    const state = await preview("01-template-ordinary.csv");
    assert.ok(state.sealed);
    await confirm(state.sealed);

    assert.equal(
      await count("tenancy"),
      0,
      "nothing asserts who lives there",
    );
  });

  test("importing books no work and contacts nobody", async () => {
    await configureProfile(fixture.organisationId);
    const state = await preview("01-template-ordinary.csv");
    assert.ok(state.sealed);
    await confirm(state.sealed);

    assert.equal(await count("job"), 1, "only the fixture's own job");
    assert.equal(
      await count("outbound_email"),
      0,
      "no tenant, landlord or agent was written to",
    );
    assert.equal(await count("scheduling_token"), 0);
  });
});

describe("a landlord with no email address", () => {
  const FILE = "02-missing-landlord-contact.csv";

  test("hold the row: nothing is written for it, and the preview says why", async () => {
    await configureProfile(fixture.organisationId, {
      landlordMatch: "reject_row",
    });

    const state = await preview(FILE);
    assert.ok(state.plan);
    const held = state.plan.rows.filter(
      (row) => row.action === "error" || row.landlordChoiceRequired,
    );
    assert.ok(
      held.length >= 2,
      `the two contactless rows are held, got ${held.length}`,
    );

    assert.ok(state.sealed);
    const done = await confirm(state.sealed);
    assert.equal(done.done?.created, 1, "only the row that carries an email");

    const properties = await propertiesOf(fixture.organisationId);
    assert.equal(
      properties.filter((row) => row.postcode === "WV3 3CC").length,
      1,
    );
  });

  test("record without contact: the property is on file, with nothing invented", async () => {
    await configureProfile(fixture.organisationId, {
      landlordMatch: "record_without_contact",
    });

    const state = await preview(FILE);
    assert.ok(state.sealed);
    const done = await confirm(state.sealed);
    assert.equal(done.done?.created, 3, "all three are recorded");

    /*
      And not one contact detail was made up. A landlord recorded from a row
      with no email has no email — which is what the file said.
    */
    const { rows } = await conn.client.query<{ name: string; email: string | null }>(
      `select name, email from customer
        where agent_organisation_id = $1 and name like '%Holding%'
        order by name`,
      [fixture.organisationId],
    );
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      if (row.name === "Cara Holding") {
        assert.equal(row.email, null, "no address was invented for them");
      }
    }
  });

  test("match by name: an unanswered suggestion holds the row", async () => {
    /*
      A name is evidence, not identity. The preview may suggest a landlord the
      agency already has; until somebody answers, the row is held — because
      attaching a property, and the invoices that follow it, to somebody who
      merely shares a name is not a mistake that shows up quickly.
    */
    await conn.client.query(
      `insert into customer (agent_organisation_id, type, name, email)
       values ($1, 'landlord', 'Cara Holding', 'cara@holding.example.invalid')`,
      [fixture.organisationId],
    );
    await configureProfile(fixture.organisationId, {
      landlordMatch: "match_existing_by_name",
    });

    const state = await preview(FILE);
    assert.ok(state.sealed);

    /* Answering nothing. */
    const done = await confirm(state.sealed);
    const created = done.done?.created ?? 0;
    assert.ok(
      created < 3,
      `an unanswered identity question holds its row, created ${created}`,
    );
  });

  test("and answering it attaches the property to the landlord they chose", async () => {
    const { rows: existing } = await conn.client.query<{ id: string }>(
      `insert into customer (agent_organisation_id, type, name, email)
       values ($1, 'landlord', 'Cara Holding', 'cara@holding.example.invalid')
       returning id`,
      [fixture.organisationId],
    );
    await configureProfile(fixture.organisationId, {
      landlordMatch: "match_existing_by_name",
    });

    const state = await preview(FILE);
    assert.ok(state.sealed && state.plan);

    const answers: Record<number, { landlord: string }> = {};
    for (const row of state.plan.rows) {
      if (row.landlordChoiceRequired) answers[row.line] = { landlord: "existing" };
    }
    assert.ok(
      Object.keys(answers).length > 0,
      "the preview asked who the landlord is",
    );
    const done = await confirm(state.sealed, answers);
    assert.ok((done.done?.created ?? 0) >= 1);

    /*
      The same landlord, not a second one of the same name. The browser could
      only accept or decline the suggestion the preview made — it never named
      an id — and `createProperty` re-checked that the landlord is this
      agency's.
    */
    assert.equal(
      await count(
        "customer",
        "where agent_organisation_id = $1 and name = 'Cara Holding'",
        [fixture.organisationId],
      ),
      1,
      "no duplicate landlord was created",
    );
    const attached = await count(
      "property",
      "where customer_id = $1",
      [existing[0].id],
    );
    assert.ok(attached >= 1, "the property is on the landlord they chose");
  });
});

describe("uploading the same file again", () => {
  test("reports what already matches rather than creating it twice", async () => {
    await configureProfile(fixture.organisationId);

    const first = await preview("01-template-ordinary.csv");
    assert.ok(first.sealed);
    const firstDone = await confirm(first.sealed);
    assert.equal(firstDone.done?.created, 2);

    const again = await preview("01-template-ordinary.csv");
    assert.ok(again.plan);
    assert.equal(
      again.plan.counts.create,
      0,
      "nothing is proposed as new the second time",
    );

    assert.ok(again.sealed);
    const secondDone = await confirm(again.sealed);
    assert.equal(secondDone.done?.created, 0);

    /*
      **The database is what enforces this**, not the plan. An agency's
      addresses are unique, so even a plan that proposed a duplicate could not
      write one.
    */
    const properties = await propertiesOf(fixture.organisationId);
    assert.equal(properties.length, 3, "two imported, plus the fixture's own");
  });

  test("submitting the very same review twice writes once and says so", async () => {
    await configureProfile(fixture.organisationId);
    const state = await preview("01-template-ordinary.csv");
    assert.ok(state.sealed);

    const first = await confirm(state.sealed);
    assert.equal(first.done?.created, 2);

    /* A refresh, a double-click, a second tab. */
    const repeat = await confirm(state.sealed);
    assert.equal(repeat.done?.repeat, true, "recognised as the same submission");
    assert.equal(
      (await propertiesOf(fixture.organisationId)).length,
      3,
      "and nothing was written a second time",
    );
  });

  test("two clicks at once still import once", async () => {
    await configureProfile(fixture.organisationId);
    const state = await preview("01-template-ordinary.csv");
    assert.ok(state.sealed);

    const [a, b] = await Promise.all([
      confirm(state.sealed),
      confirm(state.sealed),
    ]);

    assert.ok(a.done || b.done, "at least one completed");
    assert.equal(
      (await propertiesOf(fixture.organisationId)).length,
      3,
      "one import, whichever click won",
    );
  });
});

describe("two agencies on one system", () => {
  test("each imports the same file and gets its own portfolio", async () => {
    await configureProfile(fixture.organisationId);
    await configureProfile(fixture.otherOrganisationId);

    const mine = await preview("01-template-ordinary.csv");
    assert.ok(mine.sealed);
    await confirm(mine.sealed);

    sessionOrg = fixture.otherOrganisationId;
    sessionUser = fixture.otherAgentUserId;

    const theirs = await preview("01-template-ordinary.csv");
    assert.ok(theirs.plan, "the same addresses are new to them");
    /*
      The rival agency has no property matching the fixture's, so all three
      rows are genuinely new to them — proving that "already held" was scoped
      to the agency that imported first, not to the address in general.
    */
    assert.equal(
      theirs.plan.counts.create,
      3,
      "another agency's portfolio is not a reason to skip a row",
    );
    assert.ok(theirs.sealed);
    const done = await confirm(theirs.sealed);
    assert.equal(done.done?.created, 3);

    /* Two portfolios, each complete, neither aware of the other. */
    assert.equal((await propertiesOf(fixture.organisationId)).length, 3);
    assert.equal((await propertiesOf(fixture.otherOrganisationId)).length, 3);
  });

  test("a portfolio read is scoped to the agency, not to the address", async () => {
    await configureProfile(fixture.organisationId);
    const mine = await preview("01-template-ordinary.csv");
    assert.ok(mine.sealed);
    await confirm(mine.sealed);

    const { listPortfolio } = await import("../../src/lib/portfolio/queries");
    const ours = await listPortfolio(fixture.organisationId);
    const rival = await listPortfolio(fixture.otherOrganisationId);

    assert.ok((ours ?? []).length >= 3);
    assert.equal(
      (rival ?? []).length,
      0,
      "the rival agency sees none of what we imported",
    );
  });

  test("a plan sealed for one agency cannot be confirmed by another", async () => {
    /*
      The envelope is signed with the organisation in it. Moving it to another
      session is the attack this closes, and it fails at the seal rather than
      at a later ownership check.
    */
    await configureProfile(fixture.organisationId);
    const mine = await preview("01-template-ordinary.csv");
    assert.ok(mine.sealed);

    sessionOrg = fixture.otherOrganisationId;
    sessionUser = fixture.otherAgentUserId;

    const stolen = await confirm(mine.sealed);
    assert.ok(stolen.error, "refused");
    assert.equal(
      (await propertiesOf(fixture.otherOrganisationId)).length,
      0,
      "and nothing was written for them",
    );
  });

  test("a profile changed between preview and confirm invalidates the review", async () => {
    /*
      A preview is a reading of a file under a specific profile. If BSCJ
      corrects the profile in between, confirming would write under a reading
      nobody reviewed.
    */
    await configureProfile(fixture.organisationId, {
      landlordMatch: "reject_row",
    });
    const state = await preview("02-missing-landlord-contact.csv");
    assert.ok(state.sealed);

    await configureProfile(fixture.organisationId, {
      landlordMatch: "record_without_contact",
    });

    const done = await confirm(state.sealed);
    assert.ok(done.error, "the review is refused rather than reinterpreted");
    assert.match(done.error, /upload the file again/i);
  });
});
