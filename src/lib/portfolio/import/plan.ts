/**
 * Working out what an import would do, before it does any of it.
 *
 * This is the whole point of the feature. An agent uploading 200 properties
 * has to be able to see, row by row, what will be created, what matched
 * something they already have, what disagrees with what they already have, and
 * what cannot be read — **and then decide**. Nothing is written until they
 * press a second button.
 *
 * Four outcomes per row, and each was a decision:
 *
 * - **`create`** — a new property. Its landlord may be new or may be one the
 *   agency already has, matched by email, which is reused rather than
 *   duplicated.
 * - **`duplicate_in_file`** — the same address appears earlier in this file.
 *   The first occurrence is imported and the rest are reported. Importing both
 *   would produce two records for one property, which the database's unique
 *   index would refuse anyway — reporting it is the honest version.
 * - **`conflict`** — the agency already has this property, and the file says
 *   something different about it. **Nothing is overwritten by default.** Every
 *   difference is listed and the row does nothing unless the agent explicitly
 *   chooses to apply it.
 * - **`unchanged`** — already held, and the file agrees. Nothing to do.
 * - **`error`** — the row could not be read. Named column, named problem.
 *
 * Pure: it takes the file and a snapshot of what exists, and returns a plan.
 * The database reads happen in `lookup.ts` and the writes in `commit.ts`, so
 * every rule about *what an import means* is testable without either.
 */

import { formatParsedDate } from "./dates";
import type { ExistingProperty } from "./lookup";
import { parseImportRow, type ImportRecord, type RowError, type RowValues } from "./rows";

export type RowAction =
  | "create"
  | "duplicate_in_file"
  | "conflict"
  | "unchanged"
  | "error";

/**
 * How an agent chose to resolve a conflict.
 *
 * `skip` is the default and is applied to any row the agent did not answer
 * for. A confirmation that arrives with a resolution missing must not guess
 * "update" — a form that loses a checkbox would then overwrite a tenant.
 */
export type Resolution = "skip" | "update";

/** One difference between the file and what is already held. */
export type Conflict = {
  /** What differs, in the agent's words. */
  field: string;
  /** What the agency currently holds. */
  current: string;
  /** What the file says. */
  incoming: string;
  /**
   * What applying it would actually do, said plainly — because "update" means
   * different things to a tenant and to a phone number, and one of them ends
   * a tenancy.
   */
  effect: string;
  /**
   * Whether an import may apply this at all.
   *
   * Two differences are reported and **never applied**: moving a property to a
   * different landlord, and changing its street. Both are portfolio
   * restructuring rather than record-keeping — the first re-parents a
   * property's billing, certificates and history, and the second changes where
   * an engineer is sent. Each is a deliberate act on the property's own
   * screen, where the person doing it can see everything it affects, and
   * neither is something a spreadsheet should be able to do in bulk.
   *
   * Saying so in the preview is the point: the difference is surfaced, so
   * nothing is silently ignored, and the row says plainly that it needs a
   * person.
   */
  applicable: boolean;
};

export type PlannedRow = {
  /** The line number in the agent's own file. */
  line: number;
  action: RowAction;
  /** Present for every action but `error`. */
  record?: ImportRecord;
  errors?: RowError[];
  /** The address, for the table. Always present, even for an error row. */
  address: string;
  /** For `duplicate_in_file`: the line it duplicates. */
  duplicateOfLine?: number;
  /** For `conflict` and `unchanged`: the property already held. */
  existingPropertyId?: string;
  conflicts?: Conflict[];
  /**
   * Whether *any* of this row's conflicts can be applied by an import.
   *
   * False means the row is reported and can only be left alone — the preview
   * offers no choice, rather than offering one that would silently do nothing.
   */
  conflictsApplicable?: boolean;
  /**
   * The state this row's conflicts were judged against, hashed.
   *
   * Carried through to the envelope and re-checked at write time — see
   * `fingerprintOf`. Absent for a row that is not a conflict, because there is
   * nothing it was judged against.
   */
  observed?: string;
  /** For `create`: whether the landlord is one the agency already has. */
  landlordExisting?: boolean;
  /** Dates, written out long, so a misread ordering is visible. */
  dueDateLong?: string;
  tenancyStartedLong?: string;
};

export type ImportPlan = {
  rows: PlannedRow[];
  counts: Record<RowAction, number>;
  /** How many rows would write something if confirmed as proposed. */
  wouldWrite: number;
};

const EMPTY_COUNTS: Record<RowAction, number> = {
  create: 0,
  duplicate_in_file: 0,
  conflict: 0,
  unchanged: 0,
  error: 0,
};

function addressOf(values: RowValues): string {
  return (
    [values.houseOrName, values.street, values.town, values.postcode]
      .map((part) => (part ?? "").trim())
      .filter(Boolean)
      .join(", ") || "(no address)"
  );
}

