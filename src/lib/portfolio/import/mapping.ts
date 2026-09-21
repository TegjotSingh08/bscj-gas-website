/**
 * Which column in *this agency's* export means what.
 *
 * An agency exports from its own system with its own headings, and renaming
 * fifteen columns by hand before every upload is the effort this removes.
 * A mapping is recorded once, reused on every later import, and always shown
 * before anything is written.
 *
 * **One mechanism for every agency — no per-agency code.** A mapping is data:
 * a record of column key to the heading that carries it. Nothing here knows
 * the name of any particular agency, and adding one is a row, not a release.
 *
 * Pure. The storage lives in `mapping-store.ts`.
 */

import { COLUMNS, columnFor, normaliseHeader, type ColumnKey } from "./columns";

/** Column key → the heading in this agency's file that carries it. */
export type ColumnMapping = Partial<Record<ColumnKey, string>>;

export type SavedMapping = {
  /** Bumped if the shape ever changes, so an old row is recognised not misread. */
  version: 1;
  columns: ColumnMapping;
  /** ISO instant. Presentation only. */
  updatedAt: string;
};

export const MAPPING_VERSION = 1 as const;

/**
 * Reads a stored mapping back, or returns null.
 *
 * Defensive because the value comes from a jsonb column: anything unexpected
 * is treated as "no mapping" rather than trusted into the import path. A
 * heading that no longer corresponds to a real column is dropped — the column
 * set is code, the mapping is data, and data does not get to invent columns.
 */
export function parseSavedMapping(value: unknown): SavedMapping | null {
  if (typeof value !== "object" || value === null) return null;

  const raw = value as Record<string, unknown>;
  if (raw.version !== MAPPING_VERSION) return null;
  if (typeof raw.columns !== "object" || raw.columns === null) return null;

  const known = new Set<string>(COLUMNS.map((column) => column.key));
  const columns: ColumnMapping = {};

  for (const [key, heading] of Object.entries(raw.columns as Record<string, unknown>)) {
    if (!known.has(key)) continue;
    if (typeof heading !== "string") continue;
    const trimmed = heading.trim();
    if (trimmed) columns[key as ColumnKey] = trimmed;
  }

  return {
    version: MAPPING_VERSION,
    columns,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

/** How a column in the file came to be understood. */
export type Resolution =
  /** The heading matched a template column or a known alias. */
  | "template"
  /** This agency's saved mapping said so. */
  | "saved"
  /** The agent chose it on this upload. */
  | "chosen"
  /** Nothing claims it; it will be ignored. */
  | "unmapped";

export type ResolvedColumn = {
  /** The heading exactly as it appears in the file. */
  header: string;
  /** Its position, so a duplicate heading is still addressable. */
  index: number;
  key: ColumnKey | null;
  via: Resolution;
};

export type ResolvedHeaders = {
  columns: ResolvedColumn[];
  /** Column key → the index that supplies it. */
  byKey: Partial<Record<ColumnKey, number>>;
  /** Headings nothing claims. Reported, never silently dropped. */
  unmapped: string[];
  /** Keys claimed by more than one heading. A file fault, not a choice. */
  duplicated: ColumnKey[];
};

/**
 * Works out what each heading in the file means.
 *
 * Precedence, and each step is deliberate:
 *
 * 1. **What the agent chose on this upload** — the most recent human decision
 *    wins over anything remembered or inferred.
 * 2. **This agency's saved mapping** — what they told us last time.
 * 3. **The template and its aliases** — the built-in understanding.
 *
 * Saved beats template on purpose: an agency whose export happens to use the
 * word `notes` for something other than access notes has said so once, and
 * must not be silently overridden by a built-in alias on the next upload.
 */
export function resolveHeaders(input: {
  headers: readonly string[];
  saved?: ColumnMapping;
  chosen?: ColumnMapping;
}): ResolvedHeaders {
  const saved = invert(input.saved);
  const chosen = invert(input.chosen);

  const columns: ResolvedColumn[] = [];
  const byKey: Partial<Record<ColumnKey, number>> = {};
  const unmapped: string[] = [];
  const claimedBy = new Map<ColumnKey, number>();
  const duplicated = new Set<ColumnKey>();

  input.headers.forEach((header, index) => {
    const trimmed = header.trim();
    const normalised = normaliseHeader(trimmed);

    let key: ColumnKey | null = null;
    let via: Resolution = "unmapped";

    if (chosen.has(normalised)) {
      key = chosen.get(normalised)!;
      via = "chosen";
    } else if (saved.has(normalised)) {
      key = saved.get(normalised)!;
      via = "saved";
    } else {
      const column = columnFor(trimmed);
      if (column) {
        key = column.key;
        via = "template";
      }
    }

    columns.push({ header: trimmed, index, key, via });

    if (!key) {
      if (trimmed) unmapped.push(trimmed);
      return;
    }

    /*
      First heading wins a key, and a second is reported rather than silently
      overwriting. Two columns claiming `postcode` is a fault in the file or
      the mapping, and picking one at random would be the worst answer.
    */
    if (claimedBy.has(key)) {
      duplicated.add(key);
      return;
    }
    claimedBy.set(key, index);
    byKey[key] = index;
  });

  return { columns, byKey, unmapped, duplicated: [...duplicated] };
}

/** Every key the column set actually defines. */
const KNOWN_KEYS = new Set<string>(COLUMNS.map((column) => column.key));

/**
 * Heading (normalised) → column key, for the precedence lookup above.
 *
 * **A key the column set does not define is dropped.** `parseSavedMapping`
 * already filters what comes out of the database, but this function is also
 * reachable with a mapping assembled elsewhere, and the column set is code:
 * data does not get to invent a column. Without this a stale mapping naming a
 * column that has since been removed would resolve a heading to a key nothing
 * downstream understands.
 */
function invert(mapping: ColumnMapping | undefined): Map<string, ColumnKey> {
  const out = new Map<string, ColumnKey>();
  if (!mapping) return out;
  for (const [key, header] of Object.entries(mapping)) {
    if (!KNOWN_KEYS.has(key)) continue;
    if (typeof header !== "string" || !header.trim()) continue;
    out.set(normaliseHeader(header), key as ColumnKey);
  }
  return out;
}

/**
 * The mapping worth remembering, from what a resolution actually used.
 *
 * Only headings the file really carried are saved, and `template` matches are
 * saved too: a heading that matches today by alias should keep meaning the same
 * thing tomorrow even if the alias list changes underneath it.
 */
export function mappingFrom(resolved: ResolvedHeaders): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const column of resolved.columns) {
    if (!column.key) continue;
    if (mapping[column.key]) continue;
    mapping[column.key] = column.header;
  }
  return mapping;
}

/**
 * Whether two mappings agree, so a save is skipped when nothing changed.
 *
 * Avoids rewriting the row — and moving its timestamp — on every upload that
 * simply used what was already there.
 */
export function sameMapping(a: ColumnMapping, b: ColumnMapping): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key as ColumnKey];
    const right = b[key as ColumnKey];
    if (normaliseHeader(left ?? "") !== normaliseHeader(right ?? "")) return false;
  }
  return true;
}

/**
 * The column keys an agent may assign a heading to, for the preview's picker.
 *
 * Every column, plus the combined address, because that is the one an agency
 * export most often has and the template does not.
 */
export function assignableColumns(): readonly { key: ColumnKey; label: string }[] {
  return COLUMNS.map((column) => ({
    key: column.key,
    label: `${column.header}${column.required ? " (required)" : ""}`,
  }));
}
