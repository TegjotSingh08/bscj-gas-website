import "server-only";

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { recordAudit } from "@/lib/audit/record";
import { assertCan } from "@/lib/auth/roles";
import type { AccessScope } from "@/lib/auth/scope";
import type { Session } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import {
  activities,
  agentOrganisations,
  appUsers,
  customers,
  documents,
  invoiceLines,
  invoices,
  jobs,
  properties,
} from "@/lib/db/schema";
import { productFor, isProductId } from "@/lib/booking/products";
import { parsePriceSnapshot } from "@/lib/pricing/snapshot";
import {
  buildIdentitySnapshot,
  invoiceTotals,
  missingInvoiceIdentityFields,
  type BusinessIdentity,
  type InvoiceTerms,
  type VatPosition,
} from "@/lib/settings/business-identity";
import {
  getBusinessIdentity,
  getInvoiceTerms,
  getVatPosition,
} from "@/lib/settings/store";
import {
  deleteDocument,
  putDocument,
  storageStatus,
} from "@/lib/storage/documents";
import { allocateInvoiceNumber } from "./allocate";
import {
  billingAddressLines,
  compareWithQuote,
  dueDateFrom,
  EMPTY_BILLING_ADDRESS,
  formatInvoiceDate,
  isEditable,
  isIssued,
  issueBlockers,
  parseBillingAddress,
  subtotalOf,
  validateBillingAddress,
  validateLines,
  type BillingAddress,
  type InvoiceStatus,
  type IssueBlocker,
  type LineInput,
  type ValidatedLine,
} from "./model";
import { renderInvoicePdf, renderInvoiceSvg } from "./pdf/render";

/**
 * Invoices: drafted, reviewed, issued, sent, settled.
 *
 * Five separate acts, exactly as certificates are, and for the same reason:
 * collapsing any two of them means a document reaching a customer because
 * somebody finished a form.
 *
 * What holds it together:
 *
 * - **A draft is derived from what was stored, never re-priced.** The job's
 *   `price_snapshot` is what was agreed when the work was taken. Nothing here
 *   calls `resolvePrice`; an invoice built by re-pricing a March job against
 *   September's configuration is not a record of what was agreed, it is
 *   today's guess about it.
 * - **The server owns every figure.** The form posts a description, a
 *   quantity and a unit price. Line totals, the subtotal, VAT and the total
 *   are recomputed here. A browser that can name a total can name zero.
 * - **A number is drawn once.** At issue, never for a draft, and a retry
 *   after a failure reuses the number the first attempt drew — which is what
 *   makes retrying safe rather than a way to burn the series.
 * - **An issued invoice is frozen.** Identity, payer, lines, totals and PDF.
 *   The only way back is to void it, with a reason, keeping the number.
 * - **Permission is re-derived here, from the row.** Every function takes a
 *   session, checks the capability and checks the scope. The screen that
 *   called it is not evidence of anything, and an engineer carries no
 *   `invoice:read` at all.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InvoiceResult =
  | { ok: true; message: string; invoiceId?: string }
  | { ok: false; error: string; errors?: Record<string, string> };

const NOT_FOUND = "That invoice could not be found.";
const JOB_NOT_FOUND = "That job could not be found.";
const NO_DATABASE = "The database is not available.";

/** The Postgres unique-violation code, and the index that raises it here. */
const UNIQUE_VIOLATION = "23505";
const ACTIVE_JOB_INDEX = "invoice_active_job_key";

