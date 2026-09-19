/**
 * Completed work, ready to invoice.
 *
 * **Development only, and it says so.** It refuses to run unless
 * `BSCJ_ALLOW_FIXTURE_SEED=1`, every row it writes is marked `INVFIX` or
 * carries an `@example.invalid` address, and `--clean` removes exactly what it
 * created and nothing else. It is not a demo-data generator and it is not part
 * of the application: no import of it exists in `src`.
 *
 * What it builds, and why each one is here:
 *
 *  1. **Agency CP12 with two extra appliances, completed** — the ordinary
 *     case, and the one that proves the appliance extra prefills as its own
 *     line from the stored snapshot rather than being folded into a total.
 *  2. **Private bundle, completed** — a consumer job with no agency, which is
 *     the case where "the agency pays" would be wrong.
 *  3. **Agency CP12, scheduled and not completed** — the control. An invoice
 *     must not be offered for work that has not happened.
 *  4. **A second agency**, with a job of its own — so cross-agency access can
 *     be tested with a real second organisation rather than a hypothesis.
 *
 * The landlord is created **with no billing address**, deliberately: the first
 * thing the invoice screen has to do is refuse to issue and say the property
 * address is not a substitute.
 *
 * Business settings are **not** written. An empty configuration is the honest
 * starting state and the issue gate has to be seen refusing before anybody
 * fills it in.
 *
 * Usage:
 *   BSCJ_ALLOW_FIXTURE_SEED=1 node --experimental-strip-types \
 *     --import ./scripts/test-resolver.mjs scripts/seed-invoicing-fixture.mjs
 *   BSCJ_ALLOW_FIXTURE_SEED=1 node --experimental-strip-types \
 *     --import ./scripts/test-resolver.mjs scripts/seed-invoicing-fixture.mjs --clean
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

const MARK = "INVFIX";
const DOMAIN = "@example.invalid";
const PASSWORD = "fixture-invoicing-2026";

const REFERENCES = ["BSCJ-IN0001", "BSCJ-IN0002", "BSCJ-IN0003", "BSCJ-IN0004"];

async function clean() {
  // Children first: the foreign keys deliberately restrict.
  await sql`DELETE FROM "invoice_line" WHERE invoice_id IN (
    SELECT id FROM "invoice" WHERE primary_job_id IN (
      SELECT id FROM "job" WHERE reference = ANY(${REFERENCES})))`;
  await sql`DELETE FROM "invoice" WHERE primary_job_id IN (
    SELECT id FROM "job" WHERE reference = ANY(${REFERENCES}))`;
  await sql`DELETE FROM "document" WHERE job_id IN (
    SELECT id FROM "job" WHERE reference = ANY(${REFERENCES}))`;
  await sql`DELETE FROM "activity" WHERE job_id IN (SELECT id FROM "job" WHERE reference = ANY(${REFERENCES}))`;
  await sql`DELETE FROM "outbound_email" WHERE job_id IN (SELECT id FROM "job" WHERE reference = ANY(${REFERENCES}))`;
  await sql`DELETE FROM "scheduling_token" WHERE job_id IN (SELECT id FROM "job" WHERE reference = ANY(${REFERENCES}))`;
  await sql`DELETE FROM "job" WHERE reference = ANY(${REFERENCES})`;
  await sql`DELETE FROM "property" WHERE house_or_name LIKE ${MARK + "%"}`;
  await sql`DELETE FROM "customer" WHERE name LIKE ${MARK + "%"}`;
  /*
    Users before organisations.

    `app_user.agent_organisation_id` restricts, so an agency cannot be removed
    while one of its users still points at it. Getting this the wrong way round
    leaves the organisations behind and the script reporting success — which is
    exactly what happened the first time it was run.
  */
  await sql`DELETE FROM "app_user" WHERE email LIKE ${"invfix.%" + DOMAIN}`;
  await sql`DELETE FROM "agent_organisation" WHERE name LIKE ${MARK + "%"}`;
}

