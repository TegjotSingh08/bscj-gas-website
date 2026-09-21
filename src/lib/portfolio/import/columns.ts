/**
 * The columns a portfolio import accepts, and the template it hands out.
 *
 * One definition drives three things — the downloadable template, the header
 * matcher and the on-screen explanation — so a column cannot be added to the
 * template and forgotten in the parser, or explained one way and validated
 * another.
 *
 * **CSV only, and the label says so.** Spreadsheets arrive as .xlsx far more
 * often than as .csv, and pretending otherwise would be the wrong kind of
 * silence: every screen says CSV, the file input accepts CSV, and an .xlsx is
 * refused by name with the one-line instruction that fixes it. Reading .xlsx
 * means a parser for a zipped XML format, shared strings, number formats and
 * date serials — real work with real failure modes, and not this phase's.
 */

export type ColumnKey =
  /**
   * A whole address in one cell, the shape most agency exports carry.
   *
   * Not in the template — the template keeps the separate columns, which are
   * unambiguous — but mappable, so an export that has one column instead of
   * four needs no retyping. Split by `address-split.ts`, which refuses rather
   * than guesses. The separate columns win where both are present: explicit
   * beats derived.
   */
  | "fullAddress"
  | "houseOrName"
  | "street"
  | "town"
  | "postcode"
  | "accessNotes"
  | "landlordName"
  | "landlordCompany"
  | "landlordEmail"
  | "landlordPhone"
  | "tenantName"
  | "tenantEmail"
  | "tenantPhone"
  | "tenancyStartedOn"
  | "certificateExpiry"
  | "lastInspection";

export type ColumnSpec = {
  key: ColumnKey;
  /** Whether the downloadable template carries it. */
  inTemplate?: boolean;
  /** The header as it appears in the template. */
  header: string;
  required: boolean;
  /** What the agent is told about it, on screen and in the guidance row. */
  help: string;
  /** An example, for the sample row in the template. */
  example: string;
};

/**
 * The columns, in the order they appear in the template.
 *
 * Address first, because that is what an agent's own spreadsheet leads with;
 * then who owns it, then who lives there, then what it already holds.
 */
export const COLUMNS: readonly ColumnSpec[] = [
  {
    key: "fullAddress",
    header: "full_address",
    required: false,
    inTemplate: false,
    help: "The whole address in one cell, if your export has it that way — e.g. \"Flat 2, 14 Example Street, Wolverhampton, WV1 1AA\". Map this instead of the four columns below. Anything we cannot split confidently is shown for you to check.",
    example: "Flat 2, 14 Example Street, Wolverhampton, WV1 1AA",
  },
  {
    key: "houseOrName",
    header: "property_number_or_name",
    required: true,
    help: "House number or property name, e.g. 14 or Rose Cottage.",
    example: "14",
  },
  {
    key: "street",
    header: "street",
    required: true,
    help: "The street, without the number.",
    example: "Example Street",
  },
  {
    key: "town",
    header: "town",
    required: false,
    help: "Optional. Left blank it is filled in from the postcode.",
    example: "Wolverhampton",
  },
  {
    key: "postcode",
    header: "postcode",
    required: true,
    help: "A UK postcode. Spacing and case do not matter.",
    example: "WV1 1AA",
  },
  {
    key: "accessNotes",
    header: "access_notes",
    required: false,
    help: "Optional. Key safe, parking, side gate — anything the engineer needs.",
    example: "Key safe by the front door",
  },
  {
    key: "landlordName",
    header: "landlord_name",
    required: true,
    help: "The landlord or owner. Required — a property with no owner cannot be billed or told anything.",
    example: "A Landlord",
  },
  {
    key: "landlordCompany",
    header: "landlord_company",
    required: false,
    help: "Optional. Where the landlord trades as a company.",
    example: "Example Property Co",
  },
  {
    key: "landlordEmail",
    header: "landlord_email",
    required: true,
    help: "Required. Landlords with the same address are treated as the same person, so their properties stay together.",
    example: "landlord@example.invalid",
  },
  {
    key: "landlordPhone",
    header: "landlord_phone",
    required: true,
    help: "Required. A mobile or a landline — both are accepted.",
    example: "01902 000000",
  },
  {
    key: "tenantName",
    header: "tenant_name",
    required: false,
    help: "Optional. Leave the tenant columns blank for an empty property.",
    example: "A Tenant",
  },
  {
    key: "tenantEmail",
    header: "tenant_email",
    required: false,
    help: "Optional, but needed if the tenant is to choose their own appointment.",
    example: "tenant@example.invalid",
  },
  {
    key: "tenantPhone",
    header: "tenant_phone",
    required: false,
    help: "Optional. A UK mobile — a scheduling link cannot be sent to a landline.",
    example: "07700 900000",
  },
  {
    key: "tenancyStartedOn",
    header: "tenancy_started",
    required: false,
    help: "Optional. When the current tenancy began.",
    example: "2025-04-01",
  },
  {
    key: "certificateExpiry",
    header: "certificate_expiry",
    required: false,
    help: "Optional. When the current gas safety certificate runs out. Leave blank if you do not know — it is never guessed.",
    example: "2026-11-30",
  },
  {
    key: "lastInspection",
    header: "last_inspection",
    required: false,
    help: "Optional. The inspection the current certificate came from.",
    example: "2025-12-01",
  },
] as const;

