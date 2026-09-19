/**
 * Minimal timezone helpers built on Intl, so no date library is shipped.
 *
 * Europe/London switches between GMT and BST, so a London wall-clock time
 * cannot be turned into an instant with simple arithmetic — the offset has to
 * be resolved for that particular moment.
 */

export type DateParts = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
};

const partsFormatter = (timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });

const weekdayIndex: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Wall-clock parts of an instant, as seen in the given timezone. */
export function getPartsInZone(
  instant: Date,
  timeZone: string,
): DateParts & { weekday: number; second: number } {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: weekdayIndex[get("weekday")] ?? 0,
  };
}

/** Offset of a timezone from UTC, in minutes, at a given instant. */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const p = getPartsInZone(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - instant.getTime()) / 60000;
}

/**
 * Converts a wall-clock time in `timeZone` to the matching UTC instant.
 *
 * Resolved twice because the offset itself depends on the instant — the first
 * pass gets close enough to pick the correct side of a DST boundary.
 */
export function zonedTimeToUtc(parts: DateParts, timeZone: string): Date {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  const firstGuess = new Date(naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60000);
  const corrected = new Date(
    naive - zoneOffsetMinutes(firstGuess, timeZone) * 60000,
  );
  return corrected;
}

/** "2026-08-19" for the given instant, in the given timezone. */
export function isoDateInZone(instant: Date, timeZone: string): string {
  const p = getPartsInZone(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Parses "2026-08-19" into its numeric parts. Returns null if malformed. */
export function parseIsoDate(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** "14:00" for the given instant, in the given timezone. */
export function timeLabelInZone(instant: Date, timeZone: string): string {
  const p = getPartsInZone(instant, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "Thursday 20 August 2026" for a plain ISO date, without timezone drift. */
export function formatLongDate(isoDate: string, timeZone: string): string {
  const parsed = parseIsoDate(isoDate);
  if (!parsed) return isoDate;
  const noon = zonedTimeToUtc({ ...parsed, hour: 12, minute: 0 }, timeZone);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(noon);
}

/**
 * The instants a local calendar date begins and ends at.
 *
 * `start` is inclusive, `end` exclusive — the moment the next day begins —
 * so a range query needs no fencepost arithmetic and cannot lose an
 * appointment at midnight. Built from the wall clock rather than from
 * 24-hour arithmetic, so the two days a year that are 23 or 25 hours long
 * come out right.
 */
export function dayBoundsInZone(
  isoDate: string,
  timeZone: string,
): { start: Date; end: Date } | null {
  const parsed = parseIsoDate(isoDate);
  if (!parsed) return null;

  const start = zonedTimeToUtc({ ...parsed, hour: 0, minute: 0 }, timeZone);
  /*
    `parseIsoDate` checks the shape, not the calendar: "2026-02-30" passes it
    and rolls into March. A day boundary that quietly moves to another month
    is worse than no answer, so the result is required to round-trip back to
    the date it was asked for.
  */
  if (isoDateInZone(start, timeZone) !== isoDate) return null;

  /*
    Midday on the same date, plus a day, then back to midnight. Stepping from
    noon keeps the intermediate instant clear of both DST transitions, which
    happen in the small hours.
  */
  const nextNoon = new Date(
    zonedTimeToUtc({ ...parsed, hour: 12, minute: 0 }, timeZone).getTime() +
      24 * 60 * 60 * 1000,
  );
  const next = getPartsInZone(nextNoon, timeZone);
  const end = zonedTimeToUtc(
    { year: next.year, month: next.month, day: next.day, hour: 0, minute: 0 },
    timeZone,
  );

  return { start, end };
}
