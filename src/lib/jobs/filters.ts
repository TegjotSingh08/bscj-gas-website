/**
 * What the admin job list is being asked for.
 *
 * A URL is untrusted input like any other, and this is the only place it is
 * turned into something a query may use. Every field is validated against a
 * closed set or clamped to a range, so a hand-edited query string can narrow
 * the list, ask for page four hundred or ask for nothing at all — but it can
 * never widen the caller's access, change a sort into an injection, or make
 * the page ask Postgres for fifty thousand rows.
 *
 * **It cannot widen access on purpose.** There is no organisation field here
 * and there never will be one: which rows a caller may see is decided by
 * `AccessScope`, built from the session. `client` below distinguishes BSCJ's
 * own consumer work from agency work *within* what the caller already
 * reaches; for an agency user it can only ever narrow their own rows to
 * nothing, which is harmless, rather than reveal somebody else's.
 *
 * Pure and dependency-free.
 */

import { JOB_LIFECYCLE_STATUSES, type JobLifecycleStatus } from "./lifecycle";

/**
 * Who commissioned the work.
 *
 * The distinction BSCJ actually runs the business on. A £45 website booking
 * from a homeowner and a portfolio agency's twelfth property this month are
 * different work with different people to chase, and a list that mixes them
 * without saying which is which is a list that gets read wrong.
 */
