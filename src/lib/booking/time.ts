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
