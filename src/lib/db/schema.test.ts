import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";

import * as schema from "./schema";
import { JOB_LIFECYCLE_STATUSES } from "@/lib/jobs/lifecycle";
import { APP_ROLES } from "@/lib/auth/roles";
import { customerTypes } from "@/lib/booking/schema";
import { PRODUCT_IDS } from "@/lib/booking/products";

/**
 * The data-model decisions worth protecting.
 *
 * Not a test that Drizzle works. These assert the specific choices that were
 * made deliberately and would be quietly easy to undo: that one agency's rows
 * can be filtered from another's, that billing is separable from
 * commissioning, that the date concepts stay distinct, and that history does
 * not re-describe itself when a property changes hands.
 */

type Table = Parameters<typeof getTableConfig>[0];

const columns = (table: Table) =>
  new Map(getTableConfig(table).columns.map((column) => [column.name, column]));

const indexNames = (table: Table) =>
  getTableConfig(table).indexes.map((index) => index.config.name);

const uniqueIndexes = (table: Table) =>
  getTableConfig(table)
    .indexes.filter((index) => index.config.unique)
    .map((index) => index.config.name);

describe("organisations can be told apart", () => {
  /**
   * Every table an agency can reach, and the fact that each carries the
   * organisation directly.
   *
   * Relying on a join would mean a missing filter returns another agency's
   * rows rather than failing. Carrying the column means the filter is visible
   * at the call site, and `lib/auth/scope.ts` can apply it uniformly.
   */
  const SCOPED: [string, Table][] = [
    ["customer", schema.customers],
    ["property", schema.properties],
    ["job", schema.jobs],
    ["document", schema.documents],
    ["certificate", schema.certificates],
    ["invoice", schema.invoices],
    ["remedial", schema.remedials],
    ["message", schema.messages],
    ["compliance_cycle", schema.complianceCycles],
    ["activity", schema.activities],
  ];

  test("every agency-reachable table carries the organisation itself", () => {
    for (const [name, table] of SCOPED) {
      assert.ok(
        columns(table).has("agent_organisation_id"),
        `${name} has no organisation column, so it can only be scoped by a join`,
      );
    }
  });

  test("each of them is indexed on it, so scoping is not a table scan", () => {
    for (const [name, table] of SCOPED) {
      assert.ok(
        indexNames(table).some((index) => index?.includes("organisation")),
        `${name} is not indexed by organisation`,
      );
    }
  });

  test("the organisation is optional everywhere, because consumer work has none", () => {
    // A booking taken on the public site belongs to no agency. Making the
    // column required would force an invented organisation onto every one.
    for (const [name, table] of SCOPED) {
      assert.equal(
        columns(table).get("agent_organisation_id")?.notNull,
        false,
        `${name} requires an organisation`,
      );
    }
  });

  test("a user belongs to at most one organisation", () => {
    const user = columns(schema.appUsers);
    assert.ok(user.has("agent_organisation_id"));
    // Null is BSCJ staff. The application refuses an agency role without one.
    assert.equal(user.get("agent_organisation_id")?.notNull, false);
  });

  test("there is one user table, not a staff one and an agency one", () => {
    // A second login path is a second place to get password comparison,
    // timing, deactivation and normalisation subtly wrong.
    assert.equal("adminUsers" in schema, false);
    assert.deepEqual([...schema.appRoleEnum.enumValues], [...APP_ROLES]);
  });

  test("an email identifies exactly one user", () => {
    assert.ok(uniqueIndexes(schema.appUsers).includes("app_user_email_key"));
  });
});

describe("who commissions and who pays are separable", () => {
  const job = columns(schema.jobs);

  test("a job carries both, and both are required", () => {
    /*
      An agent may commission work the landlord pays for, and a portfolio may
      bill centrally. Adding the column later would mean migrating live
      invoices.
    */
    assert.ok(job.has("customer_id"));
    assert.ok(job.has("billing_customer_id"));
    assert.equal(job.get("customer_id")?.notNull, true);
    assert.equal(job.get("billing_customer_id")?.notNull, true);
  });

  test("an invoice records who it was billed to at the time", () => {
    const invoice = columns(schema.invoices);
    assert.ok(invoice.has("billing_customer_id"));
    assert.equal(invoice.get("billing_customer_id")?.notNull, true);
  });
});

