/**
 * One agency, one property, one tenant, one job — for driving the tenant
 * scheduling flow through a real browser.
 *
 * **Development only, and it says so.** It refuses to run unless
 * `BSCJ_ALLOW_FIXTURE_SEED=1`, every row it writes is prefixed `FIXTURE`, and
 * `--clean` removes exactly what it created and nothing else. It is not a
 * demo-data generator and it is not part of the application: no import of it
 * exists in `src`.
 *
 * It prints the invitation token once. That is the only time the plain value
 * exists anywhere — the database holds a hash, exactly as production does.
 *
 * Usage:
 *   BSCJ_ALLOW_FIXTURE_SEED=1 node scripts/seed-scheduling-fixture.mjs
 *   BSCJ_ALLOW_FIXTURE_SEED=1 node scripts/seed-scheduling-fixture.mjs --clean
 *
 * Options:
 *   --requested-by=YYYY-MM-DD   the date the agent asked for
 *   --certificate-due=YYYY-MM-DD  an active compliance cycle's due date
 *
 * The two are deliberately separate switches, because the whole point of the
 * rule they exercise is that they are different things.
 */

import { randomUUID, createHash, createHmac, randomBytes } from "node:crypto";
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
const REFERENCE = "BSCJ-FX0001";
const POSTCODE = "WV1 1AA";

function option(name) {
  const found = argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

async function clean() {
  // Children first: the foreign keys deliberately restrict.
  await sql`DELETE FROM "compliance_cycle" WHERE property_id IN (SELECT id FROM "property" WHERE house_or_name LIKE ${MARK + "%"})`;
  await sql`DELETE FROM "activity" WHERE job_id IN (SELECT id FROM "job" WHERE reference = ${REFERENCE})`;
  await sql`DELETE FROM "outbound_email" WHERE job_id IN (SELECT id FROM "job" WHERE reference = ${REFERENCE})`;
  await sql`DELETE FROM "scheduling_token" WHERE job_id IN (SELECT id FROM "job" WHERE reference = ${REFERENCE})`;
  await sql`DELETE FROM "job" WHERE reference = ${REFERENCE}`;
  await sql`DELETE FROM "tenancy" WHERE name LIKE ${MARK + "%"}`;
  await sql`DELETE FROM "property" WHERE house_or_name LIKE ${MARK + "%"}`;
  await sql`DELETE FROM "customer" WHERE name LIKE ${MARK + "%"}`;
  await sql`DELETE FROM "agent_organisation" WHERE name LIKE ${MARK + "%"}`;
}

if (argv.includes("--clean")) {
  await clean();
  console.log("Fixture rows removed.");
  exit(0);
}

await clean();

const organisationId = randomUUID();
const customerId = randomUUID();
const propertyId = randomUUID();
const tenancyId = randomUUID();
const jobId = randomUUID();

await sql`
  INSERT INTO "agent_organisation" (id, name, email, plan, is_active)
  VALUES (${organisationId}, ${MARK + " Lettings"}, 'fixture@example.invalid', 'free_legacy', true)`;

await sql`
  INSERT INTO "customer" (id, agent_organisation_id, type, name, email, phone)
  VALUES (${customerId}, ${organisationId}, 'landlord', ${MARK + " Landlord"},
          'landlord@example.invalid', '+447700900000')`;

await sql`
  INSERT INTO "property" (id, agent_organisation_id, customer_id, house_or_name, street, town, postcode)
  VALUES (${propertyId}, ${organisationId}, ${customerId}, ${MARK + " 12"},
          'Example Street', 'Wolverhampton', ${POSTCODE})`;

await sql`
  INSERT INTO "tenancy" (id, property_id, name, phone)
  VALUES (${tenancyId}, ${propertyId}, ${MARK + " Tenant"}, '+447700900111')`;

const priceSnapshot = {
  productId: "cp12",
  source: "list",
  agreementId: null,
  unitPence: 4500,
  applianceCount: null,
  extraAppliances: 0,
  extraChargePence: 0,
  totalPence: 4500,
};

await sql`
  INSERT INTO "job" (
    id, reference, agent_organisation_id, customer_id, billing_customer_id,
    property_id, tenancy_id, product_id, price_total_pence,
    customer_snapshot, property_snapshot, price_snapshot,
    scheduling_method, lifecycle_status, calendar_sync_state, source, idempotency_key
  ) VALUES (
    ${jobId}, ${REFERENCE}, ${organisationId}, ${customerId}, ${customerId},
    ${propertyId}, ${tenancyId}, 'cp12', 4500,
    ${JSON.stringify({ type: "landlord", name: MARK + " Landlord", email: "landlord@example.invalid", phone: "+447700900000" })},
    ${JSON.stringify({ houseOrName: MARK + " 12", street: "Example Street", town: "Wolverhampton", postcode: POSTCODE })},
    ${JSON.stringify(priceSnapshot)},
    'tenant_selected', 'tenant_outreach', 'not_required', 'portal', ${"fixture-" + jobId}
  )`;

const requestedBy = option("requested-by");
const certificateDue = option("certificate-due");

if (requestedBy) {
  await sql.query(`UPDATE "job" SET complete_by_date = $2 WHERE id = $1`, [
    jobId,
    requestedBy,
  ]);
}

if (certificateDue) {
  await sql`
    INSERT INTO "compliance_cycle"
      (id, property_id, agent_organisation_id, product_id, due_date, due_date_source, status)
    VALUES (${randomUUID()}, ${propertyId}, ${organisationId}, 'cp12',
            ${certificateDue}, 'manual', 'active')`;
}

// Minted exactly as `lib/scheduling/token.ts` does, so the application's own
// verification is what the browser test exercises.
const token = randomBytes(32).toString("hex");
const secret = process.env.SCHEDULING_TOKEN_SECRET;
const tokenHash = secret
  ? `hmac$${createHmac("sha256", secret).update(token).digest("hex")}`
  : `sha256$${createHash("sha256").update(token).digest("hex")}`;

const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

await sql`
  INSERT INTO "scheduling_token" (id, job_id, token_hash, expires_at)
  VALUES (${randomUUID()}, ${jobId}, ${tokenHash}, ${expiresAt.toISOString()})`;

console.log(
  JSON.stringify(
    {
      jobId,
      organisationId,
      reference: REFERENCE,
      postcode: POSTCODE,
      token,
      requestedBy,
      certificateDue,
    },
    null,
    2,
  ),
);