/** Blank and null are both "not supplied" and must compare equal. */
function same(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? "").trim().toLowerCase() === (right ?? "").trim().toLowerCase();
}

function shown(value: string | null | undefined): string {
  return (value ?? "").trim() || "—";
}

/**
 * Whether two phone numbers are the same number.
 *
 * Compared on their **national significant digits** rather than as strings.
 * The same landline is stored as `+441902000000` when it came through the
 * booking form's normaliser and as `01902 000000` when it was typed into a
 * spreadsheet, and a plain string comparison would report a conflict on every
 * row of every import — burying the two or three that matter in two hundred
 * that do not.
 *
 * `+44` and a leading `0` are both dropped, which is the whole of the UK rule
 * this needs. An international number simply compares on its own digits, which
 * is correct for the only thing being asked: are these the same?
 */
function samePhone(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const digits = (value: string | null | undefined) => {
    const bare = (value ?? "").replace(/[^\d+]/g, "");
    return bare.replace(/^\+44/, "").replace(/^0/, "");
  };
  return digits(left) === digits(right);
}

/**
 * A fingerprint of everything a conflict was judged against.
 *
 * **This is what stops a stale approval overwriting somebody else's work.**
 *
 * An agent reviews two hundred rows, goes for lunch, and presses Confirm. In
 * between, a colleague changed the tenant on one of those properties. Without
 * this, the approval — which said "replace Nina with Priya" — would be applied
 * to whoever is there *now*, ending a tenancy the agent never saw and never
 * approved ending. That is the defect this exists to close, and it was real:
 * a tenancy for a third person was ended under an approval given for someone
 * else entirely.
 *
 * So the state the conflict was computed from is hashed, carried **inside the
 * signed envelope**, and re-checked against a fresh read at write time. If
 * anything it was judged against has moved, the row is skipped and the agent
 * is told to review it again.
 *
 * It covers exactly the fields `conflictsBetween` reads, normalised the same
 * way — so a difference this would call "changed" is a difference that would
 * have produced a different conflict list, and a cosmetic reformatting of a
 * phone number is not treated as somebody's edit.
 */
export function fingerprintOf(existing: ExistingProperty): string {
  const text = (value: string | null | undefined) =>
    (value ?? "").trim().toLowerCase();
  const phone = (value: string | null | undefined) =>
    (value ?? "").replace(/[^\d+]/g, "").replace(/^\+44/, "").replace(/^0/, "");

  return [
    existing.id,
    existing.landlordId,
    text(existing.landlordEmail),
    text(existing.landlordName),
    text(existing.landlordCompany),
    phone(existing.landlordPhone),
    text(existing.street),
    existing.tenancyId ?? "",
    text(existing.tenantName),
    text(existing.tenantEmail),
    phone(existing.tenantPhone),
    existing.dueDate ?? "",
  ].join("|");
}

/**
 * Everything the file says that the agency's record does not.
 *
 * Grouped so each conflict states its **effect**, not just its difference. An
 * agent ticking "apply" next to a tenant name needs to know that it ends the
 * current tenancy and starts a new one — which is the right behaviour, because
 * overwriting would erase who was actually contacted last year, but it is not
 * what "update" sounds like.
 */