/** The columns the downloadable template carries. */
export const TEMPLATE_COLUMNS: readonly ColumnSpec[] = COLUMNS.filter(
  (column) => column.inTemplate !== false,
);

export const HEADERS: readonly string[] = TEMPLATE_COLUMNS.map((c) => c.header);

export const REQUIRED_COLUMNS: readonly ColumnSpec[] = COLUMNS.filter(
  (c) => c.required,
);

/**
 * Matches a header from the file to a column.
 *
 * Forgiving about the things that differ between one agent's export and
 * another's — case, surrounding spaces, spaces versus underscores — and strict
 * about everything else. A header nobody can match is reported by name rather
 * than silently ignored, because a column quietly dropped is how a hundred
 * tenants go missing without anybody noticing.
 */
export function normaliseHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^﻿/, "")
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

const BY_HEADER = new Map<string, ColumnSpec>(
  COLUMNS.map((column) => [normaliseHeader(column.header), column]),
);

/**
 * A few aliases, for the headers an agent's own spreadsheet is likely to use.
 *
 * Deliberately a short, explicit list rather than fuzzy matching. A guess that
 * is right nine times in ten puts a landlord's phone number in the tenant's
 * column the tenth time, and nothing downstream would notice.
 */
const ALIASES: Record<string, ColumnKey> = {
  address: "fullAddress",
  full_address: "fullAddress",
  property_address: "fullAddress",
  address_1: "houseOrName",
  address1: "houseOrName",
  house: "houseOrName",
  house_number: "houseOrName",
  number: "houseOrName",
  property: "houseOrName",
  property_name: "houseOrName",
  address_2: "street",
  address2: "street",
  road: "street",
  city: "town",
  post_code: "postcode",
  postal_code: "postcode",
  owner: "landlordName",
  owner_email: "landlordEmail",
  owner_phone: "landlordPhone",
  landlord: "landlordName",
  tenant: "tenantName",
  notes: "accessNotes",
  access: "accessNotes",
  expiry: "certificateExpiry",
  cp12_expiry: "certificateExpiry",
  gas_safety_expiry: "certificateExpiry",
};

const BY_KEY = new Map<ColumnKey, ColumnSpec>(
  COLUMNS.map((column) => [column.key, column]),
);

/** The column a header names, or null. */
export function columnFor(header: string): ColumnSpec | null {
  const normalised = normaliseHeader(header);
  const direct = BY_HEADER.get(normalised);
  if (direct) return direct;

  const aliased = ALIASES[normalised];
  return aliased ? (BY_KEY.get(aliased) ?? null) : null;
}

/**
 * The template, as CSV text.
 *
 * Two rows: the headers, and one example. The example is obviously fictional —
 * `example.invalid` is reserved by RFC 2606 and cannot be a real address — so
 * an agent who forgets to delete it gets a validation error rather than a
 * property attributed to somebody who does not exist.
 *
 * **Every cell is quoted.** Not for correctness, which only needs it for cells
 * containing a comma or a quote, but because a bare cell beginning `=`, `+`,
 * `-` or `@` is executed as a formula by Excel when the file is opened. This
 * file is written by us and contains nothing dangerous; quoting it anyway
 * means the habit is in the code rather than in somebody's memory.
 */
export function templateCsv(): string {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return [
    TEMPLATE_COLUMNS.map((c) => quote(c.header)).join(","),
    TEMPLATE_COLUMNS.map((c) => quote(c.example)).join(","),
  ].join("\r\n") + "\r\n";
}

export const TEMPLATE_FILENAME = "bscj-portfolio-template.csv";
