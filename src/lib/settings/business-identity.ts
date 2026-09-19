/**
 * Who the business says it is, on a document.
 *
 * Every field here is **configuration, not code**, for one concrete reason:
 * the legal entity behind BSCJ is changing. Supreme Gas Ltd is the current
 * arrangement and BSCJ Solutions is intended to be incorporated around
 * 4–5 October 2026. An application that prints a company name from a constant
 * would need a release on that day — and would retrospectively re-attribute
 * every invoice already issued.
 *
 * So identity is a row, it is snapshotted onto each invoice when the invoice is
 * issued, and nothing in this file invents a value. An unset field reads as
 * "not configured" and the surface that needed it says so. There is no
 * fallback and no placeholder that could reach a customer.
 *
 * Pure and dependency-free; `store.ts` is the part that talks to the database.
 */

/** The `business_setting` keys this module owns. */
export const BUSINESS_IDENTITY_KEY = "business.identity";
export const VAT_SETTING_KEY = "business.vat";
export const INVOICE_TERMS_KEY = "invoice.terms";

/**
 * The identity that appears on an invoice or a certificate.
 *
 * `displayName` is what the customer recognises; `legalName` is the entity
 * that is actually contracting. They differ today and are expected to differ
 * again, so they are never collapsed into one field.
 */
export type BusinessIdentity = {
  /** The trading name shown at the top of a document. */
  displayName: string | null;
  /** An alternative trading name, where one is used alongside it. */
  tradingName: string | null;
  /** The contracting entity, as registered. */
  legalName: string | null;
  companyNumber: string | null;
  addressLines: string[];
  postcode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  gasSafeNumber: string | null;
  /** Confirmed separately before invoices are issued. Never invented. */
  footerText: string | null;

  /*
    The three optional lines under the name on a printed document.

    The invoice layout BSCJ already uses carries a tagline, a list of
    qualifications and a services strapline beneath the company name. They
    are optional here and absent by default: the layout leaves the space
    empty rather than printing anything nobody has confirmed, and a
    qualification nobody has typed is a claim this code will not make.
  */
  tagline: string | null;
  qualifications: string | null;
  serviceLines: string[];
};

export const EMPTY_BUSINESS_IDENTITY: BusinessIdentity = {
  displayName: null,
  tradingName: null,
  legalName: null,
  companyNumber: null,
  addressLines: [],
  postcode: null,
  phone: null,
  email: null,
  website: null,
  gasSafeNumber: null,
  footerText: null,
  tagline: null,
  qualifications: null,
  serviceLines: [],
};

/**
 * The VAT position.
 *
 * **BSCJ is not currently VAT registered** (confirmed 16 September 2026), so
 * `registered` is false, the rate is unused and no VAT line or wording may be
 * rendered anywhere. The shape exists in full from the start so registering
 * later is a settings change and a rate, not a redesign of the invoice system
 * and a migration of issued documents.
 *
 * `ratePercentBasisPoints` avoids a float: 20% is 2000, so a rate can never
 * arrive at an invoice as 19.999999999999996.
 */
export type VatPosition = {
  registered: boolean;
  number: string | null;
  ratePercentBasisPoints: number | null;
  /** When registration took effect, `YYYY-MM-DD`. */
  registeredFrom: string | null;
};

export const NOT_VAT_REGISTERED: VatPosition = {
  registered: false,
  number: null,
  ratePercentBasisPoints: null,
  registeredFrom: null,
};

/** Payment terms as printed. Empty until BSCJ confirms them. */
export type InvoiceTerms = {
  /** e.g. "Due on receipt". Never guessed. */
  paymentTerms: string | null;
  /** Days from issue to due date, when the terms imply one. */
  paymentDueDays: number | null;
  /** Free text describing how to pay. Bank details live here, not in code. */
  paymentInstructions: string | null;
};

