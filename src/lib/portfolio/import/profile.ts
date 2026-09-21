/**
 * An agency's import profile: what BSCJ learned from looking at their
 * spreadsheet once, recorded so nobody has to look again.
 *
 * **This is configuration, not code.** One importer serves every agency; what
 * differs between them is data in this shape. Adding an agency, or adjusting
 * one whose export changed, is an edit on a screen — never a release. Nothing
 * anywhere is named after a particular agency.
 *
 * A profile answers the four questions a spreadsheet raises that its headings
 * cannot:
 *
 * 1. **Which column is which** — `columns`.
 * 2. **What a second person-name column means** — `occupierRole`. "Occupier"
 *    might be the tenant, or a caretaker, or the managing contact. Guessing
 *    creates a tenancy asserting somebody lives there.
 * 3. **How to read an address and a date** — `addressMode`, `dateOrder`.
 * 4. **What to do when something is missing** — `landlordMatch`.
 *
 * Pure. Storage is `profile-store.ts`.
 */

import { COLUMNS, type ColumnKey } from "./columns";

/** Column key → the heading in this agency's file that carries it. */
export type ColumnMapping = Partial<Record<ColumnKey, string>>;

/**
 * What a second person-name column actually is.
 *
 * Defaults to `unknown`, and `unknown` **creates no tenancy**. A tenancy
 * asserts that a named person lives at an address and is who we contact to
 * arrange access; inventing one from a column whose meaning nobody confirmed
 * is how a caretaker's name ends up receiving a tenant's scheduling link.
 * The name is kept as an access note instead, where it is visible to the
 * engineer and claims nothing.
 */
export type OccupierRole = "tenant" | "unknown";

/**
 * How to read the address columns.
 *
 * `auto` uses the separate columns when they are mapped and falls back to the
 * combined one. The explicit settings exist for an export that carries both
 * and where only one is trustworthy.
 */
export type AddressMode = "auto" | "combined" | "separate";

/**
 * How to read an ambiguous date.
 *
 * `uk` is day-first, which is what a British agency's export contains.
 * `iso_only` refuses anything but `YYYY-MM-DD` — for an export known to mix
 * conventions, where refusing is safer than choosing.
 */
export type DateOrder = "uk" | "iso_only";

/**
 * What to do about a property whose landlord has **no email address**.
 *
 * Before migration `0008` this question barely arose: `customer.email` was
 * `NOT NULL`, so a contactless landlord could not be recorded however anybody
 * configured it. Now it can, which makes this a real policy with real
 * consequences — and makes it important that each option does what it says.
 *
 * - `reject_row` (the default, and what "hold the row" has always claimed to
 *   mean) — **the row is held.** Nothing is written for it, and the preview
 *   names the column to fill in. Nothing is invented and nothing is recorded
 *   on a guess.
 * - `record_without_contact` — the landlord is recorded **with no contact
 *   details**, which is what the file actually says. The property, its address
 *   and its due date all become visible and actionable. What is deferred is
 *   *reaching* them: issuing an invoice to that landlord, or releasing a
 *   certificate to them, refuses by name until an address exists.
 * - `match_existing_by_name` — as `record_without_contact`, plus: where the
 *   agency already has exactly one landlord of that name, the preview
 *   **suggests** it and asks. A name is evidence, not identity, so an
 *   unanswered suggestion holds the row and an ambiguous name holds it
 *   outright. A row that carries an email never uses this weaker signal.
 *
 * **No option ever invents an email address or a phone number.** The choice is
 * only between holding the row and recording what is genuinely known.
 */
export type LandlordMatch =
  | "reject_row"
  | "record_without_contact"
  | "match_existing_by_name";

export type ImportProfile = {
  /** Bumped if the shape changes, so an old row is recognised not misread. */
  version: 2;
  columns: ColumnMapping;
  occupierRole: OccupierRole;
  addressMode: AddressMode;
  dateOrder: DateOrder;
  landlordMatch: LandlordMatch;
  /** What BSCJ noticed about this export. Internal; never shown to the agency. */
  notes: string;
  /** ISO instant of the last edit. Presentation, and the staleness signal. */
  updatedAt: string;
};

export const PROFILE_VERSION = 2 as const;

/**
 * The profile an agency has before anybody configures one.
 *
 * **`occupierRole` is `tenant` here, and `unknown` on a new profile form.**
 * That looks inconsistent and is the point. An agency with no profile is using
 * the downloadable template, whose column is literally headed `tenant_name`
 * and documented as the tenant — the meaning is not in doubt and treating it
 * as unconfirmed would silently stop recording tenancies that the importer has
 * always recorded.
 *
 * The doubt arises when BSCJ maps *someone else's* column — "Occupier",
 * "Contact", "Resident" — onto it. That is the moment a person is reviewing a
 * spreadsheet, so that is where the cautious default belongs, and the admin
 * form starts there.
 *
 * Everything else is the cautious reading, so an unconfigured agency behaves
 * exactly as the importer did before profiles existed.
 */
