/**
 * The V2 persistent model.
 *
 * Postgres is the operational source of truth for job, customer and property
 * history. Google Calendar remains the scheduling and availability system;
 * Resend remains the communication system. Neither is a customer database
 * again — that was the V1 compromise this schema exists to end.
 *
 * Conventions:
 *
 * - Money is integer **pence**. Never a float, never a formatted string.
 * - Times that matter to a person are `timestamptz`; calendar *dates* that
 *   carry no time of day (a certificate expiry, a renewal due date) are `date`,
 *   so they cannot drift across a timezone boundary.
 * - Services live in code (`lib/booking/products.ts`), not in a table. They are
 *   business rules with durations and **list** prices attached, and a row that
 *   could disagree with the registry would be a second source of truth. What a
 *   particular agent *pays* is data — see `pricing_agreement`.
 * - Every organisation-scoped table carries `agent_organisation_id` directly
 *   rather than relying on a join, so a missing filter is visible at the call
 *   site instead of silently returning another agency's rows.
 * - Nothing is hard-deleted. Rows are deactivated; foreign keys `restrict`
 *   except where a child has no meaning without its parent.
 */

import {
  index,
  integer,
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  date,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** Mirrors `customerTypes` in `lib/booking/schema.ts`. */
export const customerTypeEnum = pgEnum("customer_type", [
  "landlord",
  "letting_agent",
  "tenant",
  "homeowner",
]);

/**
 * Who someone is, across every surface.
 *
 * One enum and one user table rather than separate staff and agent models: a
 * second login path is a second place to get password handling, session
 * shape and deactivation subtly wrong.
 *
 * `agent_owner` and `agent_member` differ only in whether they may manage
 * their organisation's users and pricing visibility. Both are scoped to one
 * organisation and neither can ever see another.
 */
export const appRoleEnum = pgEnum("app_role", [
  "admin",
  "engineer",
  "agent_owner",
  "agent_member",
]);

/**
 * The commercial arrangement an account is on.
 *
 * Recorded from the start and **inert**: nothing branches on it, there is no
 * SaaS billing in V2, and platform access is free for BSCJ compliance
 * customers. It exists so introducing a paid plan later is a permission check
 * rather than a migration against live accounts.
 */
export const organisationPlanEnum = pgEnum("organisation_plan", [
  "free_legacy",
  "agent_standard",
  "agent_pro",
  "enterprise",
]);

/** Who chose, or will choose, the appointment. */
export const schedulingMethodEnum = pgEnum("scheduling_method", [
  /** The customer booked their own slot on the public site. */
  "self_booked",
  /** A landlord or agent picked the time when creating the job. */
  "landlord_selected",
  /** The tenant was invited to choose. */
  "tenant_selected",
  /** BSCJ arranged it directly, by phone or in the admin area. */
  "admin_selected",
]);

/**
 * Where the *work* is. Deliberately not mixed with money or documents — see
 * `lib/jobs/lifecycle.ts` for the permitted transitions.
 *
 * "Certificate issued" and "invoiced" are deliberately absent. A job is
 * routinely completed, certificated and invoiced at once, and a single enum
 * has to pick one of those to display, which loses the other two. Both are
 * derived from whether the document exists — see `lib/jobs/derived.ts`.
 */
export const jobLifecycleStatusEnum = pgEnum("job_lifecycle_status", [
  "draft",
  "tenant_outreach",
  "awaiting_tenant",
  "scheduled",
  "engineer_assigned",
  "in_progress",
  "remedial_required",
  "completed",
  "cancelled",
]);

/**
 * Where the *money* is. Independent of the lifecycle above.
 *
 * Four things that genuinely happen, kept apart because conflating any two
 * of them loses a fact somebody will later need:
 *
 * - **`draft`** — editable, and holds no invoice number. An abandoned draft
 *   must not consume a number whose absence a business then has to explain.
 * - **`issued`** — a number is allocated, the identity, payer, lines, totals
 *   and PDF are frozen, and nothing edits it again. Added in `0006`.
 * - **`sent`** — a provider *accepted* an email carrying it. Not that it
 *   arrived, and emphatically not that it was paid.
 * - **`paid`** — an administrator recorded a payment. V2 takes no payments;
 *   this is somebody saying money turned up.
 *
 * `void` is the only way to undo an issue, and it keeps the number: a
 * reissued number is two documents claiming to be the same invoice.
 */
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "issued",
  "sent",
  "paid",
  "void",
]);

export const documentKindEnum = pgEnum("document_kind", [
  "certificate",
  "invoice",
]);

/** How this job reached us. */
export const jobSourceEnum = pgEnum("job_source", [
  "website_self",
  "website_landlord",
  "portal",
  "admin",
]);

/**
 * Whether the calendar reflects this job yet.
 *
 * A database transaction cannot make a Google API call atomic, so the intent
 * is recorded rather than assumed: a job awaiting a tenant needs no event, a
 * scheduled job whose write failed is `failed` and can be retried, and nothing
 * is silently inconsistent.
 */
export const calendarSyncStateEnum = pgEnum("calendar_sync_state", [
  "not_required",
  "pending",
  "synced",
  "failed",
]);

/** Durable delivery state for anything we intend to send. */
export const emailStateEnum = pgEnum("email_state", [
  "pending",
  "sent",
  "failed",
  "cancelled",
]);

/** Whether a renewal date was set by a person or derived by the rule. */
export const renewalSourceEnum = pgEnum("renewal_source", [
  "manual",
  "derived",
]);

/** Where a pricing agreement is in its life. */
export const pricingAgreementStatusEnum = pgEnum("pricing_agreement_status", [
  "draft",
  "active",
  "expired",
]);

/**
 * How a job's agreed unit price was arrived at. Stored on the job's price
 * snapshot so an invoice can always explain itself.
 */