function isDuplicateActiveInvoice(error: unknown): boolean {
  const text = String(
    (error as { code?: string })?.code === UNIQUE_VIOLATION
      ? ACTIVE_JOB_INDEX
      : ((error as Error)?.message ?? ""),
  );
  return text.includes(ACTIVE_JOB_INDEX);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type InvoiceConfiguration = {
  identity: BusinessIdentity;
  terms: InvoiceTerms;
  vat: VatPosition;
  /** Settings fields still empty. Empty list means invoices may be issued. */
  missing: string[];
  storageReady: boolean;
  storageRequirement: string | null;
};

/**
 * Everything an invoice needs that is not about a job.
 *
 * Read once per screen rather than three times, and reported as a list of
 * missing fields rather than a boolean, so an administrator is told what to
 * go and fill in instead of being told "no".
 */
export async function invoiceConfiguration(): Promise<InvoiceConfiguration> {
  const [identity, terms, vat] = await Promise.all([
    getBusinessIdentity(),
    getInvoiceTerms(),
    getVatPosition(),
  ]);
  const storage = storageStatus();

  return {
    identity,
    terms,
    vat,
    missing: missingInvoiceIdentityFields(identity, terms),
    storageReady: storage.ready,
    storageRequirement: storage.requirement,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export type InvoiceLineRow = {
  id: string;
  description: string;
  quantity: number;
  unitPricePence: number;
  totalPence: number;
  jobId: string | null;
  sortOrder: number;
};

export type LoadedInvoice = {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  agentOrganisationId: string | null;
  organisationName: string | null;
  primaryJobId: string | null;
  jobReference: string | null;
  /** The service address. Never the billing address. */
  propertyLine: string | null;
  payerId: string;
  payerName: string;
  payerCompany: string | null;
  payerEmail: string;
  billingAddress: BillingAddress;
  quotedTotalPence: number | null;
  subtotalPence: number;
  vatPence: number;
  totalPence: number;
  vatRegistered: boolean;
  vatNumber: string | null;
  identitySnapshot: unknown;
  billingSnapshot: unknown;
  issuedAt: Date | null;
  issuedByName: string | null;
  dueDate: string | null;
  sentAt: Date | null;
  paidAt: Date | null;
  paidOn: string | null;
  paidNote: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  documentId: string | null;
  documentFilename: string | null;
  documentSentTo: unknown;
  createdAt: Date;
  lines: InvoiceLineRow[];
};

function addressOfProperty(row: {
  houseOrName: string | null;
  street: string | null;
  town: string | null;
  postcode: string | null;
}): string | null {
  const parts = [row.houseOrName, row.street, row.town, row.postcode].filter(
    (p): p is string => Boolean(p && p.trim()),
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * One invoice, with its lines, for a caller who may see it.
 *
 * The scope decides, from the row:
 *
 * - **BSCJ staff with `invoice:read`** — everything, draft included.
 * - **An agency** — its own organisation's invoices, and **only once
 *   issued**. A draft is BSCJ's working document; showing an agency a figure
 *   nobody has approved invites an argument about a number that was never
 *   sent.
 * - **Nobody else.** An engineer has no `invoice:read` and never reaches
 *   here; a tenant scheduling session is not a session this code recognises.
 */
export async function loadInvoice(
  scope: AccessScope,
  invoiceId: string,
): Promise<LoadedInvoice | null> {
  const db = getDb();
  if (!db || !UUID.test(invoiceId)) return null;

  const [row] = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      status: invoices.status,
      agentOrganisationId: invoices.agentOrganisationId,
      organisationName: agentOrganisations.name,
      primaryJobId: invoices.primaryJobId,
      jobReference: jobs.reference,
      houseOrName: properties.houseOrName,
      street: properties.street,
      town: properties.town,
      postcode: properties.postcode,
      payerId: invoices.billingCustomerId,
      payerName: customers.name,
      payerCompany: customers.company,
      payerEmail: customers.email,
      billingLines: customers.billingAddressLines,
      billingPostcode: customers.billingPostcode,
      quotedTotalPence: invoices.quotedTotalPence,
      subtotalPence: invoices.subtotalPence,
      vatPence: invoices.vatPence,
      totalPence: invoices.totalPence,
      vatRegistered: invoices.vatRegistered,
      vatNumber: invoices.vatNumber,
      identitySnapshot: invoices.identitySnapshot,
      billingSnapshot: invoices.billingSnapshot,
      issuedAt: invoices.issuedAt,
      issuedByName: appUsers.name,
      dueDate: invoices.dueDate,
      sentAt: invoices.sentAt,
      paidAt: invoices.paidAt,
      paidOn: invoices.paidOn,
      paidNote: invoices.paidNote,
      voidedAt: invoices.voidedAt,
      voidReason: invoices.voidReason,
      documentId: invoices.documentId,
      documentFilename: documents.filename,
      documentSentTo: documents.sentTo,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.billingCustomerId))
    .leftJoin(jobs, eq(jobs.id, invoices.primaryJobId))
    .leftJoin(properties, eq(properties.id, jobs.propertyId))
    .leftJoin(agentOrganisations, eq(agentOrganisations.id, invoices.agentOrganisationId))
    .leftJoin(appUsers, eq(appUsers.id, invoices.issuedBy))
    .leftJoin(documents, eq(documents.id, invoices.documentId))
    .where(eq(invoices.id, invoiceId))
    .limit(1);

  if (!row) return null;

  const status = row.status as InvoiceStatus;

  if (scope.kind === "organisation") {
    if (row.agentOrganisationId !== scope.organisationId) return null;
    // A draft is not theirs to see, and neither is a voided one.
    if (!isIssued(status)) return null;
  }
  if (scope.kind === "assigned") return null;

  const lines = await db
    .select({
      id: invoiceLines.id,
      description: invoiceLines.description,
      quantity: invoiceLines.quantity,
      unitPricePence: invoiceLines.unitPricePence,
      totalPence: invoiceLines.totalPence,
      jobId: invoiceLines.jobId,
      sortOrder: invoiceLines.sortOrder,
    })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(invoiceLines.sortOrder);

  return {
    id: row.id,
    number: row.number,
    status,
    agentOrganisationId: row.agentOrganisationId,
    organisationName: row.organisationName,
    primaryJobId: row.primaryJobId,
    jobReference: row.jobReference,
    propertyLine: addressOfProperty(row),
    payerId: row.payerId,
    payerName: row.payerName ?? "",
    payerCompany: row.payerCompany,
    payerEmail: row.payerEmail ?? "",
    billingAddress: parseBillingAddress(row.billingLines, row.billingPostcode),
    quotedTotalPence: row.quotedTotalPence,
    subtotalPence: row.subtotalPence,
    vatPence: row.vatPence,
    totalPence: row.totalPence,
    vatRegistered: row.vatRegistered,
    vatNumber: row.vatNumber,
    identitySnapshot: row.identitySnapshot,
    billingSnapshot: row.billingSnapshot,
    issuedAt: row.issuedAt,
    issuedByName: row.issuedByName,
    dueDate: row.dueDate,
    sentAt: row.sentAt,
    paidAt: row.paidAt,
    paidOn: row.paidOn,
    paidNote: row.paidNote,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    documentId: row.documentId,
    documentFilename: row.documentFilename,
    documentSentTo: row.documentSentTo,
    createdAt: row.createdAt,
    lines,
  };
}

export type InvoiceSummary = {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  totalPence: number;
  payerName: string | null;
  organisationName: string | null;
  jobReference: string | null;
  issuedAt: Date | null;
  dueDate: string | null;
  paidOn: string | null;
  createdAt: Date;
  documentId: string | null;
};

/**
 * The list, newest first.
 *
 * An agency sees its own issued invoices and nothing else — no drafts, no
 * voided rows, no other organisation. The filter is a `WHERE`, not a check
 * after the fact, so a mistake in a later refactor cannot widen it silently.
 */
export async function listInvoices(
  scope: AccessScope,
  options: { status?: InvoiceStatus; limit?: number } = {},
): Promise<InvoiceSummary[]> {
  const db = getDb();
  if (!db) return [];
  if (scope.kind === "assigned") return [];

  const conditions = [];
  if (scope.kind === "organisation") {
    conditions.push(eq(invoices.agentOrganisationId, scope.organisationId));
    conditions.push(inArray(invoices.status, ["issued", "sent", "paid"]));
  }
  if (options.status) conditions.push(eq(invoices.status, options.status));

  return db
    .select({
      id: invoices.id,
      number: invoices.number,
      status: invoices.status,
      totalPence: invoices.totalPence,
      payerName: customers.name,
      organisationName: agentOrganisations.name,
      jobReference: jobs.reference,
      issuedAt: invoices.issuedAt,
      dueDate: invoices.dueDate,
      paidOn: invoices.paidOn,
      createdAt: invoices.createdAt,
      documentId: invoices.documentId,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.billingCustomerId))
    .leftJoin(agentOrganisations, eq(agentOrganisations.id, invoices.agentOrganisationId))
    .leftJoin(jobs, eq(jobs.id, invoices.primaryJobId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(invoices.createdAt))
    .limit(Math.min(options.limit ?? 100, 200)) as Promise<InvoiceSummary[]>;
}

/** Every invoice raised against one job, for the job page. Admin-scoped. */
export async function listJobInvoices(jobId: string): Promise<InvoiceSummary[]> {
  const db = getDb();
  if (!db || !UUID.test(jobId)) return [];

  return db
    .select({
      id: invoices.id,
      number: invoices.number,
      status: invoices.status,
      totalPence: invoices.totalPence,
      payerName: customers.name,
      organisationName: agentOrganisations.name,
      jobReference: jobs.reference,
      issuedAt: invoices.issuedAt,
      dueDate: invoices.dueDate,
      paidOn: invoices.paidOn,
      createdAt: invoices.createdAt,
      documentId: invoices.documentId,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.billingCustomerId))
    .leftJoin(agentOrganisations, eq(agentOrganisations.id, invoices.agentOrganisationId))
    .leftJoin(jobs, eq(jobs.id, invoices.primaryJobId))
    .where(eq(invoices.primaryJobId, jobId))
    .orderBy(desc(invoices.createdAt)) as Promise<InvoiceSummary[]>;
}

// ---------------------------------------------------------------------------
// Payers
// ---------------------------------------------------------------------------

export type EligiblePayer = {
  id: string;
  name: string;
  company: string | null;
  email: string;
  /** Why this customer is on the list at all. */
  relationship: string;
  hasBillingAddress: boolean;
};

/**
 * Who this job could legitimately be billed to.
 *
 * Three relationships, and only three: whoever commissioned the work, whoever
 * the job says is billed, and whoever owns the property. **Not "every customer
 * in the agency"** — a picker over the whole customer table is how an invoice
 * ends up addressed to the wrong landlord, and no relationship would justify
 * it.
 *
 * The job's own `billing_customer_id` is the initial selection everywhere.
 * Choosing differently is a deliberate act on one invoice; it does **not**
 * change the job's billing policy, which stays whatever the portfolio says.
 */
export async function eligiblePayers(jobId: string): Promise<EligiblePayer[]> {
  const db = getDb();
  if (!db || !UUID.test(jobId)) return [];

  const [job] = await db
    .select({
      customerId: jobs.customerId,
      billingCustomerId: jobs.billingCustomerId,
      propertyOwnerId: properties.customerId,
    })
    .from(jobs)
    .leftJoin(properties, eq(properties.id, jobs.propertyId))
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!job) return [];

  const relationships = new Map<string, string>();
  const note = (id: string | null, label: string) => {
    if (!id) return;
    const existing = relationships.get(id);
    relationships.set(id, existing ? `${existing}, ${label}` : label);
  };
  note(job.billingCustomerId, "billed for this job");
  note(job.customerId, "commissioned the work");
  note(job.propertyOwnerId, "owns the property");

  const ids = [...relationships.keys()];
  if (ids.length === 0) return [];

  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      company: customers.company,
      email: customers.email,
      billingLines: customers.billingAddressLines,
      billingPostcode: customers.billingPostcode,
    })
    .from(customers)
    .where(inArray(customers.id, ids));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    company: row.company,
    email: row.email,
    relationship: relationships.get(row.id) ?? "related to this job",
    hasBillingAddress:
      parseBillingAddress(row.billingLines, row.billingPostcode).lines.length > 0,
  }));
}

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

