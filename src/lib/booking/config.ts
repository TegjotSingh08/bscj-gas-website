/**
 * The single place booking rules are defined.
 *
 * Every value mirrors docs/business-details.md. The availability engine, the
 * API routes and the UI all read from here — nothing re-declares a rule.
 *
 * One rule is now per-product rather than global: the appointment length. Use
 * `bookingConfigFor(productId)` wherever a product is known, and treat the
 * bare `bookingConfig` export as what it is — the CP12 default, kept so that
 * anything which does not care about products keeps working unchanged.
 */

import { availability } from "@/lib/business";
import {
  DEFAULT_PRODUCT_ID,
  productFor,
  type ProductId,
} from "./products";

/** 0 = Sunday … 6 = Saturday. Monday–Friday plus Sunday; closed Saturdays. */
export const WORKING_WEEKDAYS = [0, 1, 2, 3, 4, 5] as const;

export type BookingConfig = {
  timeZone: string;
  /** Working window in local (London) wall-clock minutes from midnight. */
  workingHours: { startMinutes: number; endMinutes: number };
  workingWeekdays: readonly number[];
  /**
   * The customer-facing appointment length. **Per product.** A slot is only
   * offered when the appointment itself finishes inside working hours.
   */
  appointmentMinutes: number;
  /**
   * Internal scheduling protection — travel and overrun time between jobs.
   *
   * Deliberately *not* part of the appointment. It is enforced in full between
   * two bookings, by widening every busy period on both sides, but it is
   * allowed to run past the end of the working day on the last job: a 21:00
   * bundle is a valid 21:00–22:00 appointment whose buffer ends at 22:15.
   * Decided 31 August 2026; see docs/business-details.md.
   */
  bufferMinutes: number;
  /** Slots are offered on the hour — cleaner for customers than 10:00/10:45. */
  slotIntervalMinutes: number;
  minimumNoticeHours: number;
  maximumAdvanceDays: number;
  /**
   * The most **customer bookings** BSCJ will take on one local calendar date.
   *
   * Counted in confirmed BSCJ booking events, never in busy periods: the
   * engineer's own diary entries — the weekday school run, a dentist
   * appointment — block the slots they overlap but are not customers and must
   * not consume the day's capacity. See `lib/booking/daily-limit.ts`.
   */
  maximumBookingsPerDay: number;
};

const baseConfig: Omit<BookingConfig, "appointmentMinutes"> = {
  timeZone: "Europe/London",
  workingHours: { startMinutes: 10 * 60, endMinutes: 22 * 60 },
  workingWeekdays: WORKING_WEEKDAYS,
  bufferMinutes: 15,
  slotIntervalMinutes: 60,
  minimumNoticeHours: availability.minimumNoticeHours,
  maximumAdvanceDays: availability.maximumAdvanceDays,
  maximumBookingsPerDay: 10,
};

/** The booking rules for one product. */
export function bookingConfigFor(
  productId: ProductId = DEFAULT_PRODUCT_ID,
): BookingConfig {
  return {
    ...baseConfig,
    appointmentMinutes: productFor(productId).durationMinutes,
  };
}

/**
 * The CP12 configuration, and the default for anything that does not name a
 * product. Kept as a plain export so every pre-existing call site is unchanged.
 */
export const bookingConfig: BookingConfig = bookingConfigFor(DEFAULT_PRODUCT_ID);

/**
 * Total calendar time one job consumes: the appointment plus its buffer.
 *
 * This is what a booking *blocks*, not what it is offered as — see
 * `bufferMinutes`. It decides which other start times a booking conflicts
 * with, so it drives the reservation keys in `holds.ts`, not the slot grid.
 */
export function blockMinutesFor(config: BookingConfig): number {
  return config.appointmentMinutes + config.bufferMinutes;
}