export const priceSourceEnum = pgEnum("price_source", [
  /** No agreement applied; the public registry price was charged. */
  "list",
  /** A tier line from the organisation's agreement. */
  "agreement",
  /** An administrator set this job's price by hand, with a reason. */
  "override",
]);

/** Where a piece of remedial work has got to. */
export const remedialStatusEnum = pgEnum("remedial_status", [
  /** Found and written down. Nothing is owed or promised by this alone. */
  "recorded",
  /** Beyond the account's authority; the agent has been asked. */
  "awaiting_approval",
  "approved",
  "declined",
  /** Carried out, whether on the visit or on a later one. */
  "completed",
]);

/**
 * Whether an issued safety record is the current one.
 *
 * There is no "draft". A row in this table has been issued; work in progress
 * lives on the job until it is.
 */
export const certificateStatusEnum = pgEnum("certificate_status", [
  "issued",
  "superseded",
]);

/** How we tried to reach someone. SMS is designed for, not yet integrated. */
export const contactChannelEnum = pgEnum("contact_channel", [
  "email",
  "sms",
  "phone",
  "whatsapp",
]);

export const contactPurposeEnum = pgEnum("contact_purpose", [
  "invitation",
  "reminder",
  "escalation",
  "other",
]);

export const contactOutcomeEnum = pgEnum("contact_outcome", [
  "queued",
  "sent",
  "failed",
  "responded",
  "no_response",
]);

/** Who wrote a job message. */
export const messageAuthorKindEnum = pgEnum("message_author_kind", [
  "agent",
  "admin",
  "engineer",
  "system",
]);

/** Whether a compliance cycle is the property's current position. */
export const complianceCycleStatusEnum = pgEnum("compliance_cycle_status", [
  "active",
  "superseded",
  "cancelled",
]);

/**
 * What an account credential is for.
 *
 * The purpose is **part of the credential**, not a label beside it: it is
 * mixed into the hash (see `lib/auth/credential-token.ts`) and matched in the
 * `WHERE` of every redemption. A reset token presented at the invitation door
 * therefore fails to hash to anything stored, rather than relying on a check
 * somebody could forget to write.
 */
export const accountCredentialPurposeEnum = pgEnum("account_credential_purpose", [
  /** The first password on an account BSCJ opened. */
  "invitation",
  /** A password the holder of the address asked to replace. */
  "password_reset",
]);

/** How a reviewed portfolio import ended. */
export const portfolioImportStatusEnum = pgEnum("portfolio_import_status", [
  /** Claimed by a confirmation that has not yet reported back. */
  "running",
  /** Every row that was meant to be written was written. */
  "complete",
  /** Some rows were written and some were not. Both counts are recorded. */
  "partial",
  /** Nothing was written. */
  "failed",
]);

// ---------------------------------------------------------------------------
// Accounts and people
// ---------------------------------------------------------------------------

/**
 * A letting agency, or any organisation with a managed account.
 *
 * Absent for consumer work: a homeowner booking on the public site has no
 * organisation, and every organisation-scoped column is nullable for exactly
 * that reason.
 */
export const agentOrganisations = pgTable(
  "agent_organisation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** What they trade as, and what appears in the portal. */
    name: text("name").notNull(),
    /** The entity that gets invoiced, where it differs from the trading name. */
    legalName: text("legal_name"),
    companyNumber: text("company_number"),
    email: text("email").notNull(),
    phone: text("phone"),

    // -- Billing address, kept as parts so an invoice can lay it out ---------
    billingLine1: text("billing_line1"),
    billingLine2: text("billing_line2"),
    billingTown: text("billing_town"),
    billingPostcode: text("billing_postcode"),

    plan: organisationPlanEnum("plan").notNull().default("free_legacy"),

    /**
     * What an engineer may put right without asking, in pence.
     *
     * Zero — nothing without asking — is the safe default and the one BSCJ
     * has not yet moved off. A per-job override lives on the job.
     */
    remedialAuthorityPence: integer("remedial_authority_pence")
      .notNull()
      .default(0),

    /** Internal only. Never rendered to the agent. */
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("agent_organisation_name_idx").on(table.name),
    index("agent_organisation_active_idx").on(table.isActive),
  ],
);

/**
 * Anyone who signs in: BSCJ staff and agency users alike.
 *
 * `agentOrganisationId` is null for BSCJ staff and required in practice for
 * agency roles — a constraint the application enforces, because a nullable
 * column is the only way one table can hold both.
 *
 * **The organisation on a session token is a hint, never an authority.** Every
 * scoped query re-reads it from this table. See `lib/auth/session.ts`.
 */
export const appUsers = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentOrganisationId: uuid("agent_organisation_id").references(
      () => agentOrganisations.id,
      { onDelete: "restrict" },
    ),
    email: text("email").notNull(),
    name: text("name").notNull(),
    /**
     * scrypt, salted per user. See `lib/auth/password.ts`.
     *
     * **Null until the person sets one.** BSCJ opens an account and sends an
     * invitation; nobody types a password on their behalf. A null here is the
     * honest record of "invited, not yet accepted" — `authenticateUser`
     * refuses it, at the same cost as a wrong password, so the state is not
     * observable from the login form.
     */
    passwordHash: text("password_hash"),
    /** When a password was last set. Null means the invitation is outstanding. */
    passwordSetAt: timestamp("password_set_at", { withTimezone: true }),
    /**
     * Bumped whenever every existing session for this user must stop working.
     *
     * Sessions are JWTs, so there is no session table to delete from. The
     * version is signed into the token at sign-in and compared against this
     * column on every request that makes a decision — the same re-read
     * `currentIdentity` already performs, at no extra cost. A password reset
     * increments it, and every token issued before that moment is refused on
     * its next request rather than at its eight-hour expiry.
     */
    sessionVersion: integer("session_version").notNull().default(0),
    role: appRoleEnum("role").notNull().default("admin"),
    /** Reserved for TOTP. Null until second-factor work is done. */
    totpSecret: text("totp_secret"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("app_user_email_key").on(table.email),
    index("app_user_organisation_idx").on(table.agentOrganisationId),
    index("app_user_role_idx").on(table.role),
  ],
);

