import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  DISPOSABLE_URL,
  NotDisposableError,
  assertDisposable,
  connect,
  reset,
  start,
  stop,
  type Connection,
} from "../support/disposable-postgres";
import { complianceCycles, customers } from "../../src/lib/db/schema";

/**
 * The harness itself, before anything is trusted to it.
 *
 * Two things have to be true or every integration claim built on this is
 * worthless: it is a **real** Postgres with the **real** migration chain
 * applied, and it cannot reach anything that is not disposable.
 */

let a: Connection;
let b: Connection;

before(async () => {
  await start();
  a = await connect();
  b = await connect();
});

after(async () => {
  await stop();
});

describe("it refuses anything that is not its own server", () => {
  test("a production-looking Neon URL", () => {
    assert.throws(
      () => assertDisposable("postgresql://user:pw@ep-cool-name.eu-west-2.aws.neon.tech/main"),
      NotDisposableError,
    );
  });

  test("the right database on the wrong host", () => {
    assert.throws(
      () => assertDisposable("postgresql://bscj_disposable:x@db.example.com:55433/bscj_disposable_test"),
      NotDisposableError,
    );
  });

  test("loopback, but the ordinary Postgres port", () => {
    // Somebody's own development server lives there.
    assert.throws(
      () => assertDisposable("postgresql://bscj_disposable:x@127.0.0.1:5432/bscj_disposable_test"),
      NotDisposableError,
    );
  });

  test("the harness port, but a different database", () => {
    assert.throws(
      () => assertDisposable("postgresql://bscj_disposable:x@127.0.0.1:55433/bscj_dev"),
      NotDisposableError,
    );
  });

  test("its own URL is accepted", () => {
    assert.doesNotThrow(() => assertDisposable(DISPOSABLE_URL));
  });

  test("and is refused again once no harness owns the run", async () => {
    const marker = process.env.BSCJ_DISPOSABLE_DB;
    delete process.env.BSCJ_DISPOSABLE_DB;
    try {
      assert.throws(() => assertDisposable(DISPOSABLE_URL), NotDisposableError);
    } finally {
      process.env.BSCJ_DISPOSABLE_DB = marker;
    }
  });

  test("no inherited DATABASE_URL survives starting it", () => {
    for (const key of Object.keys(process.env)) {
      assert.equal(
        key.startsWith("DATABASE_URL"),
        false,
        `${key} is still set; the harness must not be able to fall back to it`,
      );
    }
  });
});

describe("it is a real PostgreSQL", () => {
  test("it reports a real version", async () => {
    const { rows } = await a.client.query<{ v: string }>("select version() as v");
    assert.match(rows[0].v, /^PostgreSQL 1[0-9]/);
  });

  test("two connections are two backends", async () => {
    // Not two handles onto one session: two processes, which is what a race
    // between them needs in order to mean anything.
    const [first, second] = await Promise.all([a.backendPid(), b.backendPid()]);
    assert.notEqual(first, second);
  });
});

describe("the real migration chain is applied", () => {
  test("every committed migration has run", async () => {
    const { rows } = await a.client.query<{ n: string }>(
      "select count(*)::text as n from drizzle.__drizzle_migrations",
    );
    // 0000 through 0012.
    assert.equal(Number(rows[0].n), 13);
  });

  test("the tables and enums a fully migrated deployment has are here", async () => {
    const tables = await a.client.query<{ n: string }>(
      "select count(*)::text as n from pg_tables where schemaname = 'public'",
    );
    const enums = await a.client.query<{ n: string }>(
      "select count(*)::text as n from pg_type where typtype = 'e'",
    );
    /*
      25 tables, not 24. `0010` adds `certificate_draft` — the engineer's
      server-held gas safety record — and adds no enum.

      **The pilot is at 24 until `0010` is applied**, which is the deployment
      order in the runbook: migrate, then push. This asserts the chain as it
      stands on disk, which is what a deployment ends up with.
    */
    assert.equal(Number(tables.rows[0].n), 25);
    assert.equal(Number(enums.rows[0].n), 22);
  });

  test("0009's partial unique index exists and is partial", async () => {
    const { rows } = await a.client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where indexname = 'compliance_cycle_one_active_per_service'`,
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /UNIQUE/i);
    assert.match(rows[0].indexdef, /WHERE \(status = 'active'/i);
  });

  test("0008 left the landlord contact columns nullable", async () => {
    const { rows } = await a.client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_name = 'customer' and column_name in ('email', 'phone')
        order by column_name`,
    );
    assert.deepEqual(rows, [
      { column_name: "email", is_nullable: "YES" },
      { column_name: "phone", is_nullable: "YES" },
    ]);
  });
});