export const DEFAULT_PROFILE: ImportProfile = {
  version: PROFILE_VERSION,
  columns: {},
  occupierRole: "tenant",
  addressMode: "auto",
  dateOrder: "uk",
  landlordMatch: "reject_row",
  notes: "",
  updatedAt: "",
};

/**
 * What a *newly created* profile starts as.
 *
 * Differs from `DEFAULT_PROFILE` in one field, for the reason above: somebody
 * is about to say what another system's column means, and "not confirmed" is
 * the honest starting point for that answer.
 */
export const NEW_PROFILE: ImportProfile = {
  ...DEFAULT_PROFILE,
  occupierRole: "unknown",
};

const OCCUPIER_ROLES: readonly OccupierRole[] = ["tenant", "unknown"];
const ADDRESS_MODES: readonly AddressMode[] = ["auto", "combined", "separate"];
const DATE_ORDERS: readonly DateOrder[] = ["uk", "iso_only"];
const LANDLORD_MATCHES: readonly LandlordMatch[] = [
  "reject_row",
  "record_without_contact",
  "match_existing_by_name",
];

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Reads a stored profile back.
 *
 * Defensive because the value comes from a jsonb column. Anything unexpected
 * falls back to the cautious default rather than being trusted into the import
 * path, and a heading naming a column the code does not define is dropped —
 * the column set is code, the profile is data, and data does not invent
 * columns.
 *
 * **Compatibility with profiles saved before `record_without_contact` existed.**
 * The shape did not change, so the version stays at 2 and every saved profile
 * is read back exactly as written. What changed is that `reject_row` now does
 * what its label always said — it holds the row instead of quietly recording a
 * contactless landlord, which is what it had started doing once migration
 * `0008` made the columns nullable. That is strictly more conservative: an
 * agency configured for `reject_row` writes **less** than before, never more,
 * and BSCJ moves them to `record_without_contact` in one click if holding is
 * not what they wanted. A saved value this code does not recognise still falls
 * back to `reject_row`, which is the option that writes nothing.
 */
