import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  connect,
  reset,
  start,
  stop,
  type Connection,
} from "../support/disposable-postgres";
import { setDbForTesting } from "../../src/lib/db/client";
import {
  DEFAULT_PAGE_SIZE,
  jobProductsCovering,
  listDueWork,
} from "../../src/lib/compliance/due-work";

/**
 * The renewals query, against a real database.
 *
 * Every fault this covers produced a different flavour of wrong number, and
 * none of them was visible against a fake: joined rows multiplying, a boiler
 * service standing in for a CP12, a five-hundred-row limit applied before
 * bucketing so the unknown dates fell off the end, and a date filter that could
 * not reach what the limit had already discarded.
 *
 * So the fixtures are deliberately larger than that limit.
 */

const TODAY = "2026-09-22";
const RANGE = { from: "2026-09-22", to: "2026-11-21" };

let conn: Connection;

before(async () => {
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
});

// ---------------------------------------------------------------------------
// Fixtures, written through SQL because they are *starting state*, not the
// journey. The business actions are exercised in `journey.test.ts`.
// ---------------------------------------------------------------------------

async function agency(name: string): Promise<string> {
  const { rows } = await conn.client.query<{ id: string }>(
    `insert into agent_organisation (name, email) values ($1, $2) returning id`,
    [name, `${name.toLowerCase().replace(/[^a-z]+/g, "-")}@fixture.example.invalid`],
  );
  return rows[0].id;
}

async function landlord(organisationId: string | null, name: string): Promise<string> {
  const { rows } = await conn.client.query<{ id: string }>(
    `insert into customer (agent_organisation_id, type, name)
     values ($1, 'landlord', $2) returning id`,
    [organisationId, name],
  );
  return rows[0].id;
}

async function property(input: {
  organisationId: string | null;
  customerId: string;
  houseOrName: string;
  postcode?: string;
}): Promise<string> {
  const { rows } = await conn.client.query<{ id: string }>(
    `insert into property
       (agent_organisation_id, customer_id, house_or_name, street, postcode)
     values ($1, $2, $3, 'Fixture Street', $4) returning id`,
    [
      input.organisationId,
      input.customerId,
      input.houseOrName,
      input.postcode ?? "WV1 1AA",
    ],
  );
  return rows[0].id;
}

async function cycle(input: {
  propertyId: string;
  organisationId: string | null;
  productId: string;
  dueDate: string;
}): Promise<string> {
  const { rows } = await conn.client.query<{ id: string }>(
    `insert into compliance_cycle
       (property_id, agent_organisation_id, product_id, due_date, due_date_source, status)
     values ($1, $2, $3, $4, 'manual', 'active') returning id`,
    [input.propertyId, input.organisationId, input.productId, input.dueDate],
  );
  return rows[0].id;
}

let jobCounter = 0;

async function job(input: {
  propertyId: string;
  organisationId: string | null;
  customerId: string;
  productId: string;
  status?: string;
}): Promise<{ id: string; reference: string }> {
  jobCounter += 1;
  const reference = `BSCJ-T${String(jobCounter).padStart(5, "0")}`;
  const { rows } = await conn.client.query<{ id: string }>(
    `insert into job
       (reference, idempotency_key, agent_organisation_id, customer_id,
        billing_customer_id, property_id, product_id, source, scheduling_method,
        lifecycle_status, appliance_count, price_total_pence,
        customer_snapshot, property_snapshot, price_snapshot)
     values ($1, $1, $2, $3, $3, $4, $5, 'portal', 'tenant_selected', $6, 1, 4500,
             '{"name":"Ada Fixture"}'::jsonb,
             '{"postcode":"WV1 1AA"}'::jsonb,
             '{"totalPence":4500}'::jsonb) returning id`,
    [
      reference,
      input.organisationId,
      input.customerId,
      input.propertyId,
      input.productId,
      input.status ?? "scheduled",
    ],
  );
  return { id: rows[0].id, reference };
}