/**
 * Raising a draft from a completed job.
 *
 * Everything on it comes from what was **stored**: the product the job was
 * taken for, the appliance count recorded against it, and the price snapshot
 * frozen when it was booked. Nothing calls the pricing resolver, so a tier
 * renegotiated last week cannot change what a job taken in March is invoiced
 * for.
 *
 * **Only a completed job.** Invoicing work that has not happened is a
 * decision nobody has asked for, and the lifecycle already records when it
 * did.
 *
 * The duplicate check is the partial unique index, not a read: two
 * administrators pressing this at the same moment is exactly the case a
 * read-then-write does not cover.
 */
export async function createInvoiceDraft(input: {
  session: Session;
  jobId: string;
}): Promise<InvoiceResult> {
  const { session, jobId } = input;
  assertCan(session.user.role, "invoice:write");
  if (session.scope.kind !== "all") return { ok: false, error: JOB_NOT_FOUND };

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!UUID.test(jobId)) return { ok: false, error: JOB_NOT_FOUND };

  const [job] = await db
    .select({
      id: jobs.id,
      reference: jobs.reference,
      agentOrganisationId: jobs.agentOrganisationId,
      billingCustomerId: jobs.billingCustomerId,
      propertyId: jobs.propertyId,
      productId: jobs.productId,
      applianceCount: jobs.applianceCount,
      priceTotalPence: jobs.priceTotalPence,
      priceSnapshot: jobs.priceSnapshot,
      lifecycleStatus: jobs.lifecycleStatus,
      completedAt: jobs.completedAt,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!job) return { ok: false, error: JOB_NOT_FOUND };

  if (job.lifecycleStatus !== "completed") {
    return {
      ok: false,
      error:
        "That job is not completed. An invoice is raised for work that has been done.",
    };
  }

  const lines = draftLinesFor(job);
  const subtotalPence = subtotalOf(lines);

  /*
    VAT is applied at draft time from the *current* position and again at
    issue from the position frozen onto the invoice. Both give zero while
    registration is off; the second is the one that counts.
  */
  const vat = await getVatPosition();
  const totals = invoiceTotals(subtotalPence, vat);

  const invoiceId = crypto.randomUUID();

  try {
    await db.batch([
      db.insert(invoices).values({
        id: invoiceId,
        agentOrganisationId: job.agentOrganisationId,
        billingCustomerId: job.billingCustomerId,
        primaryJobId: job.id,
        // No number. A draft that is abandoned must not leave a gap.
        number: null,
        status: "draft",
        quotedTotalPence: job.priceTotalPence,
        subtotalPence: totals.subtotalPence,
        vatPence: totals.vatPence,
        totalPence: totals.totalPence,
        vatRegistered: totals.vatRegistered,
        vatNumber: totals.vatNumber,
        createdBy: session.user.id,
      }),
      db.insert(invoiceLines).values(
        lines.map((line) => ({
          invoiceId,
          jobId: line.jobId,
          description: line.description,
          quantity: line.quantity,
          unitPricePence: line.unitPricePence,
          totalPence: line.totalPence,
          sortOrder: line.sortOrder,
        })),
      ),
      db.insert(activities).values({
        jobId: job.id,
        propertyId: job.propertyId,
        agentOrganisationId: job.agentOrganisationId,
        kind: "invoice.drafted",
        actor: `user:${session.user.id}`,
        detail: { totalPence: totals.totalPence, quotedPence: job.priceTotalPence },
      }),
    ] as unknown as Parameters<typeof db.batch>[0]);
  } catch (error) {
    if (isDuplicateActiveInvoice(error)) {
      return {
        ok: false,
        error:
          "This job already has an invoice that has not been voided. Open that one instead of raising a second.",
      };
    }
    return {
      ok: false,
      error: "The draft could not be created. Nothing was recorded.",
    };
  }

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "invoice.drafted",
    subjectType: "invoice",
    subjectId: invoiceId,
    detail: { reference: job.reference, totalPence: totals.totalPence },
  });

  return { ok: true, message: "Draft created.", invoiceId };
}