/**
 * A single-use credential for getting into an account: an invitation, or a
 * password reset.
 *
 * **Deliberately not `scheduling_token`.** That table's rows are reusable on
 * purpose — a tenant may open their link, close it and come back — and
 * reusability is exactly the property a credential that sets a password must
 * not have. Sharing one table would mean one `usedAt` column meaning two
 * opposite things, and one day meaning the wrong one.
 *
 * Four rules, and the schema carries each of them:
 *
 * - **Only the hash is stored.** The plain token is handed to exactly one
 *   caller, travels into one email, and exists nowhere else. A leaked row is
 *   not a working link. The hash is purpose-bound, so a row of one purpose
 *   cannot be redeemed as the other even if the column were ignored.
 * - **Single-use, atomically.** `consumedAt` is set by the same conditional
 *   `UPDATE` that reads the row, so two browsers submitting at once produce
 *   exactly one winner. *Opening* a link sets nothing — it is spent when a
 *   password is actually submitted.
 * - **Expiring.** `expiresAt` is checked in that same statement.
 * - **Revocable.** Redeeming one revokes the rest for that user, and BSCJ can
 *   revoke an outstanding invitation without deleting the record that it was
 *   sent.
 *
 * Rows are kept after use. "This invitation was redeemed on the 4th" is a
 * question the security log has to be able to answer.
 */
export const accountCredentials = pgTable(
  "account_credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    purpose: accountCredentialPurposeEnum("purpose").notNull(),
    /** `<algorithm>$<digest>`, over the purpose and the token together. */
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set once, by the statement that redeems it. Never set by opening it. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** The administrator who caused it, where one did. Null for a self-serve reset. */
    createdByUserId: uuid("created_by_user_id").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("account_credential_hash_key").on(table.tokenHash),
    index("account_credential_user_idx").on(table.userId, table.purpose),
    index("account_credential_expires_idx").on(table.expiresAt),
  ],
);

/**
 * One reviewed CSV import, and what it did.
 *
 * The row exists so a confirmation can be **retried without importing twice**.
 * `planDigest` covers the whole reviewed plan — every row, every resolution
 * the agent chose, and a nonce minted when the preview was built — so
 * re-submitting one preview is recognised, while genuinely uploading the same
 * file again is a new preview and therefore allowed.
 *
 * It is claimed before anything is written, by an insert that the unique index
 * arbitrates, so two browsers pressing Confirm together produce one import.
 *
 * `result` holds per-row outcomes, which is what makes a partial failure
 * reportable as what it was rather than as "some of it worked". **No raw file
 * is kept** — only the outcome of rows the agent had already reviewed.
 */
