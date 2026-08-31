/**
 * Which month the date picker opens on.
 *
 * Pulled out of the component and made pure because the bug it replaces was a
 * timezone mistake, not a rendering one, and a React component in this
 * repository cannot be tested — Node's type stripping does not parse JSX.
 *
 * The rule it enforces: **the month a customer sees is the month it is in
 * Wolverhampton**, never the month it is in UTC. Those are the same thing for
 * five months of the year and differ for the first hour of every day during
 * British Summer Time, which is exactly when the old code was wrong.
 */

import { getPartsInZone } from "./time";

export type CalendarMonth = {
  year: number;
  /** 1-12, not the 0-11 a Date reports. */
  month: number;
};

/** The month a plain "2026-09-01" belongs to. Null if it is not one. */
export function monthOfIsoDate(value: string): CalendarMonth | null {
  const match = /^(\d{4})-(\d{2})-\d{2}/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;

  return { year, month };
}

/**
 * The month it is *now*, where the business operates.
 *
 * Resolved through `Intl` rather than by reading UTC fields off the Date, so
 * the GMT/BST offset for that particular instant is applied. At 00:30 on 1
 * September the UTC date is still 31 August; this returns September.
 */
export function currentMonthInZone(now: Date, timeZone: string): CalendarMonth {
  const parts = getPartsInZone(now, timeZone);
  return { year: parts.year, month: parts.month };
}

/**
 * The month the picker should open on, in order of preference:
 *
 * 1. the date the customer already chose,
 * 2. the first date the server offered — itself derived in the business
 *    timezone, so it agrees with (3) by construction,
 * 3. the current month in the business timezone, for the first render, before
 *    availability has arrived.
 *
 * The third case is not a rare fallback: availability is fetched after mount,
 * so it decides what every customer sees first.
 */
export function initialCalendarMonth(input: {
  selectedDate?: string | null;
  firstBookable?: string | null;
  now: Date;
  timeZone: string;
}): CalendarMonth {
  const chosen = input.selectedDate ? monthOfIsoDate(input.selectedDate) : null;
  if (chosen) return chosen;

  const offered = input.firstBookable
    ? monthOfIsoDate(input.firstBookable)
    : null;
  if (offered) return offered;

  return currentMonthInZone(input.now, input.timeZone);
}