/**
 * The lines a job prefills.
 *
 * Read out of the stored snapshot, and described in the words the product
 * registry uses — the same words the customer saw when they booked. The
 * appliance extra is a **separate line** rather than folded into the price,
 * because "£45 plus two appliances at £15" is what happened and an invoice
 * that says "£75, gas safety certificate" is one nobody can check.
 */
function draftLinesFor(job: {
  id: string;
  productId: string;
  applianceCount: number | null;
  priceTotalPence: number;
  priceSnapshot: unknown;
}): ValidatedLine[] {
  const snapshot = parsePriceSnapshot(job.priceSnapshot);
  const productName = isProductId(job.productId)
    ? productFor(job.productId).name
    : job.productId;

  if (!snapshot) {
    // No readable snapshot: one line for the total the job actually holds.
    // Still not a re-price — `price_total_pence` is what was agreed.
    return [
      {
        description: productName,
        quantity: 1,
        unitPricePence: job.priceTotalPence,
        totalPence: job.priceTotalPence,
        jobId: job.id,
        sortOrder: 0,
      },
    ];
  }

  const lines: ValidatedLine[] = [
    {
      description: productName,
      quantity: 1,
      unitPricePence: snapshot.unitPricePence,
      totalPence: snapshot.unitPricePence,
      jobId: job.id,
      sortOrder: 0,
    },
  ];

  if (snapshot.extraAppliances > 0 && snapshot.extraAppliancePence > 0) {
    lines.push({
      description: "Additional appliance",
      quantity: snapshot.extraAppliances,
      unitPricePence: snapshot.extraAppliancePence,
      totalPence: snapshot.extraAppliances * snapshot.extraAppliancePence,
      jobId: job.id,
      sortOrder: 1,
    });
  }

  return lines;
}

/**
 * Editing a draft.
 *
 * Descriptions, quantities and charges, the payer, and the payer's billing
 * address. Everything is revalidated and every total recomputed; the form's
 * own arithmetic is ignored entirely.
 *
 * **The job's price is never touched.** `job.price_total_pence` and
 * `job.price_snapshot` stay exactly as they were: they record what was
 * agreed, and an invoice that differs from them is an adjustment somebody
 * made — which is recorded as a difference, not by rewriting the agreement.
 */
