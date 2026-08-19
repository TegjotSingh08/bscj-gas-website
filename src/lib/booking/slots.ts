/**
 * Pure availability engine. No I/O, no Google, no Next — so it can be tested
 * directly and reasoned about on its own.
 *
 *   configured working windows
 *     minus Google Calendar busy periods (widened by the buffer)
 *     minus the minimum-notice cutoff
 *     minus days already at the daily cap
 *   = offered slots
 */

import { bookingConfig, blockMinutes } from "./config";
import {
  getPartsInZone,
  isoDateInZone,
  parseIsoDate,
  timeLabelInZone,
  zonedTimeToUtc,
} from "./time";

export type Interval = { start: Date; end: Date };

export type Slot = {
  /** ISO instant of the appointment start. */
  startIso: string;
  /** ISO instant of the appointment end (excludes the buffer). */
  endIso: string;
  /** "14:00" in London, for display. */
  label: string;
};

export type DayAvailability = {
  /** "2026-08-20" */
  date: string;
  slots: Slot[];
};

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60000);
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Candidate start times for one local date, before any busy/notice filtering.
 * A slot only counts if the appointment *and* its buffer finish within hours.
 */
export function candidateSlotsForDate(
  isoDate: string,
  config = bookingConfig,
): Interval[] {
  const parsed = parseIsoDate(isoDate);
  if (!parsed) return [];

  const midday = zonedTimeToUtc({ ...parsed, hour: 12, minute: 0 }, config.timeZone);
  const weekday = getPartsInZone(midday, config.timeZone).weekday;
  if (!config.workingWeekdays.includes(weekday as never)) return [];

  const slots: Interval[] = [];
  for (
    let minutes = config.workingHours.startMinutes;
    minutes + blockMinutes <= config.workingHours.endMinutes;
    minutes += config.slotIntervalMinutes
  ) {
    const start = zonedTimeToUtc(
      {
        ...parsed,
        hour: Math.floor(minutes / 60),
        minute: minutes % 60,
      },
      config.timeZone,
    );
    slots.push({ start, end: addMinutes(start, config.appointmentMinutes) });
  }
  return slots;
}

/**
 * Filters candidate slots against busy periods and the notice cutoff.
 *
 * Busy periods are widened by the buffer on both sides, so a new job can never
 * begin the moment another ends — the engineer needs travel time.
 */
export function filterAvailableSlots(
  candidates: Interval[],
  busy: Interval[],
  now: Date,
  config = bookingConfig,
): Interval[] {
  const cutoff = addMinutes(now, config.minimumNoticeHours * 60);

  const paddedBusy = busy.map((period) => ({
    start: addMinutes(period.start, -config.bufferMinutes),
    end: addMinutes(period.end, config.bufferMinutes),
  }));

  return candidates.filter((slot) => {
    if (slot.start < cutoff) return false;
    return !paddedBusy.some((period) => overlaps(slot, period));
  });
}

/** How many bookings already sit on a given local date. */
export function countBookingsOnDate(
  busy: Interval[],
  isoDate: string,
  config = bookingConfig,
): number {
  return busy.filter(
    (period) => isoDateInZone(period.start, config.timeZone) === isoDate,
  ).length;
}

/** The local dates a customer may currently book, inclusive of both ends. */
export function bookableDates(now: Date, config = bookingConfig): string[] {
  const dates: string[] = [];
  for (let offset = 0; offset <= config.maximumAdvanceDays; offset += 1) {
    const day = new Date(now.getTime() + offset * 24 * 60 * 60000);
    dates.push(isoDateInZone(day, config.timeZone));
  }
  return dates;
}

/** Builds the full availability response for a range of dates. */
export function buildAvailability(
  dates: string[],
  busy: Interval[],
  now: Date,
  config = bookingConfig,
): DayAvailability[] {
  return dates.map((date) => {
    const atCap =
      countBookingsOnDate(busy, date, config) >= config.maximumBookingsPerDay;

    const slots = atCap
      ? []
      : filterAvailableSlots(
          candidateSlotsForDate(date, config),
          busy,
          now,
          config,
        );

    return {
      date,
      slots: slots.map((slot) => ({
        startIso: slot.start.toISOString(),
        endIso: slot.end.toISOString(),
        label: timeLabelInZone(slot.start, config.timeZone),
      })),
    };
  });
}

/** Re-checked server-side at confirmation time. Never trust the browser. */
export function isSlotStillAvailable(
  startIso: string,
  busy: Interval[],
  now: Date,
  config = bookingConfig,
): boolean {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return false;

  const date = isoDateInZone(start, config.timeZone);
  const candidates = candidateSlotsForDate(date, config);

  // The requested start must be a genuine configured slot, not an arbitrary time.
  const candidate = candidates.find(
    (slot) => slot.start.getTime() === start.getTime(),
  );
  if (!candidate) return false;

  if (countBookingsOnDate(busy, date, config) >= config.maximumBookingsPerDay) {
    return false;
  }

  return filterAvailableSlots([candidate], busy, now, config).length === 1;
}
