/**
 * A day's worth of work, for driving the admin and engineer screens.
 *
 * **Development only, and it says so.** It refuses to run unless
 * `BSCJ_ALLOW_FIXTURE_SEED=1`, every row it writes is marked `FIXTURE` or
 * carries an `@example.invalid` address, and `--clean` removes exactly what
 * it created and nothing else. It is not a demo-data generator and it is not
 * part of the application: no import of it exists in `src`.
 *
 * It deliberately does **not** touch any account that already exists. The two
 * users it creates are its own, on a domain that cannot receive mail, with a
 * password printed once so a person can sign in and look.
 *
 * What it builds, and why each one is here:
 *
 *  1. Private CP12 today, nobody allocated  — the unassigned queue
 *  2. Agency CP12 today, allocated          — the engineer's day
 *  3. Agency bundle today, on site          — the "complete" control
 *  4. Private service, done yesterday       — closed work and a completion note
 *  5. Private CP12, calendar not written    — needs attention
 *  6. Agency CP12, overdue and booked late  — needs attention, two reasons
 *  7. Agency CP12 awaiting the tenant       — a job with no appointment
 *
 * Usage:
 *   BSCJ_ALLOW_FIXTURE_SEED=1 node --experimental-strip-types \
 *     --import ./scripts/test-resolver.mjs scripts/seed-operations-fixture.mjs
 *   BSCJ_ALLOW_FIXTURE_SEED=1 node --experimental-strip-types \
 *     --import ./scripts/test-resolver.mjs scripts/seed-operations-fixture.mjs --clean
 */

import { randomUUID } from "node:crypto";
import { exit, argv } from "node:process";

try {
  process.loadEnvFile(process.env.BSCJ_ENV_FILE ?? ".env.local");
} catch {
  // Already populated.
}

if (process.env.BSCJ_ALLOW_FIXTURE_SEED !== "1") {
  console.error(
    "Refusing to write fixture rows. Set BSCJ_ALLOW_FIXTURE_SEED=1 if this is a development database.",
  );
  exit(1);
}

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  exit(1);
}

const { neon } = await import("@neondatabase/serverless");
const sql = neon(url);

const MARK = "FIXTURE";
const DOMAIN = "@example.invalid";
const PASSWORD = "fixture-operations-2026";

/** Every reference this script owns. `--clean` removes these and no others. */
const REFERENCES = [
  "BSCJ-OP0001",
  "BSCJ-OP0002",
  "BSCJ-OP0003",
  "BSCJ-OP0004",
  "BSCJ-OP0005",
  "BSCJ-OP0006",
  "BSCJ-OP0007",
];

async function clean() {
  // Children first: the foreign keys deliberately restrict.
  await sql`DELETE FROM "activity" WHERE job_id IN (SELECT id FROM "job" WHERE reference = ANY(${REFERENCES}))`;
  await sql`DELETE FROM "outbound_email" WHERE job_id IN (SELECT id FROM "job" WHERE reference = ANY(${REFERENCES}))`;
  await sql`DELETE FROM "scheduling_token" WHERE job_id IN (SELECT id FROM "job" WHERE reference = ANY(${REFERENCES}))`;
  await sql`DELETE FROM "remedial" WHERE job_id IN (SELECT id FROM "job" WHERE reference = ANY(${REFERENCES}))`;
  await sql`DELETE FROM "job" WHERE reference = ANY(${REFERENCES})`;
  await sql`DELETE FROM "tenancy" WHERE name LIKE ${MARK + "%"}`;
  await sql`DELETE FROM "property" WHERE house_or_name LIKE ${MARK + "%"}`;
  await sql`DELETE FROM "customer" WHERE name LIKE ${MARK + "%"}`;
  await sql`DELETE FROM "agent_organisation" WHERE name LIKE ${MARK + "%"}`;
  // Only ever the two accounts this script owns, on a domain that cannot
  // receive mail. A real account is never touched.
  await sql`DELETE FROM "app_user" WHERE email LIKE ${"fixture.%" + DOMAIN}`;
}

if (argv.includes("--clean")) {
  await clean();
  console.log("Fixture rows removed.");
  exit(0);
}

await clean();

const { hashPassword } = await import("../src/lib/auth/password.ts");
const passwordHash = await hashPassword(PASSWORD);

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const adminId = randomUUID();
const engineerId = randomUUID();