if (argv.includes("--clean")) {
  await clean();
  console.log("Invoicing fixture rows removed.");
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
const agentAId = randomUUID();
const agentBId = randomUUID();

const orgAId = randomUUID();
const orgBId = randomUUID();

await sql`
  INSERT INTO "agent_organisation" (id, name, email, phone, plan, is_active)
  VALUES
    (${orgAId}, ${MARK + " Lettings A"}, ${"invfix.agency.a" + DOMAIN}, '01902 000001', 'agent_standard', true),
    (${orgBId}, ${MARK + " Lettings B"}, ${"invfix.agency.b" + DOMAIN}, '01902 000002', 'agent_standard', true)
`;

await sql`
  INSERT INTO "app_user" (id, email, name, password_hash, role, agent_organisation_id, is_active)
  VALUES
    (${adminId}, ${"invfix.admin" + DOMAIN}, ${MARK + " Admin"}, ${passwordHash}, 'admin', NULL, true),
    (${engineerId}, ${"invfix.engineer" + DOMAIN}, ${MARK + " Engineer"}, ${passwordHash}, 'engineer', NULL, true),
    (${agentAId}, ${"invfix.agent.a" + DOMAIN}, ${MARK + " Agent A"}, ${passwordHash}, 'agent_owner', ${orgAId}, true),
    (${agentBId}, ${"invfix.agent.b" + DOMAIN}, ${MARK + " Agent B"}, ${passwordHash}, 'agent_owner', ${orgBId}, true)
`;

/*
  The landlord has **no billing address**. That is the point: the invoice
  screen must refuse to issue and say so, rather than quietly using the
  property the work was done at.
*/
const landlordAId = randomUUID();
const landlordBId = randomUUID();
const homeownerId = randomUUID();

await sql`
  INSERT INTO "customer" (id, agent_organisation_id, type, name, company, email, phone)
  VALUES
    (${landlordAId}, ${orgAId}, 'landlord', ${MARK + " Landlord A"}, ${MARK + " Property Holdings"}, ${"invfix.landlord.a" + DOMAIN}, '07700 900101'),
    (${landlordBId}, ${orgBId}, 'landlord', ${MARK + " Landlord B"}, NULL, ${"invfix.landlord.b" + DOMAIN}, '07700 900102'),
    (${homeownerId}, NULL, 'homeowner', ${MARK + " Homeowner"}, NULL, ${"invfix.homeowner" + DOMAIN}, '07700 900103')
`;

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

const propAId = randomUUID();
const propBId = randomUUID();
const propPrivateId = randomUUID();
const propPendingId = randomUUID();

await sql`
  INSERT INTO "property" (id, agent_organisation_id, customer_id, house_or_name, street, town, postcode)
  VALUES
    (${propAId}, ${orgAId}, ${landlordAId}, ${MARK + " 14 Example Road"}, 'Example Road', 'Wolverhampton', 'WV3 3CC'),
    (${propPendingId}, ${orgAId}, ${landlordAId}, ${MARK + " 16 Example Road"}, 'Example Road', 'Wolverhampton', 'WV3 3CD'),
    (${propBId}, ${orgBId}, ${landlordBId}, ${MARK + " 2 Other Street"}, 'Other Street', 'Wolverhampton', 'WV4 4DD'),
    (${propPrivateId}, NULL, ${homeownerId}, ${MARK + " 9 Private Lane"}, 'Private Lane', 'Wolverhampton', 'WV1 1AA')
`;

// ---------------------------------------------------------------------------
// Work
// ---------------------------------------------------------------------------

const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * 86_400_000);

/**
 * A price snapshot in the shape `lib/pricing/snapshot.ts` parses.
 *
 * Written out in full rather than through the builder, because a fixture that
 * needs the application to construct it cannot be read and checked by eye.
 */
const snapshot = ({
  productId,
  listPricePence,
  unitPricePence,
  applianceCount = null,
  extraAppliances = 0,
  extraAppliancePence = 0,
}) =>
  JSON.stringify({
    version: 1,
    productId,
    listPricePence,
    unitPricePence,
    source: "list",
    agreementId: null,
    agreementLineId: null,
    tier: null,
    committedJobs: null,
    overrideReason: null,
    applianceCount,
    extraAppliances,
    extraAppliancePence,
    extraChargePence: extraAppliances * extraAppliancePence,
    totalPence: unitPricePence + extraAppliances * extraAppliancePence,
    resolvedAt: daysAgo(3).toISOString(),
  });

