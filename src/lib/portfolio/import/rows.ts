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
import { describeAddressProblem, splitAddress } from "./address-split";
import { DEFAULT_PROFILE, type ImportProfile } from "./profile";

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
  /*
    Never a form field of its own: a combined address is *split* into the four
    below before the shared parsers see anything. Mapped to the house field
    only so the table stays total; `applyFullAddress` removes it first.
  */
  fullAddress: "houseOrName",
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
/** The parts a combined address supplies. */
const ADDRESS_KEYS: ColumnKey[] = ["houseOrName", "street", "town", "postcode"];

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
/**
 * Expands a combined address into the four separate values, if there is one.
 *
 * **The separate columns win.** An export that carries both is telling us the
 * same thing twice, and the explicit four are unambiguous where a split is
 * inferred. So this only fills what is absent.
 *
 * A split that fails does **not** silently fall through to "no address": it
 * returns the problem, the row is refused, and the preview shows a person the
 * cell it could not read. Guessing here would merge or split real properties —
 * `house_or_name` plus `postcode` is the key the duplicate check and the
 * unique index both use.
 */
function applyFullAddress(
  values: RowValues,
  mode: ImportProfile["addressMode"],
): { values: RowValues; error: RowError | null } {
  if (mode === "separate") return { values, error: null };

  const combined = (values.fullAddress ?? "").trim();
  if (!combined) return { values, error: null };

  /*
    `auto` prefers the separate columns where the file has them — explicit
    beats derived. `combined` is for an export whose separate columns BSCJ
    found unreliable, so it splits regardless.
  */
  const alreadySeparate =
    mode === "auto" &&
    (values.houseOrName ?? "").trim() &&
    (values.postcode ?? "").trim();
  if (alreadySeparate) return { values, error: null };

  const split = splitAddress(combined);
  if (!split.ok) {
    return {
      values,
      error: {
        column: "full_address",
        message: describeAddressProblem(split.problem),
      },
    };
  }

  const prefer = (existing: string | undefined, derived: string) =>
    mode === "combined" ? derived : existing?.trim() || derived;

  return {
    values: {
      ...values,
      houseOrName: prefer(values.houseOrName, split.value.houseOrName),
      street: prefer(values.street, split.value.street),
      town: prefer(values.town, split.value.town ?? ""),
      postcode: prefer(values.postcode, split.value.postcode),
    },
    error: null,
  };
}

export function parseImportRow(
  input: RowValues,
  profile: ImportProfile = DEFAULT_PROFILE,
): ParsedRow {
  const errors: RowError[] = [];
  const form = new FormData();

  const expanded = applyFullAddress(input, profile.addressMode);
  if (expanded.error) errors.push(expanded.error);
  const values = expanded.values;

  for (const column of COLUMNS) {
    // Already expanded above; it is not a field any parser knows.
    if (column.key === "fullAddress") continue;

    const raw = (values[column.key] ?? "").trim();
    if (!raw) continue;

    if (DATE_COLUMNS.includes(column.key)) {
      /*
        `iso_only` is for an export BSCJ found to mix conventions, where a
        day-first reading of some rows would be silently wrong. Refusing is
        the safe answer there; it is not the default.
      */
      if (profile.dateOrder === "iso_only" && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        errors.push({
          column: column.header,
          message:
            "This agency's profile accepts YYYY-MM-DD only. Convert the column, or ask BSCJ to change the profile.",
        });
        continue;
      }
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
    if ((values[column.key] ?? "").trim()) continue;
    /*
      A missing address part is reported against `full_address` when that is
      where it should have come from — pointing an agent at `postcode` when
      their file has no such column is an instruction they cannot follow.
    */
    if (expanded.error && ADDRESS_KEYS.includes(column.key)) continue;
    errors.push({ column: column.header, message: "This column is required." });
  }

  const landlord = parseLandlord(form);
  const property = parseProperty(form);
  const tenancy = parseTenancy(form);
  const compliance = parseCompliance(form);

  for (const parsed of [landlord, property, tenancy, compliance]) {
    if (parsed.ok) continue;
    for (const [field, message] of Object.entries(parsed.errors)) {
      const key = COLUMN_FOR_FIELD.get(field);
      /*
        When the combined address could not be split, the missing house,
        street and postcode are *consequences* of that one problem, not four
        separate ones. Reporting them all points the agent at columns their
        file does not have, which is an instruction they cannot follow.
      */
      if (expanded.error && key && ADDRESS_KEYS.includes(key)) continue;
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

  /*
    **An unconfirmed occupier column never becomes a tenancy.**

    A tenancy asserts that a named person lives at an address and is who we
    contact to arrange access — it is what a scheduling link is sent to. A
    column headed "Occupier" might be the tenant, a caretaker or the managing
    contact, and creating a tenancy from one nobody has confirmed is how a
    caretaker receives a tenant's link. Until BSCJ sets `occupierRole` to
    `tenant`, the name is kept as an access note: visible to the engineer,
    asserting nothing, contacting nobody.
  */
  let tenancyValue = tenancy.value;
  let property2 = property.value;

  if (tenancyValue && profile.occupierRole !== "tenant") {
    const carried = [tenancyValue.name, tenancyValue.email, tenancyValue.phone]
      .filter(Boolean)
      .join(", ");
    if (carried) {
      const note = `Occupier on file (role not confirmed): ${carried}`;
      property2 = {
        ...property2,
        accessNotes: property2.accessNotes
          ? `${property2.accessNotes}\n${note}`
          : note,
      };
    }
    tenancyValue = null;
  }

  return {
    ok: true,
    record: {
      landlord: landlord.value,
      property: property2,
      tenancy: tenancyValue,
      compliance: compliance.value,
      key: propertyKey(property2.postcode, property2.houseOrName),
    },
  };
}