export const portfolioImports = pgTable(
  "portfolio_import",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentOrganisationId: uuid("agent_organisation_id")
      .notNull()
      .references(() => agentOrganisations.id, { onDelete: "restrict" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    /** The reviewed plan, hashed. The arbiter of "have I already run this?". */
    planDigest: text("plan_digest").notNull(),
    /** What the agent called the file. Presentation only; never re-read. */
    filename: text("filename"),
    rowCount: integer("row_count").notNull(),
    status: portfolioImportStatusEnum("status").notNull().default("running"),
    createdCount: integer("created_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    /** Per-row outcomes. Never the uploaded bytes. */
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("portfolio_import_plan_key").on(
      table.agentOrganisationId,
      table.planDigest,
    ),
    index("portfolio_import_organisation_idx").on(table.agentOrganisationId),
  ],
);

/**
 * A party: a landlord, an agency contact, a homeowner or a tenant paying for
 * their own work.
 *
 * One party table rather than two. A landlord in an agent's portfolio and a
 * homeowner who booked on the website are both rows here; the difference is
 * `type` and whether the organisation is set. A separate consumer model would
 * mean two places to look for "who is this".
 */
export const customers = pgTable(
  "customer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for consumer work taken through the public booking flow. */
    agentOrganisationId: uuid("agent_organisation_id").references(
      () => agentOrganisations.id,
      { onDelete: "restrict" },
    ),
    type: customerTypeEnum("type").notNull(),
    name: text("name").notNull(),
    /** Agency or company name, where the customer trades as one. */
    company: text("company"),
    email: text("email").notNull(),
    /** Canonical +447XXXXXXXXX, normalised by `lib/booking/contact.ts`. */
    phone: text("phone").notNull(),
    /*
      Where the bills go, which is not where the work happens.

      A property has an address and so does the person paying for work on it,
      and they are routinely different — an agency in one town billing for a
      flat in another. Nothing substitutes one for the other: an invoice with
      no billing address on file requires somebody to type one, and typing it
      here is what stops them typing it again next month.

      Null and empty are both "not supplied". Added in `0006`.
    */
    billingAddressLines: jsonb("billing_address_lines"),
    billingPostcode: text("billing_postcode"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("customer_email_idx").on(table.email),
    index("customer_name_idx").on(table.name),
    index("customer_organisation_idx").on(table.agentOrganisationId),
  ],
);

export const properties = pgTable(
  "property",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The landlord or owner. */
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    /**
     * The agency managing it, where one does.
     *
     * Carried here as well as on the customer because a landlord may have some
     * properties managed and some not, and because portfolio queries filter on
     * this column directly rather than joining through the landlord.
     */
    agentOrganisationId: uuid("agent_organisation_id").references(
      () => agentOrganisations.id,
      { onDelete: "restrict" },
    ),
    houseOrName: text("house_or_name").notNull(),
    street: text("street").notNull(),
    town: text("town"),
    /** Canonical uppercase, as validated against Postcodes.io. */
    postcode: text("postcode").notNull(),
    accessNotes: text("access_notes"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("property_customer_idx").on(table.customerId),
    index("property_postcode_idx").on(table.postcode),
    index("property_organisation_idx").on(table.agentOrganisationId),
  ],
);

/**
 * An occupancy of a property, not a person.
 *
 * Tenants change. Overwriting a tenant row loses who we actually contacted
 * last year, and last year's job would silently re-describe itself. Ending a
 * tenancy and starting a new one keeps both true.
 *
 * The current tenancy is the one with no `endedOn`.
 */
export const tenancies = pgTable(
  "tenancy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    /** All optional: a property may be empty, or the tenant not yet known. */
    name: text("name"),
    email: text("email"),
    phone: text("phone"),
    startedOn: date("started_on"),
    endedOn: date("ended_on"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("tenancy_property_idx").on(table.propertyId),
    index("tenancy_ended_idx").on(table.endedOn),
  ],
);

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * What one organisation has agreed to pay.
 *
 * The public list prices stay in `lib/booking/products.ts`. This overrides
 * them for one account, for a period. An organisation with no active agreement
 * pays list — which is what makes the mechanism safe to ship before any tier
 * figures have been approved.
 */
export const pricingAgreements = pgTable(
  "pricing_agreement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentOrganisationId: uuid("agent_organisation_id")
      .notNull()
      .references(() => agentOrganisations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    status: pricingAgreementStatusEnum("status").notNull().default("draft"),
    effectiveFrom: date("effective_from").notNull(),
    /** Null means open-ended. */
    effectiveTo: date("effective_to"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("pricing_agreement_organisation_idx").on(table.agentOrganisationId),
    index("pricing_agreement_status_idx").on(table.status),
    index("pricing_agreement_effective_idx").on(table.effectiveFrom),
  ],
);

/**
 * One price, for one service, at one volume tier.
 *
 * `productId` is a key of the code registry — the service catalogue is the
 * registry, so a new service is a registry entry plus lines here, never a new
 * table.
 *
 * The tier is stored as its bounds rather than as a named band, so the band
 * structure can be changed without a migration and without re-labelling
 * agreements that were signed under the old one. `tierMaxJobs` null means
 * "and above".
 */
export const pricingAgreementLines = pgTable(
  "pricing_agreement_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pricingAgreementId: uuid("pricing_agreement_id")
      .notNull()
      .references(() => pricingAgreements.id, { onDelete: "cascade" }),
    /** e.g. "cp12". Validated against the registry by the application. */
    productId: text("product_id").notNull(),
    tierMinJobs: integer("tier_min_jobs").notNull(),
    tierMaxJobs: integer("tier_max_jobs"),
    unitPricePence: integer("unit_price_pence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("pricing_agreement_line_key").on(
      table.pricingAgreementId,
      table.productId,
      table.tierMinJobs,
    ),
    index("pricing_agreement_line_agreement_idx").on(table.pricingAgreementId),
  ],
);

/**
 * The volume an organisation committed to for one month, agreed **in advance**.
 *
 * This is what selects the tier. Deciding it up front rather than from
 * trailing actuals is a deliberate commercial choice: a price that is only
 * knowable at month end cannot be quoted, invoiced promptly, or explained to
 * an agent who wants to know what a job costs before they submit it.
 *
 * Actual submitted, completed and invoiced volumes are counted separately from
 * the jobs themselves. They diverge from the commitment constantly, and each
 * answers a different question.
 */
export const volumeCommitments = pgTable(
  "volume_commitment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentOrganisationId: uuid("agent_organisation_id")
      .notNull()
      .references(() => agentOrganisations.id, { onDelete: "restrict" }),
    /** The first day of the month this commitment covers. */
    periodStart: date("period_start").notNull(),
    /** Jobs committed for the period. Decides the tier. */
    committedJobs: integer("committed_jobs").notNull(),
    notes: text("notes"),
    agreedBy: uuid("agreed_by").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    agreedAt: timestamp("agreed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("volume_commitment_period_key").on(
      table.agentOrganisationId,
      table.periodStart,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** "BSCJ-XXXXXX". Human-readable identifier, never an authorisation. */
    reference: text("reference").notNull(),

    /** Null for consumer work. */
    agentOrganisationId: uuid("agent_organisation_id").references(
      () => agentOrganisations.id,
      { onDelete: "restrict" },
    ),

    /** Who commissioned the work. */
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    /**
     * Who gets invoiced.
     *
     * Separate from `customerId` on purpose: an agent may commission work that
     * the landlord pays for, and a portfolio may bill centrally.
     */
    billingCustomerId: uuid("billing_customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    /** Null when the customer is providing access themselves. */
    tenancyId: uuid("tenancy_id").references(() => tenancies.id, {
      onDelete: "set null",
    }),
    /** Set when the work is allocated to an engineer. */
    assignedEngineerId: uuid("assigned_engineer_id").references(
      () => appUsers.id,
      { onDelete: "set null" },
    ),

    /** A key of the code-side service registry, e.g. "cp12". */
    productId: text("product_id").notNull(),
    /** Null for products that do not price by appliance. */
    applianceCount: integer("appliance_count"),
    priceTotalPence: integer("price_total_pence").notNull(),

    // -- Snapshots ---------------------------------------------------------
    /*
      Deliberate denormalisation, and the only kind in this schema.

      Foreign keys alone cannot keep history honest: if a property changes
      hands, an agency is renamed or a tier is renegotiated, last year's job
      would silently re-describe itself, and so would the certificate and
      invoice already sent for it. The live relations answer "what is true
      now"; these snapshots answer "what was true when this job was taken".

      `priceSnapshot` in particular is what makes a later pricing change unable
      to alter an existing job. Its shape is defined and validated in
      `lib/pricing/snapshot.ts`.
    */
    customerSnapshot: jsonb("customer_snapshot").notNull(),
    propertySnapshot: jsonb("property_snapshot").notNull(),
    priceSnapshot: jsonb("price_snapshot").notNull(),

    // -- Dates, kept as distinct concepts ----------------------------------
    /** The expiry of the certificate the property already holds, if known. */
    currentCertificateExpiry: date("current_certificate_expiry"),
    /** The date the customer asked us to complete by, if they gave one. */
    completeByDate: date("complete_by_date"),
    /**
     * The customer asked for this as soon as possible rather than naming a
     * date. A request, recorded as one — never a promise of a date.
     */
    requestedAsap: boolean("requested_asap").notNull().default(false),
    /**
     * When the engineer said they were on site.
     *
     * Recorded rather than inferred. The timeline carries the event too, but
     * a column is what lets a list say "started 10:42" without reading every
     * activity row for every job on the page.
     */
    workStartedAt: timestamp("work_started_at", { withTimezone: true }),
    /** When the engineer actually finished. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /**
     * What the engineer found, in their own words, recorded at completion.
     *
     * Not a certificate and not a substitute for one. It is the operational
     * note that would otherwise live in somebody's memory between the visit
     * and the paperwork, and it is deliberately free text: nothing in it is
     * parsed, and nothing downstream reads a fact out of it.
     */
    completionNotes: text("completion_notes"),
    /**
     * When the next inspection is due.
     *
     * Derived by `lib/compliance/renewal.ts` from the inspection date, and
     * overridable by hand — `nextRenewalSource` records which happened.
     */
    nextRenewalDate: date("next_renewal_date"),
    nextRenewalSource: renewalSourceEnum("next_renewal_source"),

    // -- Appointment -------------------------------------------------------
    appointmentStart: timestamp("appointment_start", { withTimezone: true }),
    appointmentEnd: timestamp("appointment_end", { withTimezone: true }),
    /** Copied from the product at booking, so history survives a change. */
    durationMinutes: integer("duration_minutes"),
    schedulingMethod: schedulingMethodEnum("scheduling_method").notNull(),

    // -- State -------------------------------------------------------------
    lifecycleStatus: jobLifecycleStatusEnum("lifecycle_status").notNull(),
    calendarEventId: text("calendar_event_id"),
    calendarSyncState: calendarSyncStateEnum("calendar_sync_state")
      .notNull()
      .default("not_required"),
    /**
     * A calendar event this job has moved away from and not yet cleaned up.
     *
     * Rescheduling cannot be atomic across Postgres and Google: the
     * replacement event is created before the superseded one can safely be
     * removed, and the process may die between the two. Writing the old id
     * here **in the same statement that moves the appointment** means the
     * obsolete event is always recoverable — a crash leaves a row that names
     * exactly what still has to be deleted, rather than a phantom appointment
     * nobody knows about. Cleared once the deletion succeeds.
     */
    calendarPreviousEventId: text("calendar_previous_event_id"),
    /** Set when an appointment was accepted after the requested deadline. */
    deadlineExceptionAt: timestamp("deadline_exception_at", {
      withTimezone: true,
    }),
    /**
     * What this job's engineer may put right without asking, in pence.
     *
     * Null means "use the organisation's standing authority". A value here is
     * a deliberate per-job decision and overrides it.
     */
    remedialAuthorityPence: integer("remedial_authority_pence"),
    source: jobSourceEnum("source").notNull(),
    /**
     * The submission that created this job. Unique, so a retried or
     * double-clicked submission finds the existing row instead of writing a
     * second one.
     */
    idempotencyKey: text("idempotency_key").notNull(),

    createdBy: uuid("created_by").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("job_reference_key").on(table.reference),
    uniqueIndex("job_idempotency_key").on(table.idempotencyKey),
    index("job_organisation_idx").on(table.agentOrganisationId),
    index("job_customer_idx").on(table.customerId),
    index("job_billing_customer_idx").on(table.billingCustomerId),
    index("job_property_idx").on(table.propertyId),
    index("job_engineer_idx").on(table.assignedEngineerId),
    index("job_status_idx").on(table.lifecycleStatus),
    index("job_appointment_idx").on(table.appointmentStart),
    index("job_deadline_idx").on(table.completeByDate),
    index("job_renewal_idx").on(table.nextRenewalDate),
    index("job_calendar_event_idx").on(table.calendarEventId),
    // The reconciliation queue: every superseded event still to be removed.
    index("job_calendar_cleanup_idx").on(table.calendarPreviousEventId),
    // The other half of that queue: appointments Google does not reflect yet.
    index("job_calendar_sync_state_idx").on(table.calendarSyncState),
  ],
);

// ---------------------------------------------------------------------------
// Tenant scheduling
// ---------------------------------------------------------------------------

export const schedulingTokens = pgTable(
  "scheduling_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    /**
     * A hash, never the token itself — the same discipline the 30-minute slot
     * holds already use. A leaked database row must not become a working link.
     */
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("scheduling_token_hash_key").on(table.tokenHash),
    index("scheduling_token_job_idx").on(table.jobId),
  ],
);

// ---------------------------------------------------------------------------
// Documents, certificates, invoices
// ---------------------------------------------------------------------------

export const documents = pgTable(
  "document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for a consolidated invoice, which belongs to a period not a job. */
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "restrict" }),
    /** Carried directly so an access check never has to join to find it. */
    agentOrganisationId: uuid("agent_organisation_id").references(
      () => agentOrganisations.id,
      { onDelete: "restrict" },
    ),
    kind: documentKindEnum("kind").notNull(),
    /** Opaque private storage key. Never a public URL. */
    blobKey: text("blob_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** The addresses it actually went to, recorded at send time. */
    sentTo: jsonb("sent_to"),
  },
  (table) => [
    index("document_job_idx").on(table.jobId),
    index("document_organisation_idx").on(table.agentOrganisationId),
    uniqueIndex("document_blob_key").on(table.blobKey),
  ],
);

