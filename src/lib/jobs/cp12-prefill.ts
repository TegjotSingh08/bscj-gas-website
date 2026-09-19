/**
 * The CP12 prefill payload.
 *
 * The contract is `docs/CP12_PREFILL_MAPPING.md`, and this is the half of it
 * that runs on the server. The generator's own `saveDraft()` writes a flat
 * `{ elementId: value }` map over everything inside `#sheet`, so a prefill in
 * that shape needs no new format — but it must be a **strict subset**, and
 * that is what this module exists to guarantee.
 *
 * Three rules, and every one of them is a rule about what is *absent*:
 *
 * 1. **The allow-list is closed.** `CP12_PREFILL_FIELDS` is the only set of
 *    element ids that may appear in a payload. The importer in the generator
 *    holds the same list and drops anything else, so a file edited on disk
 *    cannot reach a field this never sends.
 * 2. **No reading, outcome or signature is ever included.** Not an appliance
 *    cell, not one of the six safety checks, not a defect, not a print name.
 *    Those are the engineer's findings and nothing may pre-empt them.
 * 3. **No date, and no certificate number.** The inspection date is confirmed
 *    on site; the renewal date is derived from it *afterwards*, by the one
 *    implementation in `compliance/renewal.ts`; and no certificate numbering
 *    scheme exists to draw from. Sending any of the three would be the
 *    application asserting something nobody has checked.
 *
 * Pure and dependency-free, so the whole mapping is testable without a
 * request, a session or a database.
 */

/**
 * Every element the bridge may fill, and nothing else.
 *
 * Thirteen of the sheet's thirty-one static fields. The rest — the appliance
 * table, the checks, the dates, the number and the signatures — are the
 * engineer's, and three more (`landlordAddress`, `landlordPostcode`,
 * `instIdCard`) are absent because the application does not hold them.
 */
export const CP12_PREFILL_FIELDS = [
  // The property being inspected
  "jobName",
  "jobAddress",
  "jobPostcode",
  "jobTel",
  // The customer or landlord this certificate is issued to
  "landlordName",
  "landlordCompany",
  "landlordTel",
  // Who is carrying it out
  "instEngineer",
  "instCompany",
  "instAddress",
  "instPostcode",
  "instTel",
  "instGasSafeReg",
] as const;

export type Cp12PrefillField = (typeof CP12_PREFILL_FIELDS)[number];

/**
 * Fields the mapping names but the application cannot supply yet.
 *
 * Carried in the payload as a list rather than left to be noticed: the
 * generator tells the engineer exactly what still needs typing, so a blank
 * box is a known gap rather than a bug they report.
 */
export const CP12_UNAVAILABLE_FIELDS = [
  {
    id: "landlordAddress",
    label: "Customer / landlord address",
    reason:
      "No address is stored for the customer. An agency's address is not theirs, so nothing is filled in here.",
  },
  {
    id: "landlordPostcode",
    label: "Customer / landlord postcode",
    reason:
      "No postcode is stored for the customer. The agency's billing postcode is a finance address and is never used here.",
  },
  {
    id: "instIdCard",
    label: "Gas Safe ID card number",
    reason: "Not held against the engineer's account yet.",
  },
  {
    id: "certNo",
    label: "Certificate number",
    reason: "No numbering scheme has been agreed. Enter it by hand.",
  },
  {
    id: "sigDate",
    label: "Inspection date",
    reason: "Confirm the date yourself, on the day of the visit.",
  },
] as const;

/** What the payload identifies itself as, so an importer can refuse a stranger. */
export const CP12_PAYLOAD_KIND = "bscj.cp12-prefill";
export const CP12_PAYLOAD_VERSION = 1;

export type Cp12PrefillPayload = {
  kind: typeof CP12_PAYLOAD_KIND;
  version: typeof CP12_PAYLOAD_VERSION;
  /** The job this belongs to. Shown to the engineer so they can check it. */
  reference: string;
  /**
   * A short description of the property, for the confirmation prompt.
   *
   * The importer shows it before it overwrites anything, which is the whole
   * defence against filling one property's details over another's findings.
   */
  propertyLabel: string;
  generatedAt: string;
  /** Only keys from `CP12_PREFILL_FIELDS`, and only non-empty ones. */
  fields: Partial<Record<Cp12PrefillField, string>>;
  /** What the engineer still has to type. */
  missing: Cp12MissingField[];
};

/** Everything the mapping draws on. Deliberately not a database row. */
export type Cp12PrefillFacts = {
  reference: string;
  property: {
    houseOrName: string | null;
    street: string | null;
    town: string | null;
    postcode: string | null;
  };
  /** Null when the job has no tenancy — the customer provides access. */
  tenancy: { name: string | null; phone: string | null } | null;
  customer: { name: string | null; company: string | null; phone: string | null };
  /*
    There is deliberately **no agency here**.

    Whether a job came through a letting agency changes who to invoice and
    who to notify; it does not change who the certificate is issued to. The
    agency's name and billing postcode are not passed to this function at
    all, so no future edit can quietly reach for them when a customer field
    is empty — which is exactly how the wrong party got onto the sheet once
    already.
  */
  engineerName: string | null;
  business: {
    displayName: string | null;
    addressLines: string[];
    postcode: string | null;
    phone: string | null;
    gasSafeNumber: string | null;
  };
};

