/**
 * A running application on a throwaway database, for browser acceptance.
 *
 *     node --experimental-strip-types --import ./scripts/test-resolver.mjs \
 *       test/support/browser-session.ts
 *
 * Starts the disposable PostgreSQL, applies the real migration chain, seeds
 * fictional accounts and portfolio data, starts the real Next server with an
 * isolated environment, prints the sign-in details, and stays up until it is
 * killed.
 *
 * **Every account here has a real password hash**, produced by the
 * application's own `hashPassword`, and every sign-in goes through the ordinary
 * login form. Nothing weakens a check or adds a route production would also
 * have.
 *
 * **Everything in it is fictional.** `.example.invalid` cannot receive mail,
 * and the external services are given absent values so no calendar, queue,
 * store or provider is reachable.
 */

import { hashPassword } from "../../src/lib/auth/password";
import {
  connect,
  reset,
  start,
  stop,
  type Connection,
} from "./disposable-postgres";
import { seed, type Fixture } from "./fixtures";
import { BASE_URL, startServer, stopServer } from "./browser-server";

/** Long enough for the application's own rule, and obviously not a secret. */
const PASSWORD = "fixture-password-not-a-secret";

async function giveEveryoneAPassword(connection: Connection): Promise<void> {
  const hash = await hashPassword(PASSWORD);
  await connection.client.query(
    `update app_user set password_hash = $1, password_set_at = now()`,
    [hash],
  );
}

/**
 * Enough portfolio for the renewals view to be worth looking at.
 *
 * Deliberately more rows than one page, with an overdue one, one inside the
 * default range, one with no date at all, and a boiler-service job that must
 * not appear to cover a CP12.
 */
async function seedRenewals(connection: Connection, fixture: Fixture) {
  const q = connection.client;

  const property = async (houseOrName: string, postcode: string) => {
    const { rows } = await q.query<{ id: string }>(
      `insert into property
         (agent_organisation_id, customer_id, house_or_name, street, postcode)
       values ($1, $2, $3, 'Renewal Street', $4) returning id`,
      [fixture.organisationId, fixture.landlordId, houseOrName, postcode],
    );
    return rows[0].id;
  };

  const cycle = async (propertyId: string, productId: string, dueDate: string) => {
    await q.query(
      `insert into compliance_cycle
         (property_id, agent_organisation_id, product_id, due_date,
          due_date_source, status)
       values ($1, $2, $3, $4, 'manual', 'active')`,
      [propertyId, fixture.organisationId, productId, dueDate],
    );
  };

  // One overdue, with an open CP12 job already covering it.
  const overdue = await property("1", "WV3 1AA");
  await cycle(overdue, "cp12", "2026-01-15");
  await job(connection, fixture, {
    propertyId: overdue,
    productId: "cp12",
    reference: "BSCJ-OPEN01",
  });

  /*
    Overdue, with an open **boiler-service** job. The renewals view must not
    present that as the CP12 being in hand — a certificate would lapse while a
    screen said it was being dealt with.
  */
  const mismatched = await property("2", "WV3 2AA");
  await cycle(mismatched, "cp12", "2026-02-20");
  await job(connection, fixture, {
    propertyId: mismatched,
    productId: "boiler-service",
    reference: "BSCJ-OPEN02",
  });

  // A property owing two services on different dates: two rows, one property.
  const twoServices = await property("3", "WV3 3AA");
  await cycle(twoServices, "cp12", "2026-10-10");
  await cycle(twoServices, "boiler-service", "2026-11-05");

  // No date on file at all — an import with no expiry column.
  await property("4", "WV3 4AA");

  // Enough beyond the first page to make pagination real.
  for (let index = 0; index < 60; index += 1) {
    const id = await property(`P${index}`, `WV4 ${index % 9}AA`);
    await cycle(id, "cp12", "2026-10-20");
  }
}

let jobCounter = 0;

async function job(
  connection: Connection,
  fixture: Fixture,
  input: { propertyId: string; productId: string; reference?: string },
) {
  jobCounter += 1;
  const reference = input.reference ?? `BSCJ-SEED${jobCounter}`;
  await connection.client.query(
    `insert into job
       (reference, idempotency_key, agent_organisation_id, customer_id,
        billing_customer_id, property_id, product_id, source, scheduling_method,
        lifecycle_status, appliance_count, price_total_pence,
        customer_snapshot, property_snapshot, price_snapshot)
     values ($1, $1, $2, $3, $3, $4, $5, 'portal', 'tenant_selected',
             'scheduled', 1, 4500,
             '{"name":"Ada Fixture"}'::jsonb,
             '{"postcode":"WV1 1AA"}'::jsonb,
             '{"totalPence":4500}'::jsonb)`,
    [
      reference,
      fixture.organisationId,
      fixture.landlordId,
      input.propertyId,
      input.productId,
    ],
  );
}

/** Landlords the same-name identity choice needs to find. */
async function seedLandlords(connection: Connection, fixture: Fixture) {
  for (const name of ["Ada Sample", "J Smith", "J Smith"]) {
    await connection.client.query(
      `insert into customer (agent_organisation_id, type, name, email)
       values ($1, 'landlord', $2, $3)`,
      [
        fixture.organisationId,
        name,
        // A different address each time, so nothing collides on email.
        `${name.toLowerCase().replace(/\s+/g, "-")}-${Math.random().toString(36).slice(2, 8)}@fixture.example.invalid`,
      ],
    );
  }
}

/** A message that has given up, so the retry control has something to act on. */
async function seedFailedMessage(connection: Connection, fixture: Fixture) {
  await connection.client.query(
    `insert into outbound_email
       (job_id, kind, recipient, idempotency_key, state, attempts, last_error,
        created_at, updated_at)
     values ($1, 'tenant-scheduling-invitation', 'tenant', $2, 'failed', 5,
             'unknown', now() - interval '3 days', now() - interval '3 days')`,
    [fixture.jobId, `tenant-scheduling-invitation:${fixture.jobId}:seeded`],
  );
}

async function main() {
  console.log("Starting the disposable PostgreSQL…");
  await start();
  const connection = await connect();
  await reset(connection);

  console.log("Seeding fictional data…");
  const fixture = await seed(connection);
  await giveEveryoneAPassword(connection);
  await seedLandlords(connection, fixture);
  await seedRenewals(connection, fixture);
  await seedFailedMessage(connection, fixture);

  console.log("Starting the application…");
  await startServer();

  console.log(
    [
      "",
      "  Ready. Everything below is fictional.",
      "",
      `  ${BASE_URL}/admin/login    admin@fixture.example.invalid`,
      `  ${BASE_URL}/portal/login   agent@fixture.example.invalid`,
      `  ${BASE_URL}/portal/login   rival@fixture.example.invalid  (other agency)`,
      "",
      `  password: ${PASSWORD}`,
      "",
      `  agency:   ${fixture.organisationId}`,
      `  job:      ${fixture.jobReference} (${fixture.jobId})`,
      "",
    ].join("\n"),
  );

  const shutdown = async () => {
    console.log("\nStopping…");
    await stopServer();
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Stay up.
  await new Promise(() => {});
}

await main();