/**
 * An issued safety record.
 *
 * **Rows here are never updated.** A correction inserts a new row with the
 * next `version`, pointing at the one it supersedes, with a reason and an
 * author; the superseded row and its PDF are kept. A gas safety record that
 * can be edited in place is a falsifiable document, and this table exists
 * mainly to make that impossible.
 *
 * `nextDueDate` is stored rather than recomputed on read so a later change to
 * the renewal rule cannot retrospectively move a date already printed on a
 * certificate in a landlord's hands.
 */
export const certificates = pgTable(
  "certificate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    agentOrganisationId: uuid("agent_organisation_id").references(
      () => agentOrganisations.id,
      { onDelete: "restrict" },
    ),
    /** As printed on the document. Allocated outside this table. */
    certificateNumber: text("certificate_number").notNull(),
    version: integer("version").notNull().default(1),
    supersedesId: uuid("supersedes_id"),
    status: certificateStatusEnum("status").notNull().default("issued"),
    /** The day the inspection happened. Drives the renewal calculation. */
    inspectionDate: date("inspection_date").notNull(),
    /** Inspection date + 12 months − 1 day. See `lib/compliance/renewal.ts`. */
    nextDueDate: date("next_due_date").notNull(),
    issuedBy: uuid("issued_by").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Required by the application when `version` is greater than one. */
    correctionReason: text("correction_reason"),
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("certificate_number_version_key").on(
      table.certificateNumber,
      table.version,
    ),
    index("certificate_job_idx").on(table.jobId),
    index("certificate_property_idx").on(table.propertyId),
    index("certificate_organisation_idx").on(table.agentOrganisationId),
    index("certificate_due_idx").on(table.nextDueDate),
  ],
);