describe("constraints are the database's, not ours", () => {
  test("a landlord with no contact details is accepted", async () => {
    await reset(a);
    const [row] = await a.db
      .insert(customers)
      .values({ type: "landlord", name: "Ada Fixture" })
      .returning({ id: customers.id });
    assert.ok(row.id);
  });

  test("two active positions for one service are refused by Postgres", async () => {
    await reset(a);
    const propertyId = await seedProperty(a);

    await a.db.insert(complianceCycles).values({
      propertyId,
      productId: "cp12",
      dueDate: "2027-01-01",
      dueDateSource: "manual",
      status: "active",
    });

    await assert.rejects(
      () =>
        a.db.insert(complianceCycles).values({
          propertyId,
          productId: "cp12",
          dueDate: "2027-06-01",
          dueDateSource: "manual",
          status: "active",
        }),
      /*
        Drizzle wraps the driver's error, so the SQLSTATE is on the cause. The
        code is what matters: 23505 is Postgres refusing, not us.
      */
      (error: { cause?: { code?: string } }) => error.cause?.code === "23505",
      "the partial unique index must raise a unique violation",
    );
  });

  test("a second position for a different service is allowed", async () => {
    await reset(a);
    const propertyId = await seedProperty(a);

    await a.db.insert(complianceCycles).values({
      propertyId,
      productId: "cp12",
      dueDate: "2027-01-01",
      dueDateSource: "manual",
      status: "active",
    });
    await assert.doesNotReject(() =>
      a.db.insert(complianceCycles).values({
        propertyId,
        productId: "boiler-service",
        dueDate: "2027-02-01",
        dueDateSource: "manual",
        status: "active",
      }),
    );
  });

  test("superseded positions may repeat, because history is meant to", async () => {
    await reset(a);
    const propertyId = await seedProperty(a);

    for (const dueDate of ["2025-01-01", "2026-01-01", "2027-01-01"]) {
      await a.db.insert(complianceCycles).values({
        propertyId,
        productId: "cp12",
        dueDate,
        dueDateSource: "manual",
        status: "superseded",
      });
    }
    const { rows } = await a.client.query<{ n: string }>(
      "select count(*)::text as n from compliance_cycle",
    );
    assert.equal(Number(rows[0].n), 3);
  });
});

describe("the batch shim is a real transaction", () => {
  test("a failing statement rolls the whole batch back", async () => {
    await reset(a);
    const propertyId = await seedProperty(a);

    await assert.rejects(() =>
      a.db.batch([
        a.db.insert(complianceCycles).values({
          propertyId,
          productId: "cp12",
          dueDate: "2027-01-01",
          dueDateSource: "manual",
          status: "active",
        }),
        // Same service, same property, both active: refused by 0009.
        a.db.insert(complianceCycles).values({
          propertyId,
          productId: "cp12",
          dueDate: "2027-02-01",
          dueDateSource: "manual",
          status: "active",
        }),
      ]),
    );

    const { rows } = await a.client.query<{ n: string }>(
      "select count(*)::text as n from compliance_cycle",
    );
    // Not one, not two. The first insert went back with the second.
    assert.equal(Number(rows[0].n), 0);
  });
});

/** A property with its landlord, for a test that only needs somewhere to hang. */
async function seedProperty(connection: Connection): Promise<string> {
  const [landlord] = await connection.db
    .insert(customers)
    .values({ type: "landlord", name: "Ada Fixture" })
    .returning({ id: customers.id });

  const { rows } = await connection.client.query<{ id: string }>(
    `insert into property (customer_id, house_or_name, street, postcode)
     values ($1, '14', 'Fixture Street', 'WV1 1AA') returning id`,
    [landlord.id],
  );
  return rows[0].id;
}
