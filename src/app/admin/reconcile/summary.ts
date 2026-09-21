import type { RenewalStop } from "@/lib/compliance/outstanding";

/**
 * What the reconciliation page may and may not claim.
 *
 * **Why this is a function and not four `&&`s in the page.** The page's job is
 * to answer one question — "is anything outstanding?" — and the dangerous
 * answer is "no". Every source behind it can return *unknown*: a query can
 * fail, a store can refuse to list, and the renewals walk is bounded and can
 * stop before the end. Each of those is a third state, and every one of them
 * had to be folded into a boolean somewhere.
 *
 * It was folded wrongly. `(outstandingRenewals?.length ?? 0) === 0` turned a
 * failed query into a confident zero, so a page that could not read the
 * compliance records printed "Nothing outstanding." — reporting the one state
 * it did not know as the one state that needs no action.
 *
 * So the rule is written once, here, where it can be tested: **reassurance
 * requires knowledge.** Anything unknown withholds it.
 */
export type ReconcileVisibility = {
  /** The compliance records could not be read at all. */
  renewalsUnavailable: boolean;
  /** They were read, but the walk stopped before the end of the ordering. */
  renewalsIncomplete: boolean;
  /**
   * This page began at a cursor, so it covers only part of the ordering.
   *
   * **Reaching the end of a continuation is not reaching the end.** The walk
   * started after a position somebody else chose; everything before that
   * position was not looked at on this request and is not ruled out by it.
   */
  renewalsPartialScope: boolean;
  /** Every source answered fully, so "nothing outstanding" can be unqualified. */
  everythingKnown: boolean;
  /**
   * Nothing is outstanding **and** everything was readable.
   *
   * False whenever anything is unknown, however empty the rest looks, and
   * false on a continuation page whatever it found.
   */
  nothingOutstanding: boolean;
};

export function summariseReconcile(input: {
  /** Null when the compliance records could not be read. */
  renewals: { rows: readonly unknown[]; stoppedBecause: RenewalStop } | null;
  /** True when this request began at a cursor rather than at the beginning. */
  continued: boolean;
  /** False when the outbox query failed. */
  messagesReadable: boolean;
  /** False when the reservation store could not be listed. */
  reservationsListed: boolean;
  counts: {
    awaitingCalendarSync: number;
    awaitingCalendarCleanup: number;
    unpersistedBookings: number;
    pendingNotifications: number;
    failedNotifications: number;
  };
}): ReconcileVisibility {
  const { renewals, continued, messagesReadable, reservationsListed, counts } =
    input;

  const renewalsUnavailable = renewals === null;
  const renewalsIncomplete =
    renewals !== null && renewals.stoppedBecause !== "exhausted";
  /*
    Complete means the whole ordering was walked, which a continuation never
    does however cleanly it finishes. `exhausted` on a continuation means
    "nothing after that position", and the page must not round that up.
  */
  const renewalsComplete = renewals !== null && !renewalsIncomplete && !continued;

  const everythingKnown =
    renewalsComplete && messagesReadable && reservationsListed;

  const everyQueueEmpty =
    (renewals?.rows.length ?? 0) === 0 &&
    counts.awaitingCalendarSync === 0 &&
    counts.awaitingCalendarCleanup === 0 &&
    counts.unpersistedBookings === 0 &&
    counts.pendingNotifications === 0 &&
    counts.failedNotifications === 0;

  return {
    renewalsUnavailable,
    renewalsIncomplete,
    renewalsPartialScope: continued,
    everythingKnown,
    /*
      Deliberately requires `renewalsComplete` rather than merely
      "not unavailable": a walk that stopped at its bound has not ruled
      anything out, and saying nothing is outstanding on the strength of it
      would be the same mistake in a quieter form. A continuation page is the
      same mistake again — an empty tail says nothing about the head.
    */
    nothingOutstanding: renewalsComplete && everyQueueEmpty,
  };
}