export async function updateInvoiceDraft(input: {
  session: Session;
  invoiceId: string;
  lines: readonly LineInput[];
  payerId: unknown;
  billingAddressText: unknown;
  billingPostcode: unknown;
}): Promise<InvoiceResult> {
  const { session, invoiceId } = input;
  assertCan(session.user.role, "invoice:write");
  if (session.scope.kind !== "all") return { ok: false, error: NOT_FOUND };

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!UUID.test(invoiceId)) return { ok: false, error: NOT_FOUND };

  const [existing] = await db
    .select({
      id: invoices.id,
      status: invoices.status,
      primaryJobId: invoices.primaryJobId,
      billingCustomerId: invoices.billingCustomerId,
      agentOrganisationId: invoices.agentOrganisationId,
      quotedTotalPence: invoices.quotedTotalPence,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);

  if (!existing) return { ok: false, error: NOT_FOUND };
  if (!isEditable(existing.status as InvoiceStatus)) {
    return {
      ok: false,
      error:
        "That invoice has been issued. Void it and raise a new one — an issued invoice is never edited.",
    };
  }

  const validated = validateLines(input.lines);
  const address = validateBillingAddress(input.billingAddressText, input.billingPostcode);

  const errors: Record<string, string> = {
    ...(validated.ok ? {} : validated.errors),
    ...(address.ok ? {} : address.errors),
  };

  // The payer has to be one of the job's own related customers. A posted id
  // is a claim, not a permission.
  let payerId = existing.billingCustomerId;
  const posted = typeof input.payerId === "string" ? input.payerId : "";
  if (posted && posted !== existing.billingCustomerId) {
    const permitted = existing.primaryJobId
      ? await eligiblePayers(existing.primaryJobId)
      : [];
    if (!permitted.some((p) => p.id === posted)) {
      errors.payerId = "That payer is not related to this job.";
    } else {
      payerId = posted;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, error: "Some of that could not be saved.", errors };
  }
  if (!validated.ok || !address.ok) {
    return { ok: false, error: "Some of that could not be saved." };
  }

  const subtotalPence = subtotalOf(validated.lines);
  const vat = await getVatPosition();
  const totals = invoiceTotals(subtotalPence, vat);

  try {
    await db.batch([
      db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)),
      db.insert(invoiceLines).values(
        validated.lines.map((line) => ({
          invoiceId,
          jobId: line.jobId ?? existing.primaryJobId,
          description: line.description,
          quantity: line.quantity,
          unitPricePence: line.unitPricePence,
          totalPence: line.totalPence,
          sortOrder: line.sortOrder,
        })),
      ),
      db
        .update(invoices)
        .set({
          billingCustomerId: payerId,
          subtotalPence: totals.subtotalPence,
          vatPence: totals.vatPence,
          totalPence: totals.totalPence,
          vatRegistered: totals.vatRegistered,
          vatNumber: totals.vatNumber,
          updatedAt: new Date(),
        })
        // Still a draft when the write lands, or it does not land.
        .where(and(eq(invoices.id, invoiceId), eq(invoices.status, "draft"))),
      db
        .update(customers)
        .set({
          billingAddressLines: address.address.lines,
          billingPostcode: address.address.postcode,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, payerId)),
    ] as unknown as Parameters<typeof db.batch>[0]);
  } catch {
    return { ok: false, error: "That could not be saved." };
  }

  const comparison = compareWithQuote(existing.quotedTotalPence, totals.totalPence);

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "invoice.edited",
    subjectType: "invoice",
    subjectId: invoiceId,
    detail: {
      lines: validated.lines.length,
      totalPence: totals.totalPence,
      quotedPence: existing.quotedTotalPence,
      adjusted: comparison?.adjusted ?? false,
      payerChanged: payerId !== existing.billingCustomerId,
    },
  });

  return { ok: true, message: "Draft saved." };
}

/** Deleting a draft. Only a draft, and only one that drew no number. */
export async function discardInvoiceDraft(input: {
  session: Session;
  invoiceId: string;
}): Promise<InvoiceResult> {
  const { session, invoiceId } = input;
  assertCan(session.user.role, "invoice:write");
  if (session.scope.kind !== "all") return { ok: false, error: NOT_FOUND };

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!UUID.test(invoiceId)) return { ok: false, error: NOT_FOUND };

  const [existing] = await db
    .select({ status: invoices.status, number: invoices.number })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);

  if (!existing) return { ok: false, error: NOT_FOUND };
  if (existing.status !== "draft") {
    return { ok: false, error: "Only a draft can be discarded. Void it instead." };
  }
  if (existing.number) {
    /*
      A number was drawn, so an issue was attempted. Deleting the row now
      would leave a gap nobody could account for, and would lose the fact
      that an attempt happened at all. Void it — that keeps both.
    */
    return {
      ok: false,
      error:
        "This draft already drew an invoice number when an issue was attempted. Void it rather than deleting it.",
    };
  }

  await db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  await db.delete(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.status, "draft")));

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "invoice.discarded",
    subjectType: "invoice",
    subjectId: invoiceId,
  });

  return { ok: true, message: "Draft discarded." };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type RenderSource = {
  invoice: LoadedInvoice;
  identity: BusinessIdentity;
  terms: InvoiceTerms;
  vat: VatPosition;
  /** The issue date as `YYYY-MM-DD`, or null for an unissued draft. */
  issuedOn: string | null;
};

/**
 * The data the painter is given.
 *
 * For an **issued** invoice this is built from the frozen snapshots, not from
 * the live settings or the live customer row — that is the whole point of
 * freezing them. For a **draft** it is built from what is current, because a
 * draft has nothing frozen and the preview is there to show what issuing now
 * would produce.
 */