const listing = (overrides: Partial<Parameters<typeof listDueWork>[0]> = {}) =>
  listDueWork({ range: RANGE, today: TODAY, ...overrides });

// ---------------------------------------------------------------------------

describe("which job products cover which service", () => {
  test("a CP12 cycle is covered by a CP12 job and by the bundle", () => {
    assert.deepEqual(jobProductsCovering("cp12").sort(), [
      "cp12",
      "cp12-boiler-service",
    ]);
  });

  test("a boiler-service cycle is covered by the service and by the bundle", () => {
    assert.deepEqual(jobProductsCovering("boiler-service").sort(), [
      "boiler-service",
      "cp12-boiler-service",
    ]);
  });

  test("and a boiler service does not cover a CP12", () => {
    assert.equal(jobProductsCovering("cp12").includes("boiler-service"), false);
  });
});

describe("rows are not multiplied by jobs", () => {
  test("two active cycles and three open jobs make two rows, not six", async () => {
    /*
      **The defect.** Both joins on one query meant a property with two services
      and three open jobs became six rows and was counted six times.
    */
    const org = await agency("Fixture Lettings");
    const owner = await landlord(org, "Ada Fixture");
    const prop = await property({ organisationId: org, customerId: owner, houseOrName: "14" });

    await cycle({ propertyId: prop, organisationId: org, productId: "cp12", dueDate: "2026-10-01" });
    await cycle({
      propertyId: prop,
      organisationId: org,
      productId: "boiler-service",
      dueDate: "2026-10-15",
    });
    for (const productId of ["cp12", "boiler-service", "cp12-boiler-service"]) {
      await job({ propertyId: prop, organisationId: org, customerId: owner, productId });
    }

    const result = await listing();
    assert.ok(result);
    assert.equal(result.rows.length, 2);
    assert.equal(result.summary.matching, 2);
    assert.equal(result.summary.inRange, 2);
  });

  test("the row key is the property and the service, so two rows never collide", async () => {
    const org = await agency("Fixture Lettings");
    const owner = await landlord(org, "Ada Fixture");
    const prop = await property({ organisationId: org, customerId: owner, houseOrName: "14" });
    await cycle({ propertyId: prop, organisationId: org, productId: "cp12", dueDate: "2026-10-01" });
    await cycle({
      propertyId: prop,
      organisationId: org,
      productId: "boiler-service",
      dueDate: "2026-10-15",
    });

    const result = await listing();
    const keys = result!.rows.map((row) => row.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.every((key) => key.includes(":")));
  });
});