await sql`
  INSERT INTO "app_user" (id, email, name, password_hash, role, is_active)
  VALUES
    (${adminId}, ${"fixture.admin" + DOMAIN}, ${MARK + " Admin"}, ${passwordHash}, 'admin', true),
    (${engineerId}, ${"fixture.engineer" + DOMAIN}, ${MARK + " Engineer"}, ${passwordHash}, 'engineer', true)
`;

const orgId = randomUUID();
await sql`
  INSERT INTO "agent_organisation" (id, name, email, phone, plan, is_active)
  VALUES (${orgId}, ${MARK + " Lettings"}, ${"fixture.agency" + DOMAIN}, '01902 000000', 'agent_standard', true)
`;

const homeownerId = randomUUID();
const landlordId = randomUUID();
await sql`
  INSERT INTO "customer" (id, agent_organisation_id, type, name, email, phone)
  VALUES
    (${homeownerId}, NULL, 'homeowner', ${MARK + " Homeowner"}, ${"fixture.homeowner" + DOMAIN}, '07700 900001'),
    (${landlordId}, ${orgId}, 'landlord', ${MARK + " Landlord"}, ${"fixture.landlord" + DOMAIN}, '07700 900002')
`;

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

const properties = [
  { id: randomUUID(), house: `${MARK} 1 Ash Grove`, postcode: "WV1 1AA", access: null, org: null },
  { id: randomUUID(), house: `${MARK} 2 Beech Road`, postcode: "WV2 2BB", access: "Key safe by the side gate, code on the job sheet.", org: orgId },
  { id: randomUUID(), house: `${MARK} 3 Cedar Close`, postcode: "WV3 3CC", access: "Tenant works nights — ring before knocking.", org: orgId },
  { id: randomUUID(), house: `${MARK} 4 Damson Way`, postcode: "WV4 4DD", access: null, org: null },
];

for (const property of properties) {
  await sql`
    INSERT INTO "property" (id, agent_organisation_id, customer_id, house_or_name, street, town, postcode, access_notes)
    VALUES (
      ${property.id}, ${property.org}, ${property.org ? landlordId : homeownerId},
      ${property.house}, 'Wolverhampton', 'Wolverhampton', ${property.postcode}, ${property.access}
    )
  `;
}

const tenancyId = randomUUID();
await sql`
  INSERT INTO "tenancy" (id, property_id, name, email, phone)
  VALUES (${tenancyId}, ${properties[1].id}, ${MARK + " Tenant"}, ${"fixture.tenant" + DOMAIN}, '07700 900003')
`;

// ---------------------------------------------------------------------------
// Work
// ---------------------------------------------------------------------------

const now = new Date();
const londonDate = (offsetDays = 0) => {
  const d = new Date(now.getTime() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d);
};

/** A UTC instant for a London wall-clock hour on a given day offset. */
const at = (offsetDays, hour) => {
  const date = londonDate(offsetDays);
  // Good enough for a fixture: the dev database and the app agree on the zone,
  // and nothing here asserts to the minute.
  const guess = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const offset =
    new Date(
      new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/London",
        dateStyle: "short",
        timeStyle: "medium",
      })
        .format(guess)
        .replace(" ", "T") + "Z",
    ).getTime() - guess.getTime();
  return new Date(guess.getTime() - offset);
};

const snapshot = (pence) =>
  JSON.stringify({
    source: "list",
    unitPricePence: pence,
    listPricePence: pence,
    extraChargePence: 0,
    extraAppliances: 0,
  });