function renderInputFor(source: RenderSource) {
  const { invoice } = source;
  const issued = isIssued(invoice.status);

  const snapshot =
    issued && invoice.identitySnapshot && typeof invoice.identitySnapshot === "object"
      ? (invoice.identitySnapshot as {
          identity?: BusinessIdentity;
          terms?: InvoiceTerms;
          vat?: VatPosition;
        })
      : null;

  const billing =
    issued && invoice.billingSnapshot && typeof invoice.billingSnapshot === "object"
      ? (invoice.billingSnapshot as {
          payerName?: string;
          addressLines?: string[];
        })
      : null;

  return {
    identity: snapshot?.identity ?? source.identity,
    terms: snapshot?.terms ?? source.terms,
    vat: snapshot?.vat ?? source.vat,
    data: {
      number: invoice.number,
      date: source.issuedOn ? formatInvoiceDate(source.issuedOn) : null,
      dueDate: invoice.dueDate ? formatInvoiceDate(invoice.dueDate) : null,
      payerName: billing?.payerName ?? invoice.payerCompany ?? invoice.payerName,
      billingAddressLines:
        billing?.addressLines ?? billingAddressLines(invoice.billingAddress),
      propertyLine: invoice.propertyLine,
      lines: invoice.lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitPricePence: line.unitPricePence,
        totalPence: line.totalPence,
      })),
      subtotalPence: invoice.subtotalPence,
      vatPence: invoice.vatPence,
      totalPence: invoice.totalPence,
      draft: !issued && invoice.status !== "void",
      voided: invoice.status === "void",
    },
  };
}

export type InvoicePreview = {
  svg: string;
  warnings: string[];
  blockers: IssueBlocker[];
};

/**
 * The preview, rendered from the same instructions as the PDF.
 *
 * Not a mock-up of the invoice in HTML. The same `paintInvoice` call, the same
 * wrapping and the same overflow warnings, so what an administrator approves
 * is what is issued — a separately built preview drifts, and the first anybody
 * hears of it is a customer holding a page with text over the footer.
 */
export async function previewInvoice(input: {
  session: Session;
  invoiceId: string;
}): Promise<InvoicePreview | null> {
  const { session, invoiceId } = input;
  assertCan(session.user.role, "invoice:read");

  const invoice = await loadInvoice(session.scope, invoiceId);
  if (!invoice) return null;

  const config = await invoiceConfiguration();

  const issuedOn =
    invoice.issuedAt?.toISOString().slice(0, 10) ??
    new Date().toISOString().slice(0, 10);

  const { svg, warnings } = renderInvoiceSvg(
    renderInputFor({
      invoice,
      identity: config.identity,
      terms: config.terms,
      vat: config.vat,
      issuedOn,
    }),
  );

  return {
    svg,
    warnings,
    blockers: issueBlockers({
      status: invoice.status,
      lineCount: invoice.lines.length,
      totalPence: invoice.totalPence,
      billingAddress: invoice.billingAddress,
      missingSettings: config.missing,
      storageReady: config.storageReady,
    }),
  };
}

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

/**
 * Turning a draft into an invoice.
 *
 * The order matters, and each step is recoverable from the state the one
 * before it leaves:
 *
 * 1. **Re-check every blocker**, from the row. What the screen showed a
 *    minute ago is not evidence.
 * 2. **Draw the number**, once, and write it to the row. A retry finds the
 *    number already there and reuses it — which is what stops a failing
 *    provider or a dropped connection burning a value per attempt. This is
 *    also why a draft that has attempted issue keeps its number and can no
 *    longer simply be deleted.
 * 3. **Render the PDF** from the identity, terms and VAT position as they
 *    stand now, and freeze all three onto the invoice.
 * 4. **Store the bytes**, then write the document row and the status change
 *    together. Storage first, database second: a row pointing at a document
 *    that does not exist is unrecoverable, an orphaned object costs a
 *    fraction of a penny.
 * 5. **If the database write fails**, look for the row by its unique blob key
 *    before removing anything — a timeout can leave a committed row behind an
 *    error, and deleting then would destroy the bytes a real invoice points
 *    at. Certificates learned this the hard way (§20.f); the same rule
 *    applies here.
 */