describe("an open job only covers the service it is for", () => {
  test("a boiler-service job does not make an outstanding CP12 look covered", async () => {
    /*
      The dangerous one. An operator seeing "already in hand" against a CP12
      leaves it alone, and the certificate lapses while a screen says it is
      being dealt with.
    */
    const org = await agency("Fixture Lettings");
    const owner = await landlord(org, "Ada Fixture");
    const prop = await property({ organisationId: org, customerId: owner, houseOrName: "14" });
    await cycle({ propertyId: prop, organisationId: org, productId: "cp12", dueDate: "2026-10-01" });
    await job({
      propertyId: prop,
      organisationId: org,
      customerId: owner,
      productId: "boiler-service",
    });

    const [row] = (await listing())!.rows;
    assert.equal(row.productId, "cp12");
    assert.deepEqual(row.jobs, []);
  });

  test("a combined job covers the CP12 renewal", async () => {
    const org = await agency("Fixture Lettings");
    const owner = await landlord(org, "Ada Fixture");
    const prop = await property({ organisationId: org, customerId: owner, houseOrName: "14" });
    await cycle({ propertyId: prop, organisationId: org, productId: "cp12", dueDate: "2026-10-01" });
    const raised = await job({
      propertyId: prop,
      organisationId: org,
      customerId: owner,
      productId: "cp12-boiler-service",
    });

    const [row] = (await listing())!.rows;
    assert.equal(row.jobs.length, 1);
    assert.equal(row.jobs[0].reference, raised.reference);
  });

  test("a combined job covers the boiler-service renewal too", async () => {
    const org = await agency("Fixture Lettings");
    const owner = await landlord(org, "Ada Fixture");
    const prop = await property({ organisationId: org, customerId: owner, houseOrName: "14" });
    await cycle({
      propertyId: prop,
      organisationId: org,
      productId: "boiler-service",
      dueDate: "2026-10-01",
    });
    await job({
      propertyId: prop,
      organisationId: org,
      customerId: owner,
      productId: "cp12-boiler-service",
    });

    const [row] = (await listing())!.rows;
    assert.equal(row.jobs.length, 1);
  });

  test("several covering jobs are all reported, not one chosen arbitrarily", async () => {
    const org = await agency("Fixture Lettings");
    const owner = await landlord(org, "Ada Fixture");
    const prop = await property({ organisationId: org, customerId: owner, houseOrName: "14" });
    await cycle({ propertyId: prop, organisationId: org, productId: "cp12", dueDate: "2026-10-01" });
    await job({ propertyId: prop, organisationId: org, customerId: owner, productId: "cp12" });
    await job({
      propertyId: prop,
      organisationId: org,
      customerId: owner,
      productId: "cp12-boiler-service",
    });

    const [row] = (await listing())!.rows;
    assert.equal(row.jobs.length, 2);
    // Still one row: the jobs are a list on it, not a source of rows.
    assert.equal((await listing())!.rows.length, 1);
  });

  test("a completed or cancelled job is not in hand", async () => {
    const org = await agency("Fixture Lettings");
    const owner = await landlord(org, "Ada Fixture");
    const prop = await property({ organisationId: org, customerId: owner, houseOrName: "14" });
    await cycle({ propertyId: prop, organisationId: org, productId: "cp12", dueDate: "2026-10-01" });
    await job({
      propertyId: prop,
      organisationId: org,
      customerId: owner,
      productId: "cp12",
      status: "completed",
    });
    await job({
      propertyId: prop,
      organisationId: org,
      customerId: owner,
      productId: "cp12",
      status: "cancelled",
    });

    const [row] = (await listing())!.rows;
    assert.deepEqual(row.jobs, []);
  });
});