const jobs = [
  {
    // 1. The ordinary case: £45 plus two appliances at £15 = £75.
    reference: "BSCJ-IN0001",
    org: orgAId,
    customer: landlordAId,
    billing: landlordAId,
    property: propAId,
    productId: "cp12",
    applianceCount: 4,
    price: 7500,
    snapshot: snapshot({
      productId: "cp12",
      listPricePence: 4500,
      unitPricePence: 4500,
      applianceCount: 4,
      extraAppliances: 2,
      extraAppliancePence: 1500,
    }),
    status: "completed",
    engineer: engineerId,
    completedAt: daysAgo(2),
  },
  {
    // 2. Consumer work: no agency at all.
    reference: "BSCJ-IN0002",
    org: null,
    customer: homeownerId,
    billing: homeownerId,
    property: propPrivateId,
    productId: "cp12-boiler-service",
    applianceCount: 1,
    price: 9000,
    snapshot: snapshot({
      productId: "cp12-boiler-service",
      listPricePence: 9000,
      unitPricePence: 9000,
      applianceCount: 1,
    }),
    status: "completed",
    engineer: engineerId,
    completedAt: daysAgo(1),
  },
  {
    // 3. The control: not completed, so not invoiceable.
    reference: "BSCJ-IN0003",
    org: orgAId,
    customer: landlordAId,
    billing: landlordAId,
    property: propPendingId,
    productId: "cp12",
    applianceCount: 1,
    price: 4500,
    snapshot: snapshot({
      productId: "cp12",
      listPricePence: 4500,
      unitPricePence: 4500,
      applianceCount: 1,
    }),
    status: "scheduled",
    engineer: null,
    completedAt: null,
  },
  {
    // 4. The second agency's own work, for cross-agency checks.
    reference: "BSCJ-IN0004",
    org: orgBId,
    customer: landlordBId,
    billing: landlordBId,
    property: propBId,
    productId: "cp12",
    applianceCount: 1,
    price: 4500,
    snapshot: snapshot({
      productId: "cp12",
      listPricePence: 4500,
      unitPricePence: 4500,
      applianceCount: 1,
    }),
    status: "completed",
    engineer: engineerId,
    completedAt: daysAgo(4),
  },
];

const ids = {};

for (const job of jobs) {
  const id = randomUUID();
  ids[job.reference] = id;

  const [property] = await sql`
    SELECT house_or_name, street, town, postcode FROM "property" WHERE id = ${job.property}
  `;
  const [customer] = await sql`
    SELECT type, name, company, email, phone FROM "customer" WHERE id = ${job.customer}
  `;

  await sql`
    INSERT INTO "job" (
      id, reference, agent_organisation_id, customer_id, billing_customer_id,
      property_id, assigned_engineer_id, product_id, appliance_count,
      price_total_pence, customer_snapshot, property_snapshot, price_snapshot,
      duration_minutes, scheduling_method, lifecycle_status, calendar_sync_state,
      source, idempotency_key, completed_at, created_by, created_at
    ) VALUES (
      ${id}, ${job.reference}, ${job.org}, ${job.customer}, ${job.billing},
      ${job.property}, ${job.engineer}, ${job.productId}, ${job.applianceCount},
      ${job.price}, ${JSON.stringify(customer)}, ${JSON.stringify(property)}, ${job.snapshot},
      45, 'admin_selected', ${job.status}, 'not_required',
      ${job.org ? "portal" : "website_self"}, ${"invfix-" + job.reference}, ${job.completedAt},
      ${adminId}, ${daysAgo(5)}
    )
  `;
}

console.log("Invoicing fixtures written.");
console.log("");
console.log("  Admin     invfix.admin@example.invalid");
console.log("  Engineer  invfix.engineer@example.invalid");
console.log("  Agent A   invfix.agent.a@example.invalid   (owns BSCJ-IN0001)");
console.log("  Agent B   invfix.agent.b@example.invalid   (owns BSCJ-IN0004)");
console.log(`  Password  ${PASSWORD}`);
console.log("");
for (const [reference, id] of Object.entries(ids)) {
  console.log(`  ${reference}  /admin/jobs/${id}`);
}
console.log("");
console.log("Business settings were deliberately NOT written: the issue gate");
console.log("has to be seen refusing before anybody fills them in.");