/**
 * An invoice header.
 *
 * A header plus lines rather than one row per job, because that is the only
 * shape a consolidated monthly agent invoice fits in, and retrofitting it once
 * per-job invoices exist means rewriting issued documents.
 *
 * VAT is modelled from the start and **disabled**: BSCJ is not currently VAT
 * registered, `vatPence` is zero and no VAT wording is rendered. When
 * registration happens it becomes a setting and a rate, not a schema change.
 *
 * `identitySnapshot` freezes the business identity — trading name, legal
 * entity, company number, address, VAT position, footer wording — as it was
 * when the invoice was issued. The legal entity behind BSCJ is expected to
 * change; an invoice must not silently start claiming to have been issued by a
 * company that did not exist on its date.
 */
export const invoices = pgTable(
  "invoice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for consumer work. */
    agentOrganisationId: uuid("agent_organisation_id").references(
      () => agentOrganisations.id,
      { onDelete: "restrict" },
    ),
    /** Whoever the job says is billed, captured when the invoice is raised. */
    billingCustomerId: uuid("billing_customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    /**
     * "BSCJ-001000". Allocated from a Postgres sequence, **at issue**.
     *
     * Nullable since `0006`: a draft has no number. Drawing one when a draft
     * is created would consume a value every abandoned draft then leaves a
     * gap for — and a gap an accountant has to account for is worse than a
     * draft with no number at all.
     */
    number: text("number"),
    status: invoiceStatusEnum("status").notNull().default("draft"),

    /**
     * The job this invoice is for, when it is for exactly one.
     *
     * Redundant against `invoice_line.job_id` and deliberately so: it is the
     * column a partial unique index can hang on, which is what makes a
     * second active invoice for the same job impossible rather than merely
     * unlikely. Null for a consolidated invoice, which belongs to a period
     * and many jobs — and the index ignores nulls, so that shape stays open.
     */
    primaryJobId: uuid("primary_job_id").references(() => jobs.id, {
      onDelete: "restrict",
    }),

    /**
     * What the job was quoted, carried onto the invoice when the draft is
     * created.
     *
     * The invoice may legitimately differ — an extra appliance found on the
     * day, an agreed reduction — and that difference is a fact worth being
     * able to see. Keeping the quote here means an adjustment is *visible*
     * rather than inferred by re-pricing the job, which would produce
     * today's answer to last March's question.
     */
    quotedTotalPence: integer("quoted_total_pence"),

    /** The period a consolidated invoice covers. Null for a per-job invoice. */
    periodStart: date("period_start"),
    periodEnd: date("period_end"),

    subtotalPence: integer("subtotal_pence").notNull().default(0),
    /** Zero while VAT registration is disabled. */
    vatPence: integer("vat_pence").notNull().default(0),
    totalPence: integer("total_pence").notNull().default(0),
    /** The VAT position at issue, frozen. False today. */
    vatRegistered: boolean("vat_registered").notNull().default(false),
    vatNumber: text("vat_number"),

    /** Business identity as it stood when this was issued. */
    identitySnapshot: jsonb("identity_snapshot"),
    /**
     * The payer's name and billing address, frozen at issue.
     *
     * An agency that moves office must not retrospectively re-address an
     * invoice already in somebody's accounts. Held apart from the identity
     * snapshot because one is who sent it and the other is who owes it.
     */
    billingSnapshot: jsonb("billing_snapshot"),

    issuedAt: timestamp("issued_at", { withTimezone: true }),
    issuedBy: uuid("issued_by").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    dueDate: date("due_date"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** When payment was recorded — the moment somebody typed it. */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** The day the money arrived, as the administrator states it. */
    paidOn: date("paid_on"),
    /** How payment was recorded, when an admin marks it paid by hand. */
    paidNote: text("paid_note"),
    paidBy: uuid("paid_by").references(() => appUsers.id, {
      onDelete: "set null",
    }),

    /*
      Voiding, which is the only way to undo an issue.

      The number stays on the row. Releasing it for reuse would put two
      documents into the world claiming to be the same invoice, and the
      second one would be the only one anybody could find.
    */
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    /** Required by the application whenever an invoice is voided. */
    voidReason: text("void_reason"),
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("invoice_number_key").on(table.number),
    index("invoice_organisation_idx").on(table.agentOrganisationId),
    index("invoice_billing_customer_idx").on(table.billingCustomerId),
    index("invoice_status_idx").on(table.status),
    index("invoice_primary_job_idx").on(table.primaryJobId),
    /*
      One live invoice per job.

      Partial, on `status <> 'void'`, so a mistake can be voided and the job
      invoiced again — which is the whole point of voiding. Enforced by the
      database rather than by a read-then-write in the application, because
      two administrators pressing "raise an invoice" at the same moment is
      exactly the case a read-then-write does not cover.

      Declared in `0006` as raw SQL; Drizzle carries the name here so the
      application can recognise the violation it throws.
    */
  ],
);

/** The partial unique index declared in `0006`, by name. */
export const ONE_ACTIVE_INVOICE_PER_JOB = "invoice_active_job_key";

/**
 * One billable line.
 *
 * `jobId` is nullable so an adjustment, a call-out or an agreed credit can
 * exist as a line without inventing a job to hang it on.
 */
export const invoiceLines = pgTable(
  "invoice_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "restrict" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPricePence: integer("unit_price_pence").notNull(),
    totalPence: integer("total_pence").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    index("invoice_line_invoice_idx").on(table.invoiceId),
    index("invoice_line_job_idx").on(table.jobId),
  ],
);