function conflictsBetween(
  record: ImportRecord,
  existing: ExistingProperty,
): Conflict[] {
  const conflicts: Conflict[] = [];

  if (!same(record.landlord.email, existing.landlordEmail)) {
    conflicts.push({
      field: "Landlord",
      current: `${existing.landlordName} (${existing.landlordEmail})`,
      incoming: `${record.landlord.name} (${record.landlord.email})`,
      effect:
        "An import will not move a property to a different landlord — that re-parents its billing, certificates and history. Change it on the property, where you can see what it affects.",
      applicable: false,
    });
  } else if (
    !same(record.landlord.name, existing.landlordName) ||
    !samePhone(record.landlord.phone, existing.landlordPhone) ||
    !same(record.landlord.company, existing.landlordCompany)
  ) {
    conflicts.push({
      field: "Landlord details",
      current: `${existing.landlordName}, ${shown(existing.landlordPhone)}`,
      incoming: `${record.landlord.name}, ${shown(record.landlord.phone)}`,
      effect:
        "Applying updates the landlord's name, company and phone number on their own record — which affects every property they own, not only this one.",
      applicable: true,
    });
  }

  if (!same(record.property.street, existing.street)) {
    conflicts.push({
      field: "Street",
      current: existing.street,
      incoming: record.property.street,
      effect:
        "An import will not change where an engineer is sent. If the address is wrong, correct it on the property.",
      applicable: false,
    });
  }

  const incomingTenant = record.tenancy;
  const hasIncomingTenant = Boolean(
    incomingTenant?.name || incomingTenant?.email || incomingTenant?.phone,
  );
  const hasCurrentTenant = Boolean(
    existing.tenantName || existing.tenantEmail || existing.tenantPhone,
  );

  if (hasIncomingTenant && hasCurrentTenant) {
    const differs =
      !same(incomingTenant?.name, existing.tenantName) ||
      !same(incomingTenant?.email, existing.tenantEmail) ||
      !samePhone(incomingTenant?.phone, existing.tenantPhone);
    if (differs) {
      conflicts.push({
        field: "Tenant",
        current: `${shown(existing.tenantName)}, ${shown(existing.tenantEmail)}`,
        incoming: `${shown(incomingTenant?.name)}, ${shown(incomingTenant?.email)}`,
        effect:
          "Applying ends the current tenancy today and records a new one. The old tenancy is kept, so last year's jobs still say who was actually contacted.",
        applicable: true,
      });
    }
  } else if (hasIncomingTenant && !hasCurrentTenant) {
    conflicts.push({
      field: "Tenant",
      current: "None recorded",
      incoming: `${shown(incomingTenant?.name)}, ${shown(incomingTenant?.email)}`,
      effect: "Applying records a tenancy on a property currently held as empty.",
      applicable: true,
    });
  }
  /*
    A blank tenant column is deliberately **not** a conflict. It means "this
    spreadsheet does not say", not "this property is empty" — and reading an
    omission as an instruction to end somebody's tenancy is exactly the kind of
    silent destruction this whole review step exists to prevent.
  */

  const incomingDue = record.compliance?.dueDate ?? null;
  if (incomingDue && !same(incomingDue, existing.dueDate)) {
    conflicts.push({
      field: "Certificate expiry",
      current: existing.dueDate ? formatParsedDate(existing.dueDate) : "Not known",
      incoming: formatParsedDate(incomingDue),
      effect:
        "Applying supersedes the current compliance position and records this one. The old position is kept, so the property's history stays readable.",
      applicable: true,
    });
  }

  return conflicts;
}

/**
 * Builds the plan.
 *
 * `existing` is a snapshot taken a moment ago, not a lock. Two agents
 * importing at once could both be told "create" for one address — which is why
 * the write path checks again and the database's unique index refuses the
 * loser. The preview is for the person, not for correctness.
 */
export function buildImportPlan(input: {
  rows: { line: number; values: RowValues }[];
  existing: Map<string, ExistingProperty>;
  /** Landlord emails the agency already holds, lower-cased. */
  existingLandlordEmails: Set<string>;
}): ImportPlan {
  const counts = { ...EMPTY_COUNTS };
  const rows: PlannedRow[] = [];
  /** First occurrence of each address key in this file. */
  const seen = new Map<string, number>();

  for (const { line, values } of input.rows) {
    const address = addressOf(values);
    const parsed = parseImportRow(values);

    if (!parsed.ok) {
      counts.error += 1;
      rows.push({ line, action: "error", errors: parsed.errors, address });
      continue;
    }

    const { record } = parsed;
    const dueDateLong = record.compliance
      ? formatParsedDate(record.compliance.dueDate)
      : undefined;
    const tenancyStartedLong = record.tenancy?.startedOn
      ? formatParsedDate(record.tenancy.startedOn)
      : undefined;

    const firstSeenAt = seen.get(record.key);
    if (firstSeenAt !== undefined) {
      counts.duplicate_in_file += 1;
      rows.push({
        line,
        action: "duplicate_in_file",
        record,
        address,
        duplicateOfLine: firstSeenAt,
        dueDateLong,
        tenancyStartedLong,
      });
      continue;
    }
    seen.set(record.key, line);

    const existing = input.existing.get(record.key);
    if (!existing) {
      counts.create += 1;
      rows.push({
        line,
        action: "create",
        record,
        address,
        landlordExisting: input.existingLandlordEmails.has(
          record.landlord.email.toLowerCase(),
        ),
        dueDateLong,
        tenancyStartedLong,
      });
      continue;
    }

    const conflicts = conflictsBetween(record, existing);
    if (conflicts.length === 0) {
      counts.unchanged += 1;
      rows.push({
        line,
        action: "unchanged",
        record,
        address,
        existingPropertyId: existing.id,
        dueDateLong,
        tenancyStartedLong,
      });
      continue;
    }

    counts.conflict += 1;
    rows.push({
      line,
      action: "conflict",
      record,
      address,
      existingPropertyId: existing.id,
      conflicts,
      conflictsApplicable: conflicts.some((conflict) => conflict.applicable),
      observed: fingerprintOf(existing),
      dueDateLong,
      tenancyStartedLong,
    });
  }

  /*
    What would be written **as proposed**, which is creations only. Every
    conflict defaults to `skip`, so the headline number never includes a change
    the agent has not explicitly asked for.
  */
  return { rows, counts, wouldWrite: counts.create };
}