describe("the date concepts stay distinguishable", () => {
  const job = columns(schema.jobs);

  test("each is its own column", () => {
    // Collapsing any pair of these loses a question the business can ask:
    // what does the property hold now, when were we asked to finish by, when
    // did we attend, and when is it next due.
    for (const column of [
      "current_certificate_expiry",
      "complete_by_date",
      "completed_at",
      "next_renewal_date",
    ]) {
      assert.ok(job.has(column), `${column} is missing`);
    }
  });

  test("none of them is required, because none of them is always known", () => {
    for (const column of [
      "current_certificate_expiry",
      "complete_by_date",
      "completed_at",
      "next_renewal_date",
    ]) {
      assert.equal(job.get(column)?.notNull, false, column);
    }
  });

  test("asking for it as soon as possible is not a deadline", () => {
    /*
      A request, recorded as one. Storing "ASAP" as a completion date would
      turn it into a promise the business never made, and every dashboard
      would then report it as missed.
    */
    assert.ok(job.has("requested_asap"));
    assert.equal(job.get("requested_asap")?.notNull, true);
    assert.equal(job.get("requested_asap")?.getSQLType(), "boolean");
  });

  test("a renewal date records whether a person set it", () => {
    assert.ok(job.has("next_renewal_source"));
    assert.deepEqual(schema.renewalSourceEnum.enumValues, ["manual", "derived"]);
  });

  test("calendar dates are dates, not timestamps", () => {
    // A renewal due date has no time of day. Storing it as a timestamp is how
    // it drifts a day across a timezone boundary.
    for (const column of [
      "current_certificate_expiry",
      "complete_by_date",
      "next_renewal_date",
    ]) {
      assert.equal(job.get(column)?.getSQLType(), "date", column);
    }
    assert.match(job.get("completed_at")?.getSQLType() ?? "", /timestamp/);
  });

  test("a certificate's dates are dates too", () => {
    const certificate = columns(schema.certificates);
    assert.equal(certificate.get("inspection_date")?.getSQLType(), "date");
    assert.equal(certificate.get("next_due_date")?.getSQLType(), "date");
  });
});

describe("history does not re-describe itself", () => {
  const job = columns(schema.jobs);

  test("each job snapshots what was true when it was taken", () => {
    /*
      The only denormalisation in the schema. Live relations answer "what is
      true now"; these answer "what was true then", which is what a historical
      record and a reissued certificate or invoice need.
    */
    for (const column of [
      "customer_snapshot",
      "property_snapshot",
      "price_snapshot",
    ]) {
      assert.ok(job.has(column), `${column} is missing`);
      assert.equal(job.get(column)?.notNull, true, `${column} is optional`);
      assert.equal(job.get(column)?.getSQLType(), "jsonb", column);
    }
  });

  test("an invoice freezes the business identity that issued it", () => {
    /*
      The legal entity behind BSCJ is changing. An invoice must not silently
      start claiming to have been issued by a company that did not exist on
      its date.
    */
    const invoice = columns(schema.invoices);
    assert.ok(invoice.has("identity_snapshot"));
    assert.equal(invoice.get("identity_snapshot")?.getSQLType(), "jsonb");
  });

  test("a certificate's due date is stored, not recomputed on read", () => {
    // A later change to the renewal rule must not move a date a landlord has
    // already been told and is holding on a PDF.
    assert.equal(
      columns(schema.certificates).get("next_due_date")?.notNull,
      true,
    );
  });

  test("nothing a job depends on can be deleted out from under it", () => {
    const references = getTableConfig(schema.jobs).foreignKeys;

    assert.ok(references.length > 0);
    for (const reference of references) {
      assert.notEqual(
        reference.onDelete,
        "cascade",
        "a job can be deleted out from under its own history",
      );
    }
  });

  test("a tenancy is an occupancy, so a new tenant does not erase the last one", () => {
    const tenancy = columns(schema.tenancies);
    assert.ok(tenancy.has("started_on"));
    assert.ok(tenancy.has("ended_on"));
    assert.equal("tenants" in schema, false);
  });
});

