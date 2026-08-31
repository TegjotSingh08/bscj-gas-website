/**
 * The contractual layer of a booking.
 *
 * A booking made on this site is a **distance contract for a service** between
 * a trader and (usually) a consumer, so the Consumer Contracts (Information,
 * Cancellation and Additional Charges) Regulations 2013 apply. See
 * docs/CONSUMER_RIGHTS.md for the sources behind every rule below.
 *
 * Pure and dependency-free: every rule here is decided from values passed in,
 * so the server can re-derive them without trusting anything the browser said.
 *
 * This is not legal advice and has not been reviewed by a solicitor.
 */

import { getPartsInZone, zonedTimeToUtc } from "./time";

/**
 * The version of the terms a customer accepted.
 *
 * Date-based, so a record of "accepted v2026-08-22" is meaningful years later
 * without a lookup table. **Bump this whenever /terms changes in substance**;
 * the page derives its effective date from this value.
 *
 * Bumped to 2026-08-31 for the boiler service: two further services are now
 * being contracted — the bundle and the standalone Annual Boiler Service — so
 * section 5 states three prices, and the sections about what the price covers
 * and about performance inside the cancellation period had to stop assuming
 * the work is only an inspection.
 *
 * Not bumped again for the standalone service, deliberately: 2026-08-31 has
 * never been in force publicly, so there is no earlier wording under that
 * version for a customer to have accepted. The version that goes live is the
 * one that describes all three services.
 */
export const TERMS_VERSION = "2026-08-31";

/** Shape check only — the current version is the single source of truth. */
const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isCurrentTermsVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    VERSION_PATTERN.test(value) &&
    value === TERMS_VERSION
  );
}

/**
 * Regulation 30(2)(a): for a service contract the cancellation period ends at
 * the end of 14 days after the day on which the contract is entered into.
 */
export const CANCELLATION_PERIOD_DAYS = 14;

/**
 * The last calendar day of the statutory cancellation period, as an ISO date
 * in the booking timezone.
 *
 * Day counting is done on the local calendar date, not on elapsed hours, so a
 * booking taken at 23:50 gets the same last day as one taken at 00:10.
 */
export function cancellationPeriodLastDate(
  contractMadeAt: Date,
  timeZone: string,
): string {
  const parts = getPartsInZone(contractMadeAt, timeZone);
  // Midday avoids any daylight-saving edge when adding whole days.
  const midday = Date.UTC(parts.year, parts.month - 1, parts.day, 12);
  const last = new Date(midday + CANCELLATION_PERIOD_DAYS * 24 * 60 * 60000);

  return [
    last.getUTCFullYear(),
    String(last.getUTCMonth() + 1).padStart(2, "0"),
    String(last.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * The instant the statutory cancellation period expires — the very end of the
 * last day, in local time.
 */
export function cancellationPeriodEnd(
  contractMadeAt: Date,
  timeZone: string,
): Date {
  const [year, month, day] = cancellationPeriodLastDate(
    contractMadeAt,
    timeZone,
  )
    .split("-")
    .map(Number);

  // The end of the last day is the start of the next one, less a millisecond.
  const nextDay = zonedTimeToUtc(
    { year, month, day: day + 1, hour: 0, minute: 0 },
    timeZone,
  );
  return new Date(nextDay.getTime() - 1);
}

/**
 * Whether the appointment falls inside the statutory cancellation period, and
 * so needs the customer's express request before the engineer may attend.
 *
 * Regulation 36(1): the trader must not begin supplying a service before the
 * end of the cancellation period unless the consumer has made an express
 * request. Bookings here can be made up to 30 days ahead, so appointments more
 * than 14 days out fall outside the period and need no such request.
 *
 * Decided from the slot and the moment the contract is made — never from a
 * flag the browser sent.
 */
export function requiresEarlyPerformanceRequest(
  slotStart: Date,
  contractMadeAt: Date,
  timeZone: string,
): boolean {
  return (
    slotStart.getTime() <= cancellationPeriodEnd(contractMadeAt, timeZone).getTime()
  );
}

export type TermsProblem =
  | "terms_not_accepted"
  | "terms_version_stale"
  | "early_performance_not_requested";

export type TermsCheck =
  | { ok: true; earlyPerformanceRequired: boolean }
  | { ok: false; problem: TermsProblem };

/**
 * The server's own view of whether this booking may lawfully proceed.
 *
 * Deliberately takes the slot and the current time rather than a "this is
 * inside the cancellation period" flag: whether the request is needed is the
 * server's decision, so a browser cannot make the requirement disappear by
 * claiming the appointment is far away.
 */
export function checkTermsAcceptance(input: {
  termsVersion: unknown;
  termsAccepted: unknown;
  earlyPerformanceRequested: unknown;
  slotStart: Date;
  contractMadeAt: Date;
  timeZone: string;
}): TermsCheck {
  if (input.termsAccepted !== true) {
    return { ok: false, problem: "terms_not_accepted" };
  }
  if (!isCurrentTermsVersion(input.termsVersion)) {
    return { ok: false, problem: "terms_version_stale" };
  }

  const earlyPerformanceRequired = requiresEarlyPerformanceRequest(
    input.slotStart,
    input.contractMadeAt,
    input.timeZone,
  );

  if (earlyPerformanceRequired && input.earlyPerformanceRequested !== true) {
    return { ok: false, problem: "early_performance_not_requested" };
  }

  return { ok: true, earlyPerformanceRequired };
}

/** What to tell the customer. Never legal jargon, never blame. */
export function termsProblemMessage(problem: TermsProblem): string {
  switch (problem) {
    case "terms_not_accepted":
      return "Please read and accept the Terms & Conditions before confirming.";
    case "terms_version_stale":
      return "Our Terms & Conditions have been updated. Please refresh the page and read them again before confirming.";
    case "early_performance_not_requested":
      return "Your appointment falls within your 14-day cancellation period, so please confirm you are asking us to carry out the check on that date.";
  }
}