export function parseProfile(value: unknown): ImportProfile {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_PROFILE };

  const raw = value as Record<string, unknown>;
  if (raw.version !== PROFILE_VERSION) return { ...DEFAULT_PROFILE };

  const known = new Set<string>(COLUMNS.map((column) => column.key));
  const columns: ColumnMapping = {};

  if (typeof raw.columns === "object" && raw.columns !== null) {
    for (const [key, heading] of Object.entries(
      raw.columns as Record<string, unknown>,
    )) {
      if (!known.has(key)) continue;
      if (typeof heading !== "string") continue;
      const trimmed = heading.trim();
      if (trimmed) columns[key as ColumnKey] = trimmed;
    }
  }

  return {
    version: PROFILE_VERSION,
    columns,
    occupierRole: oneOf(raw.occupierRole, OCCUPIER_ROLES, "unknown"),
    addressMode: oneOf(raw.addressMode, ADDRESS_MODES, "auto"),
    dateOrder: oneOf(raw.dateOrder, DATE_ORDERS, "uk"),
    landlordMatch: oneOf(raw.landlordMatch, LANDLORD_MATCHES, "reject_row"),
    notes: typeof raw.notes === "string" ? raw.notes.slice(0, 2000) : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

/**
 * A fingerprint of everything about a profile that changes what an import
 * would do.
 *
 * **This is what makes a changed profile invalidate an outstanding preview.**
 * A preview is a promise about what confirming will write, computed under the
 * profile as it was. If BSCJ corrects a mapping in between — says the second
 * name column is a caretaker, not a tenant — confirming the old preview would
 * write records the agent reviewed under a reading that is no longer BSCJ's.
 * So the digest travels inside the signed envelope and is compared at confirm.
 *
 * `notes` and `updatedAt` are excluded on purpose: a typo fixed in an internal
 * note changes nothing about the import, and invalidating a live preview over
 * it would be gratuitous.
 */
export function profileDigest(profile: ImportProfile): string {
  const columns = Object.entries(profile.columns)
    .map(([key, header]) => `${key}=${header}`)
    .sort()
    .join(",");

  return [
    `v${profile.version}`,
    columns,
    profile.occupierRole,
    profile.addressMode,
    profile.dateOrder,
    profile.landlordMatch,
  ].join("|");
}

/** The options an admin screen offers, with what each one means. */
export const PROFILE_CHOICES = {
  occupierRole: [
    {
      value: "tenant" as const,
      label: "A tenant living there",
      detail:
        "A tenancy is recorded, and they may be sent a scheduling link. Only choose this once the agency has confirmed the column means the occupier.",
    },
    {
      value: "unknown" as const,
      label: "Not confirmed — keep as an access note",
      detail:
        "No tenancy is recorded and nobody is contacted. The name is kept on the property for the engineer. This is the safe default.",
    },
  ],
  addressMode: [
    { value: "auto" as const, label: "Whichever the file has", detail: "Separate columns when mapped, otherwise the combined one." },
    { value: "combined" as const, label: "Always the combined column", detail: "For an export whose separate columns are unreliable." },
    { value: "separate" as const, label: "Always the separate columns", detail: "For an export whose combined column is unreliable." },
  ],
  dateOrder: [
    { value: "uk" as const, label: "Day first (31/01/2027)", detail: "What a British export normally contains. ISO is always accepted too." },
    { value: "iso_only" as const, label: "Only YYYY-MM-DD", detail: "Refuses anything else. For an export known to mix conventions." },
  ],
  /*
    Three genuinely different answers to "this row's landlord has no email
    address". Each `detail` states what is recorded **and** what still refuses
    afterwards, because "record it anyway" is only a safe choice if the person
    choosing knows what it defers.
  */
  landlordMatch: [
    {
      value: "reject_row" as const,
      label: "Hold the row — do not import it",
      detail:
        "Nothing is written for that property. The preview says which column to fill in and the agency uploads again. The safe default: choose it when the agency can get the addresses.",
    },
    {
      value: "record_without_contact" as const,
      label: "Record the landlord without contact details",
      detail:
        "The property, its address and its due date are recorded, and the landlord is recorded with whatever is known. No email or phone number is invented. Issuing an invoice to that landlord, or sending them a certificate, refuses until somebody adds an address. Choose it when the portfolio is worth recording before the contacts arrive.",
    },
    {
      value: "match_existing_by_name" as const,
      label: "Record without contact, and ask about matching names",
      detail:
        "As above, and when exactly one landlord of that name is already on file the preview asks whether it is the same person. A name is not proof, so an unanswered question holds the row, and two landlords of one name hold it outright. Only choose this where the agency's names are reliable.",
    },
  ],
} as const;

export type ProfileFieldErrors = Record<string, string>;

export type ParsedProfile =
  | { ok: true; value: Omit<ImportProfile, "version" | "updatedAt"> }
  | { ok: false; errors: ProfileFieldErrors };

/**
 * What an administrator is allowed to submit.
 *
 * Pure, so every rule is testable without a form or a database. Each setting
 * is read as an **allow-list**: a value the code does not define falls back to
 * the cautious option rather than being carried into the import path. A server
 * action is a public endpoint, and the column set and the option sets are
 * code — a form does not get to extend either.
 *
 * Column mappings arrive as `column-<key>` = the heading in the agency's file.
 * A key the code does not define is dropped; a blank heading means "this
 * agency's export does not have this column", which is a legitimate answer.
 */
export function parseProfileForm(form: FormData): ParsedProfile {
  const errors: ProfileFieldErrors = {};
  const known = new Set<string>(COLUMNS.map((column) => column.key));

  const columns: ColumnMapping = {};
  const claimed = new Map<string, ColumnKey>();

  for (const [field, value] of form.entries()) {
    if (!field.startsWith("column-")) continue;
    const key = field.slice("column-".length);
    if (!known.has(key)) continue;
    if (typeof value !== "string") continue;

    const heading = value.trim().slice(0, 120);
    if (!heading) continue;

    /*
      Two columns cannot be fed by one heading. Silently letting the last one
      win would put a landlord's phone number in the tenant's field, and the
      import would look perfectly successful.
    */
    const normalised = heading.toLowerCase().replace(/[\s-]+/g, "_");
    const already = claimed.get(normalised);
    if (already) {
      errors[`column-${key}`] = `"${heading}" is already used for ${already}.`;
      continue;
    }
    claimed.set(normalised, key as ColumnKey);
    columns[key as ColumnKey] = heading;
  }

  const pick = <T extends string>(
    field: string,
    allowed: readonly { value: T }[],
    fallback: T,
  ): T => {
    const raw = form.get(field);
    const values = allowed.map((option) => option.value) as readonly string[];
    return typeof raw === "string" && values.includes(raw) ? (raw as T) : fallback;
  };

  const notes = typeof form.get("notes") === "string" ? String(form.get("notes")) : "";
  if (notes.length > 2000) errors.notes = "Those notes are too long.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      columns,
      occupierRole: pick("occupierRole", PROFILE_CHOICES.occupierRole, "unknown"),
      addressMode: pick("addressMode", PROFILE_CHOICES.addressMode, "auto"),
      dateOrder: pick("dateOrder", PROFILE_CHOICES.dateOrder, "uk"),
      landlordMatch: pick("landlordMatch", PROFILE_CHOICES.landlordMatch, "reject_row"),
      notes: notes.trim(),
    },
  };
}