describe("money and state", () => {
  test("money is integer pence, never a float", () => {
    for (const [name, table, column] of [
      ["job", schema.jobs, "price_total_pence"],
      ["invoice", schema.invoices, "subtotal_pence"],
      ["invoice", schema.invoices, "vat_pence"],
      ["invoice", schema.invoices, "total_pence"],
      ["invoice_line", schema.invoiceLines, "unit_price_pence"],
      ["invoice_line", schema.invoiceLines, "total_pence"],
      ["pricing_agreement_line", schema.pricingAgreementLines, "unit_price_pence"],
      ["agent_organisation", schema.agentOrganisations, "remedial_authority_pence"],
      ["remedial", schema.remedials, "authority_pence"],
    ] as [string, Table, string][]) {
      assert.equal(
        columns(table).get(column)?.getSQLType(),
        "integer",
        `${name}.${column}`,
      );
    }
  });

  test("lifecycle, invoice and document state are three separate things", () => {
    // One enum covering all three produces combinations that cannot be
    // expressed — a job that is both certificate-issued and invoiced.
    assert.deepEqual(
      [...schema.jobLifecycleStatusEnum.enumValues],
      [...JOB_LIFECYCLE_STATUSES],
    );
    assert.deepEqual(
      [...schema.invoiceStatusEnum.enumValues],
      ["draft", "sent", "paid", "void"],
    );
    for (const financial of ["invoiced", "paid", "certificate_issued"]) {
      assert.equal(
        schema.jobLifecycleStatusEnum.enumValues.includes(financial as never),
        false,
        `${financial} leaked into the lifecycle`,
      );
    }
  });

  test("the deadline exception is a flag, not a status", () => {
    // A job can be past its deadline and scheduled and invoiced at once.
    assert.ok(columns(schema.jobs).has("deadline_exception_at"));
  });

  test("an external side effect records whether it actually happened", () => {
    // Postgres cannot make a Google API call atomic, so the intent is written
    // and the outcome recorded, rather than assumed.
    assert.deepEqual(
      [...schema.calendarSyncStateEnum.enumValues],
      ["not_required", "pending", "synced", "failed"],
    );
    assert.ok(columns(schema.outboundEmails).has("state"));
    assert.ok(columns(schema.outboundEmails).has("attempts"));
  });
});

describe("VAT is modelled and switched off", () => {
  const invoice = columns(schema.invoices);

  test("an invoice can carry VAT without any being charged", () => {
    /*
      BSCJ is not VAT registered. The columns exist from the start so
      registering later is a settings change and a rate, rather than a
      redesign of the invoice system and a migration of issued documents.
    */
    assert.ok(invoice.has("vat_pence"));
    assert.ok(invoice.has("vat_registered"));
    assert.ok(invoice.has("vat_number"));
  });

  test("the default is not registered and zero", () => {
    assert.equal(invoice.get("vat_registered")?.default, false);
    assert.equal(invoice.get("vat_pence")?.default, 0);
  });
});

describe("an invoice is a header and its lines", () => {
  test("lines are their own table", () => {
    // The only shape a consolidated monthly agent invoice fits in. Retrofitting
    // it once per-job invoices exist means rewriting issued documents.
    assert.ok(columns(schema.invoiceLines).has("invoice_id"));
    assert.equal(columns(schema.invoiceLines).get("invoice_id")?.notNull, true);
  });

  test("an invoice is not tied to a single job", () => {
    assert.equal(columns(schema.invoices).has("job_id"), false);
  });

  test("a line need not have a job, so an adjustment can exist", () => {
    assert.equal(columns(schema.invoiceLines).get("job_id")?.notNull, false);
  });

  test("a consolidated invoice can say which period it covers", () => {
    assert.ok(columns(schema.invoices).has("period_start"));
    assert.ok(columns(schema.invoices).has("period_end"));
  });
});