export async function issueInvoice(input: {
  session: Session;
  invoiceId: string;
}): Promise<InvoiceResult> {
  const { session, invoiceId } = input;
  assertCan(session.user.role, "invoice:write");
  if (session.scope.kind !== "all") return { ok: false, error: NOT_FOUND };

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!UUID.test(invoiceId)) return { ok: false, error: NOT_FOUND };

  const invoice = await loadInvoice(session.scope, invoiceId);
  if (!invoice) return { ok: false, error: NOT_FOUND };

  const config = await invoiceConfiguration();

  const blockers = issueBlockers({
    status: invoice.status,
    lineCount: invoice.lines.length,
    totalPence: invoice.totalPence,
    billingAddress: invoice.billingAddress,
    missingSettings: config.missing,
    storageReady: config.storageReady,
  });

  if (blockers.length > 0) {
    return {
      ok: false,
      error: blockers.map((b) => b.message).join(" "),
      errors: Object.fromEntries(blockers.map((b) => [b.code, b.message])),
    };
  }

  // -- The number, once ---------------------------------------------------
  let number = invoice.number;
  if (!number) {
    try {
      number = await allocateInvoiceNumber();
    } catch {
      return {
        ok: false,
        error: "An invoice number could not be allocated. Nothing was issued.",
      };
    }

    const claimed = await db
      .update(invoices)
      .set({ number, updatedAt: new Date() })
      .where(
        and(
          eq(invoices.id, invoiceId),
          eq(invoices.status, "draft"),
          sql`${invoices.number} IS NULL`,
        ),
      )
      .returning({ id: invoices.id });

    if (claimed.length === 0) {
      /*
        Somebody else got there first, between the load and here. Re-read
        rather than guess: if they allocated a number this attempt carries
        on with theirs, and the one drawn above is simply never used. A gap
        in the series is expected and documented; two invoices sharing a
        number is not.
      */
      const [current] = await db
        .select({ number: invoices.number, status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1);

      if (!current?.number || current.status !== "draft") {
        return {
          ok: false,
          error:
            "That invoice was issued by somebody else a moment ago. Reload the page.",
        };
      }
      number = current.number;
    }
  }

  // -- The document -------------------------------------------------------
  const issuedAt = new Date();
  const issuedOn = issuedAt.toISOString().slice(0, 10);
  const dueDate = dueDateFrom(issuedOn, config.terms.paymentDueDays);
  const identitySnapshot = buildIdentitySnapshot(
    config.identity,
    config.vat,
    config.terms,
    issuedAt,
  );
  const billingSnapshot = {
    payerId: invoice.payerId,
    payerName: invoice.payerCompany ?? invoice.payerName,
    contactName: invoice.payerName,
    email: invoice.payerEmail,
    addressLines: billingAddressLines(invoice.billingAddress),
    capturedAt: issuedAt.toISOString(),
  };

  const { bytes, warnings } = renderInvoicePdf({
    identity: config.identity,
    terms: config.terms,
    vat: config.vat,
    data: {
      number,
      date: formatInvoiceDate(issuedOn),
      dueDate: dueDate ? formatInvoiceDate(dueDate) : null,
      payerName: billingSnapshot.payerName,
      billingAddressLines: billingSnapshot.addressLines,
      propertyLine: invoice.propertyLine,
      lines: invoice.lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitPricePence: line.unitPricePence,
        totalPence: line.totalPence,
      })),
      subtotalPence: invoice.subtotalPence,
      vatPence: invoice.vatPence,
      totalPence: invoice.totalPence,
      draft: false,
      voided: false,
    },
  });

  if (warnings.length > 0) {
    /*
      Something would not fit on the page. Refused rather than issued
      truncated: the number is kept on the row, so correcting the
      description and pressing again reuses it.
    */
    return {
      ok: false,
      error: `${warnings.join(" ")} Nothing was issued; the invoice number is held for when you press again.`,
    };
  }

  const stored = await putDocument(bytes);
  if (!stored.ok) {
    return {
      ok: false,
      error: `${stored.error} Nothing was issued.`,
    };
  }

  const documentId = crypto.randomUUID();
  const filename = `${number}.pdf`;

  try {
    await db.batch([
      db.insert(documents).values({
        id: documentId,
        jobId: invoice.primaryJobId,
        agentOrganisationId: invoice.agentOrganisationId,
        kind: "invoice",
        blobKey: stored.key,
        filename,
        contentType: "application/pdf",
        sizeBytes: bytes.byteLength,
        uploadedBy: session.user.id,
      }),
      db
        .update(invoices)
        .set({
          status: "issued",
          number,
          issuedAt,
          issuedBy: session.user.id,
          dueDate,
          identitySnapshot,
          billingSnapshot,
          documentId,
          updatedAt: issuedAt,
        })
        /*
          Still a draft when this lands, or it does not land. Two clicks
          racing produce one issue and one "reload the page", not two
          documents.
        */
        .where(and(eq(invoices.id, invoiceId), eq(invoices.status, "draft"))),
      db.insert(activities).values({
        jobId: invoice.primaryJobId,
        agentOrganisationId: invoice.agentOrganisationId,
        kind: "invoice.issued",
        actor: `user:${session.user.id}`,
        detail: { number, totalPence: invoice.totalPence },
      }),
    ] as unknown as Parameters<typeof db.batch>[0]);
  } catch {
    await cleanUpStoredInvoice(stored.key, session, invoiceId);
    return {
      ok: false,
      error:
        "The invoice could not be recorded. Its number is held — reload the page and try again.",
    };
  }

  const comparison = compareWithQuote(invoice.quotedTotalPence, invoice.totalPence);

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "invoice.issued",
    subjectType: "invoice",
    subjectId: invoiceId,
    detail: {
      number,
      reference: invoice.jobReference,
      totalPence: invoice.totalPence,
      quotedPence: invoice.quotedTotalPence,
      adjusted: comparison?.adjusted ?? false,
      payerId: invoice.payerId,
      sizeBytes: bytes.byteLength,
    },
  });

  return { ok: true, message: `Issued as ${number}.`, invoiceId };
}

/**
 * What to do with the bytes when the row that should point at them failed.
 *
 * Never a blind delete. A timeout, a dropped connection or an aborted request
 * can leave the row **committed** while the client sees an error, and deleting
 * then destroys the document a real invoice points at.
 */
async function cleanUpStoredInvoice(
  blobKey: string,
  session: Session,
  invoiceId: string,
): Promise<void> {
  const db = getDb();
  if (!db) return;

  let found: { id: string }[] | null = null;
  try {
    found = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.blobKey, blobKey))
      .limit(1);
  } catch {
    found = null;
  }

  if (found === null) {
    // The check itself failed. Keep the object: an orphan costs a fraction
    // of a penny and a wrong delete cannot be undone.
    await recordAudit({
      actorUserId: session.user.id,
      actorDescription: session.user.email,
      kind: "invoice.issue_uncertain",
      subjectType: "invoice",
      subjectId: invoiceId,
      detail: { blobKeyKept: true },
    });
    return;
  }

  if (found.length > 0) return; // It committed. Nothing to undo.

  await deleteDocument(blobKey);
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/** How long a payment note may be. A sentence, not a ledger. */
export const MAX_PAID_NOTE = 300;
/** A void has to say why, and somebody has to be able to read it later. */
export const MAX_VOID_REASON = 500;

