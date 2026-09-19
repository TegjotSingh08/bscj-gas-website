/**
 * Turning one CSV row into a validated record, or into an error a person can
 * act on.
 *
 * **Every rule here is the rule the manual form already applies**, because the
 * parsers in `../validation.ts` are called directly: a row is assembled into a
 * `FormData` and handed to `parseLandlord`, `parseProperty`, `parseTenancy`
 * and `parseCompliance`. That is deliberate and it is the whole design. A
 * second set of validation for imported data is a second set of rules, and the
 * day they drift is the day an import can create something the form would
 * refuse.
 *
 * The one thing this module adds is **dates**. The form's fields are HTML date
 * inputs and always hand over ISO; a spreadsheet hands over whatever somebody
 * typed, so it is normalised here — and refused here when it is ambiguous —
 * before the shared parser ever sees it.
 *
 * Pure. No database, no organisation, no session. Which agency a row belongs
 * to is decided by the caller from `requireAgent()`, exactly as it is for the
 * manual form, and nothing in this file could express it if it wanted to.
 */

import {
  parseCompliance,
  parseLandlord,
  parseProperty,
  parseTenancy,
  propertyKey,
  type CompliancePositionInput,
  type LandlordInput,
  type PropertyInput,
  type TenancyInput,
} from "../validation";
import { COLUMNS, type ColumnKey, type ColumnSpec } from "./columns";
import { describeDateProblem, parseImportDate } from "./dates";

/** A problem with one cell, named by the column the agent sees. */
export type RowError = {
  /** The template header, so the message points at a column they can find. */
  column: string;
  message: string;
};

export type ImportRecord = {
  landlord: LandlordInput;
  property: PropertyInput;
  tenancy: TenancyInput | null;
  compliance: CompliancePositionInput | null;
  /** `postcode|house` — what duplicates are compared on. */
  key: string;
};

export type ParsedRow =
  | { ok: true; record: ImportRecord }
  | { ok: false; errors: RowError[] };

/** Values keyed by column, as read from the file. */
export type RowValues = Partial<Record<ColumnKey, string>>;

const BY_KEY = new Map<ColumnKey, ColumnSpec>(COLUMNS.map((c) => [c.key, c]));

function headerFor(key: ColumnKey): string {
  return BY_KEY.get(key)?.header ?? key;
}

/**
 * The form-field name each column maps to.
 *
 * The bridge between a spreadsheet column and the field the existing parser
 * already knows. Written out rather than derived, so adding a column is a
 * decision about which existing rule applies to it.
 */
const FIELD_NAMES: Record<ColumnKey, string> = {
  houseOrName: "houseOrName",
  street: "street",
  town: "town",
  postcode: "postcode",
  accessNotes: "accessNotes",
  landlordName: "name",
  landlordCompany: "company",
  landlordEmail: "email",
  landlordPhone: "phone",
  tenantName: "tenantName",
  tenantEmail: "tenantEmail",
  tenantPhone: "tenantPhone",
  tenancyStartedOn: "tenancyStartedOn",
  certificateExpiry: "certificateExpiry",
  lastInspection: "lastInspection",
};

/** Which column an error on a given form field belongs to, for the message. */
const COLUMN_FOR_FIELD = new Map<string, ColumnKey>(
  (Object.entries(FIELD_NAMES) as [ColumnKey, string][]).map(
    ([key, field]) => [field, key],
  ),
);

/**
 * The date columns, and whether a blank is allowed.
 *
 * All three are optional. A portfolio arrives with patchy records, and a
 * property whose certificate nobody can find is a real state — recorded as
 * "not known", never as compliant and never as overdue.
 */
const DATE_COLUMNS: ColumnKey[] = [
  "tenancyStartedOn",
  "certificateExpiry",
  "lastInspection",
];

/**
 * Validates one row.
 *
 * Collects **every** error rather than stopping at the first. An agent fixing
 * a spreadsheet wants one pass with all the problems on it, not five uploads
 * that each reveal one more.
 */
export function parseImportRow(values: RowValues): ParsedRow {
  const errors: RowError[] = [];
  const form = new FormData();

  for (const column of COLUMNS) {
    const raw = (values[column.key] ?? "").trim();
    if (!raw) continue;

    if (DATE_COLUMNS.includes(column.key)) {
      const parsed = parseImportDate(raw);
      if (!parsed.ok) {
        errors.push({
          column: column.header,
          message: describeDateProblem(parsed.problem),
        });
        continue;
      }
      form.set(FIELD_NAMES[column.key], parsed.iso);
      continue;
    }

    form.set(FIELD_NAMES[column.key], raw);
  }

  /*
    Required columns are checked here rather than left to the shared parsers,
    so the message names the **spreadsheet column** an agent can find rather
    than the form field a developer would. The parsers still enforce them; this
    only gets there first with a better sentence.
  */
  for (const column of COLUMNS) {
    if (!column.required) continue;
    if (!(values[column.key] ?? "").trim()) {
      errors.push({ column: column.header, message: "This column is required." });
    }
  }

  const landlord = parseLandlord(form);
  const property = parseProperty(form);
  const tenancy = parseTenancy(form);
  const compliance = parseCompliance(form);

  for (const parsed of [landlord, property, tenancy, compliance]) {
    if (parsed.ok) continue;
    for (const [field, message] of Object.entries(parsed.errors)) {
      const key = COLUMN_FOR_FIELD.get(field);
      const column = key ? headerFor(key) : field;
      // Not twice for one column: the required check above may already have
      // said the same thing in better words.
      if (errors.some((error) => error.column === column)) continue;
      errors.push({ column, message });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  if (!landlord.ok || !property.ok || !tenancy.ok || !compliance.ok) {
    // Unreachable: any failure put an error in the list above. Here so the
    // types are narrowed by a check rather than by an assertion.
    return { ok: false, errors: [{ column: "", message: "That row could not be read." }] };
  }

  return {
    ok: true,
    record: {
      landlord: landlord.value,
      property: property.value,
      tenancy: tenancy.value,
      compliance: compliance.value,
      key: propertyKey(property.value.postcode, property.value.houseOrName),
    },
  };
}