describe("more properties than the old limit", () => {
  /** 520 properties: 500 in range, 10 with no date, 10 overdue. */
  async function seedLargePortfolio() {
    const org = await agency("Fixture Lettings");
    const owner = await landlord(org, "Ada Fixture");

    for (let index = 0; index < 500; index += 1) {
      const prop = await property({
        organisationId: org,
        customerId: owner,
        houseOrName: `R${index}`,
        postcode: `WV1 ${index % 9}AA`,
      });
      await cycle({
        propertyId: prop,
        organisationId: org,
        productId: "cp12",
        dueDate: "2026-10-05",
      });
    }
    for (let index = 0; index < 10; index += 1) {
      await property({
        organisationId: org,
        customerId: owner,
        houseOrName: `U${index}`,
        postcode: "WV9 9ZZ",
      });
    }
    for (let index = 0; index < 10; index += 1) {
      const prop = await property({
        organisationId: org,
        customerId: owner,
        houseOrName: `O${index}`,
        postcode: "WV8 8YY",
      });
      await cycle({
        propertyId: prop,
        organisationId: org,
        productId: "cp12",
        dueDate: "2026-01-01",
      });
    }
    return org;
  }

  test("the totals are of everything matching, not of a page", async () => {
    await seedLargePortfolio();
    const result = await listing();

    assert.equal(result!.summary.overdue, 10);
    assert.equal(result!.summary.inRange, 500);
    assert.equal(result!.summary.unknown, 10);
    assert.equal(result!.summary.matching, 520);
    assert.equal(result!.rows.length, DEFAULT_PAGE_SIZE);
  });

  test("properties with no date on file can still be reached", async () => {
    /*
      **The defect.** Unknown dates sort last, the limit cut at 500, and the ten
      properties nobody has a certificate for — the most actionable rows on the
      screen — silently did not exist.
    */
    await seedLargePortfolio();

    const seen: string[] = [];
    for (let page = 0; page < 11; page += 1) {
      const result = await listing({ page });
      for (const row of result!.rows) {
        if (row.bucket === "unknown") seen.push(row.key);
      }
    }
    assert.equal(seen.length, 10);
    assert.equal(new Set(seen).size, 10);
  });

  test("every matching row appears exactly once across the pages", async () => {
    await seedLargePortfolio();

    const keys: string[] = [];
    const first = await listing();
    for (let page = 0; page < first!.totalPages; page += 1) {
      const result = await listing({ page });
      keys.push(...result!.rows.map((row) => row.key));
    }

    assert.equal(keys.length, 520);
    assert.equal(new Set(keys).size, 520, "no row is repeated or skipped");
  });

  test("overdue rows lead, and are never displaced by the page size", async () => {
    await seedLargePortfolio();
    const result = await listing();
    assert.equal(
      result!.rows.slice(0, 10).every((row) => row.bucket === "overdue"),
      true,
    );
  });

  test("narrowing the range changes what matches, in the database", async () => {
    /*
      The filter is the query's now. Before, it was applied to a page that had
      already been cut, so a row the limit discarded could never come back.
    */
    await seedLargePortfolio();

    const narrow = await listDueWork({
      range: { from: "2026-09-22", to: "2026-09-30" },
      today: TODAY,
    });
    // The 500 due on 5 October are outside it; overdue and unknown remain.
    assert.equal(narrow!.summary.matching, 20);
    assert.equal(narrow!.summary.later, 500);

    const wide = await listing();
    assert.equal(wide!.summary.matching, 520);
  });

  test("`include later` is a query, and the totals agree with it", async () => {
    await seedLargePortfolio();

    const narrow = await listDueWork({
      range: { from: "2026-09-22", to: "2026-09-30" },
      today: TODAY,
      includeLater: true,
    });
    assert.equal(narrow!.summary.matching, 520);
  });
});

describe("what appears and what does not", () => {
  test("an inactive property is not renewal work", async () => {
    const org = await agency("Fixture Lettings");
    const owner = await landlord(org, "Ada Fixture");
    const prop = await property({ organisationId: org, customerId: owner, houseOrName: "14" });
    await cycle({ propertyId: prop, organisationId: org, productId: "cp12", dueDate: "2026-10-01" });
    await conn.client.query("update property set is_active = false where id = $1", [prop]);

    assert.equal((await listing())!.summary.matching, 0);
  });

  test("a superseded position is history, not an outstanding renewal", async () => {
    const org = await agency("Fixture Lettings");
    const owner = await landlord(org, "Ada Fixture");
    const prop = await property({ organisationId: org, customerId: owner, houseOrName: "14" });
    const id = await cycle({
      propertyId: prop,
      organisationId: org,
      productId: "cp12",
      dueDate: "2026-10-01",
    });
    await conn.client.query(
      "update compliance_cycle set status = 'superseded' where id = $1",
      [id],
    );

    const result = await listing();
    // The property is still listed — now as "no date on file", which is true.
    assert.equal(result!.summary.matching, 1);
    assert.equal(result!.rows[0].bucket, "unknown");
    assert.equal(result!.rows[0].productId, null);
  });

  test("a direct customer's property is listed with no agency", async () => {
    const owner = await landlord(null, "Private Customer");
    const prop = await property({ organisationId: null, customerId: owner, houseOrName: "9" });
    await cycle({ propertyId: prop, organisationId: null, productId: "cp12", dueDate: "2026-10-01" });

    const [row] = (await listing())!.rows;
    assert.equal(row.organisationId, null);
    assert.equal(row.organisationName, null);
    assert.equal(row.landlordName, "Private Customer");
  });
});