/**
 * Recording that the money arrived.
 *
 * **V2 takes no payments.** This is an administrator stating a fact they
 * observed somewhere else — a bank statement, a transfer, cash on the day —
 * and it is stored as exactly that: a date they give, a note they write, and
 * who recorded it.
 *
 * Only an issued or sent invoice can be paid. A draft has not been asked for,
 * and a voided one was withdrawn.
 */
export async function markInvoicePaid(input: {
  session: Session;
  invoiceId: string;
  paidOn: unknown;
  note: unknown;
}): Promise<InvoiceResult> {
  const { session, invoiceId } = input;
  assertCan(session.user.role, "invoice:write");
  if (session.scope.kind !== "all") return { ok: false, error: NOT_FOUND };

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!UUID.test(invoiceId)) return { ok: false, error: NOT_FOUND };

  const paidOn = typeof input.paidOn === "string" ? input.paidOn.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
    return {
      ok: false,
      error: "Enter the date the payment arrived.",
      errors: { paidOn: "A date, as YYYY-MM-DD." },
    };
  }

  const parsed = new Date(`${paidOn}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: "That is not a date.", errors: { paidOn: "Not a date." } };
  }
  // A payment cannot have arrived tomorrow.
  if (parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    return {
      ok: false,
      error: "That date is in the future.",
      errors: { paidOn: "A payment cannot arrive in the future." },
    };
  }

  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > MAX_PAID_NOTE) {
    return {
      ok: false,
      error: "That note is too long.",
      errors: { note: `Keep it under ${MAX_PAID_NOTE} characters.` },
    };
  }

  const updated = await db
    .update(invoices)
    .set({
      status: "paid",
      paidOn,
      paidAt: new Date(),
      paidBy: session.user.id,
      paidNote: note === "" ? null : note,
      updatedAt: new Date(),
    })
    .where(and(eq(invoices.id, invoiceId), inArray(invoices.status, ["issued", "sent"])))
    .returning({ id: invoices.id, number: invoices.number, jobId: invoices.primaryJobId });

  if (updated.length === 0) {
    return {
      ok: false,
      error:
        "Only an issued invoice can be marked paid. Reload the page to see where this one is.",
    };
  }

  try {
    await db.insert(activities).values({
      jobId: updated[0]!.jobId,
      kind: "invoice.paid",
      actor: `user:${session.user.id}`,
      detail: { number: updated[0]!.number, paidOn },
    });
  } catch {
    /* A missing timeline entry is not worth failing a recorded payment. */
  }

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "invoice.paid",
    subjectType: "invoice",
    subjectId: invoiceId,
    detail: { number: updated[0]!.number, paidOn, hasNote: note !== "" },
  });

  return { ok: true, message: "Payment recorded." };
}

/**
 * Withdrawing an invoice.
 *
 * The only way to undo an issue, and it is deliberately not an edit: the row,
 * the number, the lines and the PDF all stay exactly as they were, and the
 * invoice reads `void` with a reason attached. Correcting an invoice means
 * voiding this one and raising another — which the partial unique index then
 * permits, because it ignores voided rows.
 *
 * **The number is never reused.** Two documents claiming to be `BSCJ-001004`
 * is a problem no amount of explanation fixes.
 */
export async function voidInvoice(input: {
  session: Session;
  invoiceId: string;
  reason: unknown;
}): Promise<InvoiceResult> {
  const { session, invoiceId } = input;
  assertCan(session.user.role, "invoice:write");
  if (session.scope.kind !== "all") return { ok: false, error: NOT_FOUND };

  const db = getDb();
  if (!db) return { ok: false, error: NO_DATABASE };
  if (!UUID.test(invoiceId)) return { ok: false, error: NOT_FOUND };

  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 4) {
    return {
      ok: false,
      error: "Say why this invoice is being voided.",
      errors: { reason: "A short reason, which stays on the record." },
    };
  }
  if (reason.length > MAX_VOID_REASON) {
    return {
      ok: false,
      error: "That reason is too long.",
      errors: { reason: `Keep it under ${MAX_VOID_REASON} characters.` },
    };
  }

  const updated = await db
    .update(invoices)
    .set({
      status: "void",
      voidedAt: new Date(),
      voidedBy: session.user.id,
      voidReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(invoices.id, invoiceId), ne(invoices.status, "void")))
    .returning({ id: invoices.id, number: invoices.number, jobId: invoices.primaryJobId });

  if (updated.length === 0) {
    return { ok: false, error: "That invoice is already void." };
  }

  try {
    await db.insert(activities).values({
      jobId: updated[0]!.jobId,
      kind: "invoice.voided",
      actor: `user:${session.user.id}`,
      detail: { number: updated[0]!.number, reason },
    });
  } catch {
    /* ignored */
  }

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "invoice.voided",
    subjectType: "invoice",
    subjectId: invoiceId,
    detail: { number: updated[0]!.number, reason },
  });

  return { ok: true, message: "Invoice voided. The number stays with it." };
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

/** Completed jobs with no live invoice — the "to invoice" queue. */
export async function countJobsAwaitingInvoice(): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(
      and(
        eq(jobs.lifecycleStatus, "completed"),
        sql`NOT EXISTS (
          SELECT 1 FROM ${invoices}
          WHERE ${invoices.primaryJobId} = ${jobs.id}
            AND ${invoices.status} <> 'void'
        )`,
      ),
    );

  return row?.count ?? 0;
}

/** Issued or sent, and not yet paid. */
export async function countUnpaidInvoices(): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(invoices)
    .where(inArray(invoices.status, ["issued", "sent"]));

  return row?.count ?? 0;
}

export { EMPTY_BILLING_ADDRESS, isIssued, isEditable };
export type { BillingAddress };
