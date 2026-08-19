/**
 * The single place booking rules are defined.
 *
 * Every value mirrors docs/business-details.md. The availability engine, the
 * API routes and the UI all read from here — nothing re-declares a rule.
 */

import { availability, cp12 } from "@/lib/business";

/** 0 = Sunday … 6 = Saturday. Monday–Friday plus Sunday; closed Saturdays. */
export const WORKING_WEEKDAYS = [0, 1, 2, 3, 4, 5] as const;

export const bookingConfig = {
  timeZone: "Europe/London",

  /** Working window in local (London) wall-clock minutes from midnight. */
  workingHours: { startMinutes: 10 * 60, endMinutes: 20 * 60 },
  workingWeekdays: WORKING_WEEKDAYS,

  appointmentMinutes: cp12.durationMinutes,
  bufferMinutes: 15,

  /** Slots are offered on the hour — cleaner for customers than 10:00/11:00/12:00. */
  slotIntervalMinutes: 60,

  minimumNoticeHours: availability.minimumNoticeHours,
  maximumAdvanceDays: availability.maximumAdvanceDays,
  maximumBookingsPerDay: 8,
} as const;

export type BookingConfig = typeof bookingConfig;

/** Total calendar time one job consumes, appointment plus buffer. */
export const blockMinutes =
  bookingConfig.appointmentMinutes + bookingConfig.bufferMinutes;
