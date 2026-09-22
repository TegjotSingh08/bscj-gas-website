/**
 * Every field a connected certificate draft may carry, and nothing else.
 *
 * **Why an allow-list rather than "whatever the generator sends".** The draft
 * endpoint accepts a JSON object from a browser and stores it. Without a
 * closed list that is an authenticated arbitrary-blob store attached to a
 * job: somebody could park megabytes of anything in it, and a later reader
 * of `fields` could be handed a key it never expected. So the server decides
 * what a certificate draft consists of, the generator's own element ids are
 * that list, and anything else is dropped on the way in.
 *
 * It mirrors the ids inside `#sheet` in `vendor/cp12-generator/index.html` —
 * the same elements the generator's `saveDraft()` walks — so a draft needs no
 * translation in either direction. `certificate-draft-fields.test.ts` reads
 * the generator's markup and asserts the two agree, which is what stops this
 * drifting when a field is added to the sheet.
 *
 * Pure, dependency-free and importable from anywhere: the route, the store
 * and the tests all decide "is this a draft field?" from one place.
 */

/** The static boxes on the sheet, in the order they appear on it. */
export const CERTIFICATE_DRAFT_STATIC_FIELDS = [
  // The record itself
  "certNo",
  // Who carried it out
  "instEngineer",
  "instCompany",
  "instAddress",
  "instPostcode",
  "instTel",
  "instGasSafeReg",
  "instIdCard",
  // The property inspected
  "jobName",
  "jobAddress",
  "jobPostcode",
  "jobTel",
  // Who it is issued to
  "landlordSelect2",
  "landlordName",
  "landlordCompany",
  "landlordAddress",
  "landlordPostcode",
  "landlordTel",
  // Findings
  "defects",
  "labelsIssued",
  "coFitted",
  "coTested",
  "chkEmergency",
  "chkTightness",
  "chkPipework",
  "chkBonding",
  "nextInspection",
  "comments",
  // Signatures
  "issuedPrintName",
  "receivedPrintName",
  "sigDate",
] as const;

/** The appliance table: six rows, each with these columns. */
export const CERTIFICATE_DRAFT_APPLIANCE_ROWS = 6;

export const CERTIFICATE_DRAFT_APPLIANCE_COLUMNS = [
  "location",
  "type",
  "make",
  "model",
  "flueType",
  "landlordsAppliance",
  "inspected",
  "operatingPressure",
  "heatInput",
  "highRatio",
  "highCO",
  "highCO2",
  "lowRatio",
  "lowCO",
  "lowCO2",
  "safetyDevice",
  "ventilation",
  "visualFlue",
  "fluePerformance",
  "serviced",
  "safeToUse",
] as const;

/**
 * The six safety outcomes.
 *
 * Named here as well as in the generator because the **server** refuses a
 * submission that leaves one unassessed. A browser-side check is a courtesy;
 * this is the one that decides.
 */
export const CERTIFICATE_OUTCOME_FIELDS = [
  "coFitted",
  "coTested",
  "chkEmergency",
  "chkTightness",
  "chkPipework",
  "chkBonding",
] as const;

/** Every acceptable key, built once. */
export const CERTIFICATE_DRAFT_FIELDS: readonly string[] = [
  ...CERTIFICATE_DRAFT_STATIC_FIELDS,
  ...Array.from({ length: CERTIFICATE_DRAFT_APPLIANCE_ROWS }, (_, index) =>
    CERTIFICATE_DRAFT_APPLIANCE_COLUMNS.map(
      (column) => `app_${index + 1}_${column}`,
    ),
  ).flat(),
];

const ALLOWED = new Set(CERTIFICATE_DRAFT_FIELDS);

/**
 * The longest a single field may be.
 *
 * Generous for a comments box and nowhere near enough to be useful as
 * storage. A value over it is truncated rather than refused: an engineer who
 * has typed a long note should not lose the save, and nothing on a
 * certificate needs more than this.
 */
export const CERTIFICATE_DRAFT_MAX_FIELD_LENGTH = 4_000;

export type CertificateDraftFields = Record<string, string>;

/**
 * Whatever the client sent, reduced to a draft.
 *
 * Unknown keys are dropped, non-strings are dropped, and every value is
 * length-capped. The result is safe to store and safe for any later reader to
 * assume the shape of.
 */
export function sanitiseDraftFields(input: unknown): CertificateDraftFields {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {};
  }

  const fields: CertificateDraftFields = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!ALLOWED.has(key)) continue;
    if (typeof value !== "string") continue;
    fields[key] = value.slice(0, CERTIFICATE_DRAFT_MAX_FIELD_LENGTH);
  }
  return fields;
}

/**
 * Which safety outcomes are still unassessed.
 *
 * An empty array means every one of the six has an answer. It does **not**
 * mean they are satisfactory — what the answer should be is the engineer's
 * judgement, and nothing here has an opinion about it.
 */
export function unassessedOutcomes(
  fields: CertificateDraftFields,
): readonly string[] {
  return CERTIFICATE_OUTCOME_FIELDS.filter(
    (id) => (fields[id] ?? "").trim() === "",
  );
}

/**
 * Whether a draft has enough on it to be submitted, and what is missing.
 *
 * Deliberately narrow. It asks for the things a gas safety record is not a
 * record without — who inspected it, what was inspected, when, its number,
 * at least one appliance row, and an answer to each of the six checks. It
 * does **not** invent a criterion for what a good reading is, and it does not
 * require a field the application could not supply and the engineer may
 * legitimately leave blank.
 */
export function describeIncompleteDraft(
  fields: CertificateDraftFields,
): readonly string[] {
  const missing: string[] = [];
  const has = (id: string) => (fields[id] ?? "").trim() !== "";

  if (!has("certNo")) missing.push("Certificate number");
  if (!has("instEngineer")) missing.push("Engineer name");
  if (!has("jobAddress")) missing.push("Property address");
  if (!has("sigDate")) missing.push("Inspection date");
  if (!has("issuedPrintName")) missing.push("Issued by (print name)");

  const anyAppliance = Array.from(
    { length: CERTIFICATE_DRAFT_APPLIANCE_ROWS },
    (_, index) => `app_${index + 1}_`,
  ).some((prefix) =>
    CERTIFICATE_DRAFT_APPLIANCE_COLUMNS.some((column) =>
      has(`${prefix}${column}`),
    ),
  );
  if (!anyAppliance) missing.push("At least one appliance row");

  for (const id of unassessedOutcomes(fields)) {
    missing.push(`Safety outcome: ${OUTCOME_LABELS[id] ?? id}`);
  }

  return missing;
}

/** What each outcome is called on the sheet, for a message a person reads. */
const OUTCOME_LABELS: Record<string, string> = {
  coFitted: "CO alarm(s) fitted",
  coTested: "CO alarm(s) tested and satisfactory",
  chkEmergency: "Emergency control accessible",
  chkTightness: "Gas tightness satisfactory",
  chkPipework: "Gas installation pipework visual inspection",
  chkBonding: "Equipotential bonding",
};