const jobs = [
  {
    reference: "BSCJ-OP0001",
    org: null,
    customer: homeownerId,
    property: properties[0].id,
    tenancy: null,
    product: "cp12",
    price: 4500,
    duration: 45,
    start: at(0, 10),
    status: "scheduled",
    engineer: null,
    sync: "synced",
    source: "website_self",
    method: "self_booked",
  },
  {
    reference: "BSCJ-OP0002",
    org: orgId,
    customer: landlordId,
    property: properties[1].id,
    tenancy: tenancyId,
    product: "cp12",
    price: 4500,
    duration: 45,
    start: at(0, 12),
    status: "engineer_assigned",
    engineer: engineerId,
    sync: "synced",
    source: "portal",
    method: "tenant_selected",
  },
  {
    reference: "BSCJ-OP0003",
    org: orgId,
    customer: landlordId,
    property: properties[2].id,
    tenancy: null,
    product: "cp12-boiler-service",
    price: 9000,
    duration: 60,
    start: at(0, 14),
    status: "in_progress",
    engineer: engineerId,
    sync: "synced",
    source: "portal",
    method: "landlord_selected",
    startedAt: at(0, 14),
  },
  {
    reference: "BSCJ-OP0004",
    org: null,
    customer: homeownerId,
    property: properties[3].id,
    tenancy: null,
    product: "boiler-service",
    price: 6000,
    duration: 60,
    start: at(-1, 11),
    status: "completed",
    engineer: engineerId,
    sync: "synced",
    source: "website_self",
    method: "self_booked",
    startedAt: at(-1, 11),
    completedAt: at(-1, 12),
    notes: "Boiler serviced. Flue readings normal. Nothing outstanding.",
  },
  {
    reference: "BSCJ-OP0005",
    org: null,
    customer: homeownerId,
    property: properties[0].id,
    tenancy: null,
    product: "cp12",
    price: 4500,
    duration: 45,
    start: at(2, 16),
    status: "scheduled",
    engineer: null,
    // The whole point of this row: the diary does not hold it yet.
    sync: "pending",
    source: "website_self",
    method: "self_booked",
  },
  {
    reference: "BSCJ-OP0006",
    org: orgId,
    customer: landlordId,
    property: properties[2].id,
    tenancy: null,
    product: "cp12",
    price: 4500,
    duration: 45,
    start: at(3, 10),
    status: "scheduled",
    engineer: null,
    sync: "synced",
    source: "portal",
    method: "tenant_selected",
    completeBy: londonDate(-2),
    exception: true,
  },
  {
    reference: "BSCJ-OP0007",
    org: orgId,
    customer: landlordId,
    property: properties[1].id,
    tenancy: tenancyId,
    product: "cp12",
    price: 4500,
    duration: 45,
    start: null,
    status: "awaiting_tenant",
    engineer: null,
    sync: "not_required",
    source: "portal",
    method: "tenant_selected",
    completeBy: londonDate(20),
  },
];

const ids = {};

for (const job of jobs) {
  const id = randomUUID();
  ids[job.reference] = id;
  const end = job.start ? new Date(job.start.getTime() + job.duration * 60_000) : null;

  await sql`
    INSERT INTO "job" (
      id, reference, agent_organisation_id, customer_id, billing_customer_id,
      property_id, tenancy_id, assigned_engineer_id, product_id,
      price_total_pence, customer_snapshot, property_snapshot, price_snapshot,
      complete_by_date, appointment_start, appointment_end, duration_minutes,
      scheduling_method, lifecycle_status, calendar_sync_state,
      deadline_exception_at, work_started_at, completed_at, completion_notes,
      source, idempotency_key
    ) VALUES (
      ${id}, ${job.reference}, ${job.org}, ${job.customer}, ${job.customer},
      ${job.property}, ${job.tenancy}, ${job.engineer}, ${job.product},
      ${job.price}, ${JSON.stringify({ name: MARK })}, ${JSON.stringify({ postcode: "WV1 1AA" })},
      ${snapshot(job.price)},
      ${job.completeBy ?? null}, ${job.start}, ${end}, ${job.duration},
      ${job.method}, ${job.status}, ${job.sync},
      ${job.exception ? job.start : null}, ${job.startedAt ?? null},
      ${job.completedAt ?? null}, ${job.notes ?? null},
      ${job.source}, ${"fixture-" + job.reference}
    )
  `;

  await sql`
    INSERT INTO "activity" (job_id, property_id, agent_organisation_id, kind, actor, detail)
    VALUES (${id}, ${job.property}, ${job.org}, 'job.created', 'system', ${JSON.stringify({ source: job.source })})
  `;
}

// A message that was given up on: the other half of the needs-attention queue.
await sql`
  INSERT INTO "outbound_email" (job_id, kind, recipient, idempotency_key, state, attempts, last_error)
  VALUES (
    ${ids["BSCJ-OP0006"]}, 'tenant-scheduling-invitation', 'tenant',
    ${"fixture-failed-" + randomUUID()}, 'failed', 5, 'tenant_email_missing'
  )
`;

console.log(`
Fixture rows written.

  Admin     fixture.admin${DOMAIN}
  Engineer  fixture.engineer${DOMAIN}
  Password  ${PASSWORD}

Remove them with --clean.
`);