describe("pricing is configuration, not code", () => {
  test("services stay in code, not in a table", () => {
    // A services table could disagree with the registry the server prices
    // from, and then there would be two sources of truth for £45.
    assert.ok(PRODUCT_IDS.length > 0);
    assert.equal("products" in schema, false);
    assert.equal("services" in schema, false);
    assert.equal(columns(schema.jobs).get("product_id")?.getSQLType(), "text");
  });

  test("a price is per service and per tier, and the tier is stored as bounds", () => {
    /*
      Bounds rather than a named band, so the band structure can change without
      a migration and without re-labelling agreements signed under the old one.
    */
    const line = columns(schema.pricingAgreementLines);
    assert.ok(line.has("product_id"));
    assert.ok(line.has("tier_min_jobs"));
    assert.ok(line.has("tier_max_jobs"));
    assert.equal(line.get("tier_min_jobs")?.notNull, true);
    // Null means "and above".
    assert.equal(line.get("tier_max_jobs")?.notNull, false);
  });

  test("one service cannot have two prices at the same tier", () => {
    assert.ok(
      uniqueIndexes(schema.pricingAgreementLines).includes(
        "pricing_agreement_line_key",
      ),
    );
  });

  test("volume is committed once per organisation per month", () => {
    assert.ok(
      uniqueIndexes(schema.volumeCommitments).includes(
        "volume_commitment_period_key",
      ),
    );
  });
});

describe("a safety record cannot be quietly rewritten", () => {
  const certificate = columns(schema.certificates);

  test("a correction is a new version, not an edit", () => {
    assert.ok(certificate.has("version"));
    assert.ok(certificate.has("supersedes_id"));
    assert.ok(certificate.has("correction_reason"));
    assert.deepEqual(
      [...schema.certificateStatusEnum.enumValues],
      ["issued", "superseded"],
    );
  });

  test("a number and a version together are unique", () => {
    // Two rows claiming to be version 2 of the same certificate is the
    // ambiguity this index exists to refuse.
    assert.ok(
      uniqueIndexes(schema.certificates).includes(
        "certificate_number_version_key",
      ),
    );
  });

  test("there is no draft state, because a row here has been issued", () => {
    assert.equal(
      schema.certificateStatusEnum.enumValues.includes("draft" as never),
      false,
    );
  });
});

describe("the timeline and the security log are separate", () => {
  test("both exist", () => {
    /*
      `activity` is business-readable and shown to an agent. `audit_event` is
      sign-ins, impersonation and document access, and is admin-only. Merging
      them leaks security events into a customer view, or hides the timeline.
    */
    assert.ok("activities" in schema);
    assert.ok("auditEvents" in schema);
  });

  test("only the audit log records impersonation", () => {
    const audit = columns(schema.auditEvents);
    assert.ok(audit.has("impersonated_user_id"));
    assert.ok(audit.has("impersonated_organisation_id"));
    assert.equal(columns(schema.activities).has("impersonated_user_id"), false);
  });

  test("the timeline can hang off a property as well as a job", () => {
    // A property's history outlives any one job on it.
    assert.ok(columns(schema.activities).has("property_id"));
  });
});

describe("secrets are not stored in the clear", () => {
  test("a scheduling token is kept as a hash", () => {
    // A leaked database row must not become a working link.
    const token = columns(schema.schedulingTokens);
    assert.ok(token.has("token_hash"));
    assert.equal(token.has("token"), false);
  });

  test("a certificate is referenced by an opaque key, not a URL", () => {
    const document = columns(schema.documents);
    assert.ok(document.has("blob_key"));
    assert.equal(document.has("url"), false);
  });
});

describe("the schema agrees with the code it has to work with", () => {
  test("customer types match the booking form's", () => {
    // The form writes these; a mismatch would fail at insert, in production.
    assert.deepEqual(
      [...schema.customerTypeEnum.enumValues].sort(),
      [...customerTypes].map((type) => type.replace("-", "_")).sort(),
    );
  });

  test("the plan field exists and nothing depends on it yet", () => {
    // Recorded from the start so introducing a paid plan later is a permission
    // check rather than a migration against live accounts.
    assert.deepEqual(
      [...schema.organisationPlanEnum.enumValues],
      ["free_legacy", "agent_standard", "agent_pro", "enterprise"],
    );
    assert.equal(
      columns(schema.agentOrganisations).get("plan")?.default,
      "free_legacy",
    );
  });

  test("the safe default for remedial authority is nothing without asking", () => {
    assert.equal(
      columns(schema.agentOrganisations).get("remedial_authority_pence")?.default,
      0,
    );
  });
});