// ---------------------------------------------------------------------------
// Remedial work
// ---------------------------------------------------------------------------

/**
 * Something found that needs putting right.
 *
 * Recording one asserts nothing about whether it *can* be put right. Some
 * failures cannot be made compliant, and nothing in this model may imply
 * otherwise — `remedial_status` has no "will be fixed" and the authority
 * snapshot records only what was permitted at the time.
 */
export const remedials = pgTable(
  "remedial",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    agentOrganisationId: uuid("agent_organisation_id").references(
      () => agentOrganisations.id,
      { onDelete: "restrict" },
    ),
    description: text("description").notNull(),
    notes: text("notes"),
    estimatedCostPence: integer("estimated_cost_pence"),
    status: remedialStatusEnum("status").notNull().default("recorded"),
    /** Done there and then, within authority. */
    completedOnVisit: boolean("completed_on_visit").notNull().default(false),
    /** What the engineer was actually authorised to spend, frozen. */
    authorityPence: integer("authority_pence").notNull().default(0),
    approvedBy: uuid("approved_by").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    declinedReason: text("declined_reason"),
    /** Follow-up work raised to carry this out. */
    followUpJobId: uuid("follow_up_job_id"),
    createdBy: uuid("created_by").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("remedial_job_idx").on(table.jobId),
    index("remedial_property_idx").on(table.propertyId),
    index("remedial_organisation_idx").on(table.agentOrganisationId),
    index("remedial_status_idx").on(table.status),
  ],
);

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

/**
 * A property's compliance position for one service, and the renewal it drives.
 *
 * One `active` cycle per property per service is the invariant the application
 * maintains: completing a job supersedes the old cycle and opens a new one.
 * Keeping the superseded rows is what makes a property's compliance history
 * readable years later.
 *
 * `dueDate` is stored, not computed on read. A later change to the rule must
 * not move a date a landlord has already been told.
 */
export const complianceCycles = pgTable(
  "compliance_cycle",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    agentOrganisationId: uuid("agent_organisation_id").references(
      () => agentOrganisations.id,
      { onDelete: "restrict" },
    ),
    /** Which service this cycle tracks, e.g. "cp12". */
    productId: text("product_id").notNull(),
    /** The job that established it. Null for a position entered by hand. */
    establishedByJobId: uuid("established_by_job_id").references(
      () => jobs.id,
      { onDelete: "set null" },
    ),
    certificateId: uuid("certificate_id").references(() => certificates.id, {
      onDelete: "set null",
    }),
    /** Null when only the due date is known, e.g. an imported portfolio. */
    inspectionDate: date("inspection_date"),
    dueDate: date("due_date").notNull(),
    /** Whether a person set the due date or the rule derived it. */
    dueDateSource: renewalSourceEnum("due_date_source").notNull(),
    status: complianceCycleStatusEnum("status").notNull().default("active"),
    /** The job raised to renew it, once one exists. */
    renewalJobId: uuid("renewal_job_id").references(() => jobs.id, {
      onDelete: "set null",
    }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("compliance_cycle_property_idx").on(table.propertyId),
    index("compliance_cycle_organisation_idx").on(table.agentOrganisationId),
    index("compliance_cycle_due_idx").on(table.dueDate),
    index("compliance_cycle_status_idx").on(table.status),
  ],
);

// ---------------------------------------------------------------------------
// Communication and history
// ---------------------------------------------------------------------------

/**
 * Everything we intend to send, with its delivery state.
 *
 * An agent submitting twenty properties must not watch twenty emails go out
 * before their submission succeeds, and must not see it fail because one
 * tenant's address bounced. Intent is written durably with the jobs; sending
 * happens after, and a failure is a row to retry rather than a lost invitation.
 *
 * `idempotencyKey` is unique, so a retry re-sends nothing that already went.
 */
