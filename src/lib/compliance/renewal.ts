/**
 * When the next inspection is due.
 *
 * **The rule, confirmed by BSCJ on 16 September 2026:**
 *
 *     next due date = inspection date + 12 months − 1 day
 *
 * This is the behaviour BSCJ's existing CP12 generator already has, recorded
 * here as the single place it is expressed. Nothing else in the application
 * may do date arithmetic to work out a renewal: a second implementation is how
 * a certificate and a reminder end up disagreeing by a day, and a day matters
 * when the question is whether a property was legally certificated.
 *
 * Everything here works on plain `YYYY-MM-DD` strings, matching the `date`
 * columns in the schema. Deliberately not `Date`: a renewal has no time of
 * day, and running it through a timestamp is how it drifts across a timezone
 * boundary and lands a day out.
 *
 * Pure and dependency-free.
 */

/** The interval, in months. One place, so it is configurable by editing one line. */
export const RENEWAL_INTERVAL_MONTHS = 12;

/**
 * The day subtracted at the end.
 *
 * A certificate dated 1 March is valid up to and including the last day before
 * the same date next year — so the next one is due on 28 February, not 1 March.
 */
const RENEWAL_TRAILING_DAYS = 1;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type CalendarDate = { year: number; month: number; day: number };

/** Days in a month, Gregorian, with the leap rule spelled out. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Parses a `YYYY-MM-DD` string, rejecting anything that is not a real date.
 *
 * `2027-02-30` is a string that looks like a date and is not one. Returning
 * null rather than silently rolling it into March is the difference between a
 * caught mistake and a wrong renewal date.
 */
export function parseCalendarDate(value: string): CalendarDate | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  return { year, month, day };
}

export function formatCalendarDate(date: CalendarDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

/**
 * Adds whole months, clamping to the end of the target month.
 *
 * 31 January plus one month is 28 (or 29) February, not 3 March. Rolling over
 * is what `Date.setMonth` does and it is wrong for this: an inspection on the
 * last day of a month should renew on the last day of a month.
 */
export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const zeroBased = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

/** The day before. Steps back across a month and a year boundary correctly. */
export function subtractDays(date: CalendarDate, days: number): CalendarDate {
  let { year, month, day } = date;
  let remaining = days;

  while (remaining > 0) {
    if (day > remaining) {
      day -= remaining;
      remaining = 0;
    } else {
      remaining -= day;
      month -= 1;
      if (month === 0) {
        month = 12;
        year -= 1;
      }
      day = daysInMonth(year, month);
    }
  }

  return { year, month, day };
}

/**
 * The next due date for an inspection carried out on `inspectionDate`.
 *
 * Returns null when the input is not a real calendar date, so a bad value
 * surfaces at the call site rather than becoming a plausible-looking wrong
 * date in a row.
 */
export function nextDueDate(inspectionDate: string): string | null {
  const parsed = parseCalendarDate(inspectionDate);
  if (!parsed) return null;

  const anniversary = addMonths(parsed, RENEWAL_INTERVAL_MONTHS);
  return formatCalendarDate(subtractDays(anniversary, RENEWAL_TRAILING_DAYS));
}

/**
 * The same rule, for a caller that cannot proceed without an answer.
 *
 * Used where the inspection date has already been validated — writing a
 * certificate, for instance — and a null would only be turned into a throw
 * one line later.
 */
export function requireNextDueDate(inspectionDate: string): string {
  const due = nextDueDate(inspectionDate);
  if (!due) {
    throw new RangeError(`Not a calendar date: ${inspectionDate}`);
  }
  return due;
}

// ---------------------------------------------------------------------------
// Deadline risk
// ---------------------------------------------------------------------------

/**
 * How close a deadline is.
 *
 * **Computed, never stored.** A stored copy is a second source of truth that
 * goes stale the moment a date passes — a job could sit in the database
 * marked `normal` for a week after it went overdue.
 *
 * Orthogonal to the lifecycle: a job can be overdue *and* scheduled *and*
 * invoiced at once.
 */
export const DEADLINE_RISKS = [
  "normal",
  "approaching",
  "urgent",
  "overdue",
] as const;

export type DeadlineRisk = (typeof DEADLINE_RISKS)[number];

/**
 * The windows, in days before the deadline.
 *
 * Defaults only. Production reads them from `business_setting` so they can be
 * tuned without a deploy — see `lib/settings/business-identity.ts` for the
 * same pattern. They are not a legal position and nothing may present them as
 * one.
 */
export type DeadlineWindows = { approachingDays: number; urgentDays: number };

export const DEFAULT_DEADLINE_WINDOWS: DeadlineWindows = {
  approachingDays: 30,
  urgentDays: 7,
};

/** Whole days from `from` to `to`. Negative when `to` is in the past. */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const toDayNumber = (date: CalendarDate) =>
    Date.UTC(date.year, date.month - 1, date.day) / 86_400_000;
  return toDayNumber(to) - toDayNumber(from);
}

/**
 * Where a deadline sits relative to today.
 *
 * A deadline of today is `urgent`, not `overdue`: there are still hours left
 * in it. It becomes overdue the day after.
 */
export function deadlineRisk(
  dueDate: string,
  today: string,
  windows: DeadlineWindows = DEFAULT_DEADLINE_WINDOWS,
): DeadlineRisk | null {
  const due = parseCalendarDate(dueDate);
  const now = parseCalendarDate(today);
  if (!due || !now) return null;

  const days = daysBetween(now, due);
  if (days < 0) return "overdue";
  if (days <= windows.urgentDays) return "urgent";
  if (days <= windows.approachingDays) return "approaching";
  return "normal";
}