describe("uniqueness that the business depends on", () => {
  test("references, invoice numbers and idempotency keys are unique", () => {
    assert.ok(uniqueIndexes(schema.jobs).includes("job_reference_key"));
    assert.ok(uniqueIndexes(schema.jobs).includes("job_idempotency_key"));
    assert.ok(uniqueIndexes(schema.invoices).includes("invoice_number_key"));
    assert.ok(
      uniqueIndexes(schema.outboundEmails).includes(
        "outbound_email_idempotency_key",
      ),
    );
    assert.ok(
      uniqueIndexes(schema.schedulingTokens).includes(
        "scheduling_token_hash_key",
      ),
    );
  });

  test("invoice numbers come from a sequence, not from a count", () => {
    // Counting rows races; a sequence is atomic and never reissues a value,
    // even when the transaction that drew one rolls back.
    const migration = readFileSync(
      path.resolve(process.cwd(), "drizzle/0001_invoice_number_sequence.sql"),
      "utf8",
    );
    assert.match(migration, /CREATE SEQUENCE IF NOT EXISTS invoice_number_seq/);
    assert.match(migration, /START WITH 1\b/);
  });
});

describe("migrations are reviewable and reversible", () => {
  const journal = JSON.parse(
    readFileSync(
      path.resolve(process.cwd(), "drizzle/meta/_journal.json"),
      "utf8",
    ),
  ) as { entries: { tag: string }[] };

  test("every migration has a counterpart that undoes it", () => {
    assert.ok(journal.entries.length > 0);
    for (const entry of journal.entries) {
      const down = path.resolve(
        process.cwd(),
        `drizzle/down/${entry.tag}.down.sql`,
      );
      assert.doesNotThrow(
        () => readFileSync(down, "utf8"),
        `${entry.tag} has no down migration`,
      );
    }
  });

  test("the foundation is one migration, because none of it has been applied", () => {
    /*
      Nothing is deployed and `DATABASE_URL` is set nowhere, so the schema was
      reshaped in place rather than corrected by a stack of follow-up
      migrations. That freedom ends the first time this runs against real data.
    */
    assert.deepEqual(
      journal.entries.map((entry) => entry.tag),
      ["0000_v2_foundation", "0001_invoice_number_sequence"],
    );
  });

  test("the destructive one says so", () => {
    const down = readFileSync(
      path.resolve(process.cwd(), "drizzle/down/0000_v2_foundation.down.sql"),
      "utf8",
    );
    assert.match(down, /DESTRUCTIVE/);
  });

  test("every table in the schema is created by the migration", () => {
    // A table added to schema.ts without regenerating the migration exists in
    // the types and nowhere else, and fails at the first query in production.
    const migration = readFileSync(
      path.resolve(process.cwd(), "drizzle/0000_v2_foundation.sql"),
      "utf8",
    );

    for (const value of Object.values(schema)) {
      if (typeof value !== "object" || value === null) continue;
      let name: string;
      try {
        name = getTableConfig(value as Table).name;
      } catch {
        continue;
      }
      assert.ok(
        migration.includes(`CREATE TABLE "${name}"`),
        `${name} is in the schema but not in the migration`,
      );
    }
  });

  test("the migration drops everything it creates", () => {
    const migration = readFileSync(
      path.resolve(process.cwd(), "drizzle/0000_v2_foundation.sql"),
      "utf8",
    );
    const down = readFileSync(
      path.resolve(process.cwd(), "drizzle/down/0000_v2_foundation.down.sql"),
      "utf8",
    );

    for (const [, name] of migration.matchAll(/CREATE TABLE "([a-z_]+)"/g)) {
      assert.ok(
        down.includes(`DROP TABLE IF EXISTS "${name}"`),
        `${name} is created but never dropped`,
      );
    }
    for (const [, name] of migration.matchAll(/CREATE TYPE "public"\."([a-z_]+)"/g)) {
      assert.ok(
        down.includes(`DROP TYPE IF EXISTS "public"."${name}"`),
        `${name} is created but never dropped`,
      );
    }
  });
});