export const outboundEmails = pgTable(
  "outbound_email",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    /**
     * The account this message is about, for the kinds that are about an
     * account rather than a job.
     *
     * An invitation and a password reset have no job, and never will. Both
     * columns being nullable is what lets one queue carry both without a
     * second worker, a second retry policy and a second set of mistakes.
     */
    appUserId: uuid("app_user_id").references(() => appUsers.id, {
      onDelete: "cascade",
    }),
    /** e.g. "tenant-scheduling-invitation". */
    kind: text("kind").notNull(),
    recipient: text("recipient").notNull(),
    /**
     * The address a person approved, frozen when the row was queued.
     *
     * Null for the kinds that resolve their recipient at send time — a
     * tenant invitation goes to whatever address is current, and nobody
     * approved a particular one. A certificate is the opposite: an
     * administrator saw the address and chose it, so re-resolving later
     * could send an approved document somewhere nobody approved.
     */
    recipientAddress: text("recipient_address"),
    idempotencyKey: text("idempotency_key").notNull(),
    state: emailStateEnum("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** A failure category, never the provider's message or the payload. */
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("outbound_email_idempotency_key").on(table.idempotencyKey),
    index("outbound_email_state_idx").on(table.state),
    index("outbound_email_job_idx").on(table.jobId),
    index("outbound_email_user_idx").on(table.appUserId),
  ],
);

/**
 * A record that we tried to reach someone.
 *
 * Separate from `outbound_email` because it covers channels an email table
 * cannot — a phone call, a WhatsApp message — and because it is the thing an
 * agent is shown when they ask "have you actually chased my tenant?".
 */
export const contactAttempts = pgTable(
  "contact_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    channel: contactChannelEnum("channel").notNull(),
    purpose: contactPurposeEnum("purpose").notNull(),
    outcome: contactOutcomeEnum("outcome").notNull().default("queued"),
    /** Masked or partial where it is shown to an agent. */
    recipient: text("recipient"),
    detail: text("detail"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("contact_attempt_job_idx").on(table.jobId),
    index("contact_attempt_purpose_idx").on(table.purpose),
  ],
);

/** A message about a job, in the portal rather than in somebody's inbox. */
export const messages = pgTable(
  "message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    agentOrganisationId: uuid("agent_organisation_id").references(
      () => agentOrganisations.id,
      { onDelete: "restrict" },
    ),
    authorKind: messageAuthorKindEnum("author_kind").notNull(),
    /** Null for a system message. */
    authorUserId: uuid("author_user_id").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("message_job_idx").on(table.jobId),
    index("message_organisation_idx").on(table.agentOrganisationId),
  ],
);

/**
 * The business timeline, shown to an agent.
 *
 * Deliberately not the security log. This is readable, scoped to a job or a
 * property, and safe to expose; `audit_event` is none of those things.
 * Merging them means either leaking security events into a customer view or
 * hiding the timeline.
 */
export const activities = pgTable(
  "activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, {
      onDelete: "cascade",
    }),
    agentOrganisationId: uuid("agent_organisation_id").references(
      () => agentOrganisations.id,
      { onDelete: "restrict" },
    ),
    /** e.g. "job.created", "tenant.scheduled", "invoice.sent". */
    kind: text("kind").notNull(),
    /** "system", "tenant", "customer", or "user:<uuid>". */
    actor: text("actor").notNull(),
    /** Structured context. Must never carry a secret or a full PII record. */
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("activity_job_idx").on(table.jobId),
    index("activity_property_idx").on(table.propertyId),
    index("activity_organisation_idx").on(table.agentOrganisationId),
    index("activity_created_idx").on(table.createdAt),
  ],
);

/**
 * The security log. Append-only, admin-only, never filtered by a
 * customer-facing query.
 *
 * `impersonatedUserId` and `impersonatedOrganisationId` are what make
 * view-as-agent safe to offer: an action taken while impersonating records
 * both the real administrator and the account they were viewing, so no action
 * is ever attributable to the wrong person.
 */
export const auditEvents = pgTable(
  "audit_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for an unauthenticated event, such as a failed sign-in. */
    actorUserId: uuid("actor_user_id").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    /** What the actor was, when the user row cannot say — e.g. "anonymous". */
    actorDescription: text("actor_description"),
    impersonatedUserId: uuid("impersonated_user_id").references(
      () => appUsers.id,
      { onDelete: "set null" },
    ),
    impersonatedOrganisationId: uuid("impersonated_organisation_id").references(
      () => agentOrganisations.id,
      { onDelete: "set null" },
    ),
    /** e.g. "auth.signin.failed", "document.read", "pricing.changed". */
    kind: text("kind").notNull(),
    /** What was acted on: "job", "invoice", "app_user", … */
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    /** Structured context. Never a credential, never a document body. */
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_event_actor_idx").on(table.actorUserId),
    index("audit_event_kind_idx").on(table.kind),
    index("audit_event_subject_idx").on(table.subjectType, table.subjectId),
    index("audit_event_created_idx").on(table.createdAt),
  ],
);

/**
 * Configuration a person must supply, rather than something code may invent.
 *
 * The business identity, the VAT position, the payment terms, the invoice
 * footer, the outreach windows: all facts about the business rather than
 * deployment secrets, and all of them changeable without a deploy. The legal
 * entity behind BSCJ is expected to change; this table is why that is an
 * afternoon rather than a release.
 *
 * Empty until provided. Code reads it and renders "not configured" — it never
 * falls back to a guess. See `lib/settings/business-identity.ts`.
 */
export const businessSettings = pgTable("business_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedBy: uuid("updated_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
});
