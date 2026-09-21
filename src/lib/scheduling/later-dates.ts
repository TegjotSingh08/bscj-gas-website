/**
 * What a tenant is offered when their deadline and our diary disagree.
 *
 * The scheduler shows times that fit **before** the date the work has to be
 * done by, and offers a way to look past it. Three facts decide what that
 * offer should say, and conflating any two of them produces a screen that
 * promises something it cannot do:
 *
 * 1. **Are there times before the deadline?** If not, the tenant is told so
 *    rather than shown an empty picker.
 * 2. **Are there times after it?** The reported defect: the booking window is
 *    a fixed number of days ahead, and a deadline can sit at or beyond the end
 *    of it. When it does, every slot is already compliant — so "show me later
 *    dates" revealed exactly the same list while announcing "you are now
 *    choosing from times after <date>", which was false, and left no way back.
 * 3. **Why are there none?** "The diary does not reach past that date yet" and
 *    "the dates past it are taken" are different situations with different
 *    answers — wait, or ring us — and the first version said the former in
 *    both cases.
 *
 * The horizon is **never widened** to paper over any of this. How far ahead
 * BSCJ takes bookings is a business rule, and a tenant's frustration is not an
 * input to it. Nor is any of this enforcement: the confirmation endpoint
 * re-derives the deadline and decides for itself, so a browser that edits what
 * is below changes what it sees and nothing about what is recorded.
 *
 * Pure, and deliberately outside the component: the failure was a **missing
 * branch**, which is exactly the kind of thing a test should be able to state
 * a case against rather than infer from rendered markup.
 */

/** The shape this needs from a slot. The picker's own carries more. */
export type DeadlineSlot = { startIso: string; endIso: string };

/** The shape this needs from a day. Every date in the window is present. */
export type DeadlineDay<TSlot extends DeadlineSlot = DeadlineSlot> = {
  date: string;
  slots: TSlot[];
};

/**
 * What to say about later dates when the tenant is not yet looking at them.
 *
 * - **`hidden`** — there is no deadline, or later times are already showing.
 * - **`offer`** — later times genuinely exist. The button does what it says.
 * - **`beyond_horizon`** — the diary stops at or before the deadline, so there
 *   is nothing later to reveal *yet*. More dates open as they get closer.
 * - **`later_taken`** — the diary does go past the deadline, and every time
 *   there is already gone. Waiting will not help; ringing might.
 */
export type LaterDatesOffer =
  | "hidden"
  | "offer"
  | "beyond_horizon"
  | "later_taken";

export type LaterDatesView<TSlot extends DeadlineSlot = DeadlineSlot> = {
  /** The days to render, filtered unless later times are being shown. */
  visibleDays: DeadlineDay<TSlot>[];
  /** Whether anything at all meets the cutoff. */
  hasCompliantSlot: boolean;
  /** Whether anything at all sits after the cutoff. */
  laterSlotsExist: boolean;
  /**
   * Whether the booking window reaches past the deadline **date** at all.
   *
   * Read off the days themselves — every date in the window is present, even
   * with no free slots — so the horizon is observed rather than recomputed
   * from configuration the browser has no business knowing.
   */
  windowReachesPastDeadline: boolean;
  offer: LaterDatesOffer;
  /**
   * Whether the list being shown includes times **before** the deadline too.
   *
   * It does, always, when compliant times exist: revealing later dates widens
   * the list rather than replacing it, so a tenant who changes their mind can
   * still see the earlier ones. The wording has to match that — "you are now
   * choosing from times after <date>" was describing a filter the page does
   * not apply.
   */
  showingEarlierToo: boolean;
  /** Whether there is a compliant list to go back to. */
  canReturnToEarlier: boolean;
};

/** A slot counts if it **finishes** by the cutoff, not if it starts by it. */
export function withinDeadline(
  slot: DeadlineSlot,
  endsBeforeIso: string | null,
): boolean {
  if (endsBeforeIso === null) return true;
  const endsBefore = Date.parse(endsBeforeIso);
  if (Number.isNaN(endsBefore)) return true;
  return Date.parse(slot.endIso) <= endsBefore;
}

/**
 * The last date the diary currently offers, or null when it offers none.
 *
 * A day with no free slots still counts: the question is how far ahead we take
 * bookings, not how much of it is left.
 */
export function bookingHorizon(
  days: readonly DeadlineDay[],
): string | null {
  let latest: string | null = null;
  for (const day of days) {
    if (latest === null || day.date > latest) latest = day.date;
  }
  return latest;
}

export function laterDatesView<TSlot extends DeadlineSlot>(input: {
  days: readonly DeadlineDay<TSlot>[];
  /** The instant an appointment must end at or before. Null: no deadline. */
  endsBeforeIso: string | null;
  /** The cutoff's own date, `YYYY-MM-DD`. Null: no deadline. */
  deadlineDate: string | null;
  /** Whether the tenant has asked to see times after the cutoff. */
  showingLate: boolean;
  /** The cutoff has already gone by, so nothing bookable can meet it. */
  deadlineOverdue: boolean;
}): LaterDatesView<TSlot> {
  const { days, endsBeforeIso, deadlineDate, showingLate, deadlineOverdue } =
    input;

  const hasDeadline = endsBeforeIso !== null && deadlineDate !== null;

  const visibleDays = showingLate
    ? days.map((day) => ({ date: day.date, slots: [...day.slots] }))
    : days.map((day) => ({
        date: day.date,
        slots: day.slots.filter((slot) => withinDeadline(slot, endsBeforeIso)),
      }));

  const hasCompliantSlot = days.some((day) =>
    day.slots.some((slot) => withinDeadline(slot, endsBeforeIso)),
  );
  const laterSlotsExist = days.some((day) =>
    day.slots.some((slot) => !withinDeadline(slot, endsBeforeIso)),
  );

  const horizon = bookingHorizon(days);
  const windowReachesPastDeadline =
    hasDeadline && horizon !== null && horizon > deadlineDate;

  let offer: LaterDatesOffer;
  if (!hasDeadline || showingLate) {
    offer = "hidden";
  } else if (laterSlotsExist) {
    offer = "offer";
  } else if (windowReachesPastDeadline) {
    offer = "later_taken";
  } else {
    offer = "beyond_horizon";
  }

  return {
    visibleDays,
    hasCompliantSlot,
    laterSlotsExist,
    windowReachesPastDeadline,
    offer,
    /*
      Only meaningful while later times are showing. False for an overdue job
      without having to say so: the cutoff has gone, so nothing bookable meets
      it and there is no "earlier" left to include.
    */
    showingEarlierToo: showingLate && hasCompliantSlot,
    /*
      A dead control is worse than none. There is somewhere to go back to only
      when the cutoff has not passed and something still meets it.
    */
    canReturnToEarlier: showingLate && !deadlineOverdue && hasCompliantSlot,
  };
}