export const EMPTY_INVOICE_TERMS: InvoiceTerms = {
  paymentTerms: null,
  paymentDueDays: null,
  paymentInstructions: null,
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function parseBusinessIdentity(value: unknown): BusinessIdentity {
  if (typeof value !== "object" || value === null) {
    return EMPTY_BUSINESS_IDENTITY;
  }
  const raw = value as Record<string, unknown>;

  return {
    displayName: optionalString(raw.displayName),
    tradingName: optionalString(raw.tradingName),
    legalName: optionalString(raw.legalName),
    companyNumber: optionalString(raw.companyNumber),
    addressLines: stringList(raw.addressLines),
    postcode: optionalString(raw.postcode),
    phone: optionalString(raw.phone),
    email: optionalString(raw.email),
    website: optionalString(raw.website),
    gasSafeNumber: optionalString(raw.gasSafeNumber),
    footerText: optionalString(raw.footerText),
    tagline: optionalString(raw.tagline),
    qualifications: optionalString(raw.qualifications),
    serviceLines: stringList(raw.serviceLines),
  };
}

/**
 * Reads the VAT position.
 *
 * Anything short of an explicit, complete registration reads as **not
 * registered**. A half-configured VAT row must never produce a document that
 * charges tax, so the failure direction is deliberate: the ambiguous case is
 * the safe one.
 */
export function parseVatPosition(value: unknown): VatPosition {
  if (typeof value !== "object" || value === null) return NOT_VAT_REGISTERED;
  const raw = value as Record<string, unknown>;

  if (raw.registered !== true) return NOT_VAT_REGISTERED;

  const number = optionalString(raw.number);
  const rate = raw.ratePercentBasisPoints;
  const validRate =
    typeof rate === "number" && Number.isInteger(rate) && rate >= 0;

  if (!number || !validRate) return NOT_VAT_REGISTERED;

  return {
    registered: true,
    number,
    ratePercentBasisPoints: rate,
    registeredFrom: optionalString(raw.registeredFrom),
  };
}

export function parseInvoiceTerms(value: unknown): InvoiceTerms {
  if (typeof value !== "object" || value === null) return EMPTY_INVOICE_TERMS;
  const raw = value as Record<string, unknown>;

  const days = raw.paymentDueDays;
  return {
    paymentTerms: optionalString(raw.paymentTerms),
    paymentDueDays:
      typeof days === "number" && Number.isInteger(days) && days >= 0
        ? days
        : null,
    paymentInstructions: optionalString(raw.paymentInstructions),
  };
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * What is still missing before an invoice may be issued.
 *
 * Returned as a list of field names rather than a boolean so an admin screen
 * can say exactly what to go and fill in. An empty list is the only thing that
 * permits issuing — code never fills a gap with a plausible default.
 */
export function missingInvoiceIdentityFields(
  identity: BusinessIdentity,
  terms: InvoiceTerms,
): string[] {
  const missing: string[] = [];

  if (!identity.displayName) missing.push("displayName");
  if (!identity.legalName) missing.push("legalName");
  if (identity.addressLines.length === 0) missing.push("addressLines");
  if (!identity.postcode) missing.push("postcode");
  if (!identity.email) missing.push("email");
  if (!identity.footerText) missing.push("footerText");
  if (!terms.paymentTerms) missing.push("paymentTerms");
  if (!terms.paymentInstructions) missing.push("paymentInstructions");

  return missing;
}

export function canIssueInvoices(
  identity: BusinessIdentity,
  terms: InvoiceTerms,
): boolean {
  return missingInvoiceIdentityFields(identity, terms).length === 0;
}

// ---------------------------------------------------------------------------
// VAT arithmetic
// ---------------------------------------------------------------------------

export type InvoiceTotals = {
  subtotalPence: number;
  vatPence: number;
  totalPence: number;
  vatRegistered: boolean;
  vatNumber: string | null;
};

/**
 * Totals for an invoice.
 *
 * While VAT registration is off this returns zero VAT and a total equal to the
 * subtotal — and `vatRegistered: false`, which is what tells the renderer to
 * print no VAT line, no VAT number and no "VAT" anywhere. Showing "VAT £0.00"
 * would be a claim about tax status that is not ours to make.
 *
 * Rounded half-up at the invoice level rather than per line, which is how a
 * total avoids being a penny out from the sum of its parts.
 */
export function invoiceTotals(
  subtotalPence: number,
  vat: VatPosition,
): InvoiceTotals {
  if (!vat.registered || vat.ratePercentBasisPoints === null) {
    return {
      subtotalPence,
      vatPence: 0,
      totalPence: subtotalPence,
      vatRegistered: false,
      vatNumber: null,
    };
  }

  const vatPence = Math.round(
    (subtotalPence * vat.ratePercentBasisPoints) / 10_000,
  );

  return {
    subtotalPence,
    vatPence,
    totalPence: subtotalPence + vatPence,
    vatRegistered: true,
    vatNumber: vat.number,
  };
}

/**
 * The identity frozen onto an invoice at issue.
 *
 * An invoice must not silently start claiming to have been issued by a company
 * that did not exist on its date. This is the payload written to
 * `invoice.identity_snapshot`.
 */
export type IdentitySnapshot = {
  identity: BusinessIdentity;
  vat: VatPosition;
  terms: InvoiceTerms;
  capturedAt: string;
};

export function buildIdentitySnapshot(
  identity: BusinessIdentity,
  vat: VatPosition,
  terms: InvoiceTerms,
  capturedAt: Date = new Date(),
): IdentitySnapshot {
  return { identity, vat, terms, capturedAt: capturedAt.toISOString() };
}