export const CLIENT_KINDS = ["all", "private", "agency"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/**
 * A named slice of the list, rather than one lifecycle status.
 *
 * Statuses answer "where has this got to". These answer the questions
 * somebody actually opens the page with, and the two are deliberately
 * separate controls: "today" is true of jobs in four different statuses.
 */
export const JOB_VIEWS = [
  /** Everything the caller can see. */
  "all",
  /** Not finished and not called off — the work still in front of BSCJ. */
  "open",
  /** An appointment today, in the business timezone. */
  "today",
  /** An appointment at some point after now. */
  "upcoming",
  /** Scheduled, with nobody allocated to it yet. */
  "unassigned",
  /** Something is wrong or waiting on a person. See `attention.ts`. */
  "attention",
  /** Finished, either way. */
  "closed",
] as const;
export type JobView = (typeof JOB_VIEWS)[number];

export const PAGE_SIZE = 25;
/** A page nobody asked for is a query nobody needed. */
export const MAX_PAGE_SIZE = 100;

/**
 * The engineer filter.
 *
 * Three answers, not two: "anybody", "nobody yet", and one particular
 * engineer. Folding the middle one into an empty string is how "unassigned"
 * quietly becomes "all".
 */
export const ENGINEER_ANY = "any";
export const ENGINEER_NONE = "none";

export type JobFilters = {
  /** Free text, trimmed and length-capped. Never a pattern. */
  query: string;
  view: JobView;
  client: ClientKind;
  /** A lifecycle status, or null for "any status". */
  status: JobLifecycleStatus | null;
  /** `ENGINEER_ANY`, `ENGINEER_NONE`, or an engineer's id. */
  engineer: string;
  /** One-based. */
  page: number;
  pageSize: number;
};

export const DEFAULT_FILTERS: JobFilters = {
  query: "",
  view: "all",
  client: "all",
  status: null,
  engineer: ENGINEER_ANY,
  page: 1,
  pageSize: PAGE_SIZE,
};

/** Long enough for a full address line, short enough not to be a payload. */
const MAX_QUERY_LENGTH = 80;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What Next hands a page as `searchParams`, and nothing more. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

function one(raw: RawSearchParams, key: string): string {
  const value = raw[key];
  // A repeated parameter is somebody experimenting. Take the first and move on.
  const found = Array.isArray(value) ? value[0] : value;
  return typeof found === "string" ? found : "";
}

function member<T extends string>(
  value: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Turns a query string into filters.
 *
 * Never throws and never returns something a query cannot use. Anything
 * unrecognised falls back to the default for that field rather than failing
 * the request: a mistyped status should show the unfiltered list, not a 500.
 */
export function parseJobFilters(raw: RawSearchParams): JobFilters {
  const page = Number.parseInt(one(raw, "page"), 10);
  const pageSize = Number.parseInt(one(raw, "size"), 10);

  const engineerRaw = one(raw, "engineer");
  const engineer =
    engineerRaw === ENGINEER_NONE || UUID.test(engineerRaw)
      ? engineerRaw
      : ENGINEER_ANY;

  const statusRaw = one(raw, "status");
  const status = (JOB_LIFECYCLE_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as JobLifecycleStatus)
    : null;

  return {
    // Collapsed whitespace, so "WV1   1AA" and "WV1 1AA" are one search.
    query: one(raw, "q").trim().replace(/\s+/g, " ").slice(0, MAX_QUERY_LENGTH),
    view: member(one(raw, "view"), JOB_VIEWS, "all"),
    client: member(one(raw, "client"), CLIENT_KINDS, "all"),
    status,
    engineer,
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 10_000) : 1,
    pageSize:
      Number.isFinite(pageSize) && pageSize > 0
        ? Math.min(pageSize, MAX_PAGE_SIZE)
        : PAGE_SIZE,
  };
}

/**
 * Filters back to a query string, for a link.
 *
 * Only what differs from the default is written, so an unfiltered list has a
 * clean URL and a shared link says exactly what was being looked at.
 */
export function jobFiltersToQuery(
  filters: JobFilters,
  overrides: Partial<JobFilters> = {},
): string {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();

  if (merged.query) params.set("q", merged.query);
  if (merged.view !== "all") params.set("view", merged.view);
  if (merged.client !== "all") params.set("client", merged.client);
  if (merged.status) params.set("status", merged.status);
  if (merged.engineer !== ENGINEER_ANY) params.set("engineer", merged.engineer);
  if (merged.pageSize !== PAGE_SIZE) params.set("size", String(merged.pageSize));
  /*
    Page last, and only when it is not the first.

    Every other control resets it — changing the filter and keeping page four
    is how a list shows nothing and looks broken. Callers pass `page: 1` in
    their overrides; this just keeps the URL honest about it.
  */
  if (merged.page > 1) params.set("page", String(merged.page));

  const query = params.toString();
  return query ? `?${query}` : "";
}

/** A path with these filters on it. Used for every control on the page. */
export function jobListHref(
  filters: JobFilters,
  overrides: Partial<JobFilters> = {},
  base = "/admin/jobs",
): string {
  // Anything that changes what is being looked at goes back to page one
  // unless the caller is explicitly paging.
  const resetPage = overrides.page === undefined ? { page: 1 } : {};
  return `${base}${jobFiltersToQuery(filters, { ...overrides, ...resetPage })}`;
}

/** Whether anything at all has been narrowed. */
export function isFiltered(filters: JobFilters): boolean {
  return (
    filters.query !== "" ||
    filters.view !== "all" ||
    filters.client !== "all" ||
    filters.status !== null ||
    filters.engineer !== ENGINEER_ANY
  );
}

/**
 * How many pages the result spans.
 *
 * Always at least one: a list with nothing in it is still page one of one,
 * and reporting "page 1 of 0" is the kind of thing that makes people distrust
 * the rest of the screen.
 */
export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * The page actually shown, once the total is known.
 *
 * Asking for page nine of a three-page list gives page three rather than an
 * empty screen — the row count can change between the link being made and the
 * page being opened, and an empty list is indistinguishable from a broken one.
 */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, page), pageCount(total, pageSize));
}

/** Rows `from`–`to` of `total`, one-based and inclusive, for the footer. */
export function pageRange(
  page: number,
  pageSize: number,
  total: number,
): { from: number; to: number } {
  if (total === 0) return { from: 0, to: 0 };
  const from = (page - 1) * pageSize + 1;
  return { from, to: Math.min(page * pageSize, total) };
}

/**
 * The text search, escaped for `LIKE`.
 *
 * Drizzle parameterises the value, so this is not about injection — it is
 * about a customer whose name contains a `%` matching every row in the table.
 * The wildcards this function adds are the only ones in the pattern.
 */
export function likePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}