/** Trims, and treats blank as absent. A field of spaces is not a value. */
function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Joined with newlines: both address targets on the sheet are textareas. */
function lines(...parts: (string | null | undefined)[]): string | undefined {
  const kept = parts.map(clean).filter((p): p is string => p !== undefined);
  return kept.length ? kept.join("\n") : undefined;
}

/**
 * The mapping.
 *
 * Every absent value is **omitted rather than sent as an empty string**. An
 * empty string is an instruction to clear a box; an omission leaves whatever
 * the engineer has already typed. That difference matters most on the
 * installer block, which an engineer will usually have saved as their own
 * defaults long before the business settings are filled in.
 */
export function buildCp12Fields(
  facts: Cp12PrefillFacts,
): Partial<Record<Cp12PrefillField, string>> {
  const fields: Partial<Record<Cp12PrefillField, string>> = {};

  const set = (key: Cp12PrefillField, value: string | undefined) => {
    if (value !== undefined) fields[key] = value;
  };

  // -- The property ---------------------------------------------------------
  /*
    Who is *at* the property, not who pays for the work. On a tenanted job
    that is the tenant; on private work the customer is the occupier.
  */
  set("jobName", clean(facts.tenancy?.name) ?? clean(facts.customer.name));
  set("jobTel", clean(facts.tenancy?.phone) ?? clean(facts.customer.phone));
  set(
    "jobAddress",
    lines(facts.property.houseOrName, facts.property.street, facts.property.town),
  );
  set("jobPostcode", clean(facts.property.postcode));

  /*
    -- The customer or landlord ---------------------------------------------

    This block is the sheet's "Customer / Landlord" section, and it carries
    **the party the certificate is issued to** — nothing else.

    A job that arrived through a letting agency is still a job for that
    agency's *landlord client*, and the agency's own trading details are not
    that party's. An earlier version filled the company line from the
    agency's name when the customer had none, and the postcode line from the
    agency's **billing** postcode — a finance address, not a property or a
    correspondence one. Both were wrong in the same way: they answered "who
    sent us this work" on a line that asks "who is this certificate for".
    A certificate naming the wrong party is a certificate that has to be
    reissued.

    So only the recorded customer is used, and the fields we do not hold are
    left blank and reported — see `CP12_UNAVAILABLE_FIELDS`. A blank line an
    engineer fills in is right; a filled line nobody checked is not.
  */
  set("landlordName", clean(facts.customer.name));
  set("landlordCompany", clean(facts.customer.company));
  set("landlordTel", clean(facts.customer.phone));

  // -- Who is carrying it out -----------------------------------------------
  set("instEngineer", clean(facts.engineerName));
  set("instCompany", clean(facts.business.displayName));
  set("instAddress", lines(...facts.business.addressLines));
  set("instPostcode", clean(facts.business.postcode));
  set("instTel", clean(facts.business.phone));
  set("instGasSafeReg", clean(facts.business.gasSafeNumber));

  return fields;
}

/**
 * What the engineer still has to type, given what was found.
 *
 * The four permanent gaps, plus any installer field the business settings
 * have not supplied. Reported rather than left blank and unexplained.
 */
export type Cp12MissingField = { id: string; label: string; reason: string };

export function cp12MissingFields(
  fields: Partial<Record<Cp12PrefillField, string>>,
): Cp12MissingField[] {
  const missing: Cp12MissingField[] = CP12_UNAVAILABLE_FIELDS.map((f) => ({
    ...f,
  }));

  const installer: [Cp12PrefillField, string][] = [
    ["instCompany", "Company name"],
    ["instAddress", "Company address"],
    ["instPostcode", "Company postcode"],
    ["instTel", "Company telephone"],
    ["instGasSafeReg", "Gas Safe registration"],
  ];
  for (const [id, label] of installer) {
    if (fields[id] === undefined) {
      missing.push({
        id,
        label,
        reason: "The business details have not been set up yet.",
      });
    }
  }

  if (fields.instEngineer === undefined) {
    missing.push({
      id: "instEngineer",
      label: "Engineer name",
      reason: "No engineer is allocated to this job.",
    });
  }

  return missing;
}

/** A short, human label for the confirmation prompt before an import. */
export function cp12PropertyLabel(facts: Cp12PrefillFacts): string {
  const where = [facts.property.houseOrName, facts.property.street]
    .map(clean)
    .filter((p): p is string => p !== undefined)
    .join(", ");
  const postcode = clean(facts.property.postcode);
  return [where, postcode].filter(Boolean).join(" · ") || facts.reference;
}

/** The whole payload, ready to be serialised. */
export function buildCp12Payload(
  facts: Cp12PrefillFacts,
  now: Date,
): Cp12PrefillPayload {
  const fields = buildCp12Fields(facts);
  return {
    kind: CP12_PAYLOAD_KIND,
    version: CP12_PAYLOAD_VERSION,
    reference: facts.reference,
    propertyLabel: cp12PropertyLabel(facts),
    generatedAt: now.toISOString(),
    fields,
    missing: cp12MissingFields(fields),
  };
}

/**
 * A filename that says what it is without carrying anything private.
 *
 * The reference is an opaque label, not an authorisation and not personal
 * data. No name, no address and no postcode goes in a filename that will sit
 * in somebody's downloads folder and be visible to anything that indexes it.
 */
export function cp12PrefillFilename(reference: string): string {
  const safe = reference.replace(/[^A-Za-z0-9-]/g, "") || "job";
  return `${safe}-cp12-details.json`;
}
