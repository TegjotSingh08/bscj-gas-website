import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  attemptReducer,
  initialAttemptState,
  isOwnReservation,
  previousHoldFor,
  type AttemptState,
  type Reservation,
} from "./attempt";

/**
 * Regression tests for the bug these rules replace: the reservation used to
 * belong to the UI step, so navigating backwards could silently drop it or
 * cause a second hold to be taken.
 */

const RESERVATION: Reservation = {
  token: "a".repeat(64),
  slotStart: "2026-08-24T16:00:00.000Z",
  slotEnd: "2026-08-24T16:45:00.000Z",
  label: "17:00",
  dateIso: "2026-08-24",
  expiresAt: "2026-08-24T12:30:00.000Z",
  degraded: false,
};

const OTHER_RESERVATION: Reservation = {
  ...RESERVATION,
  token: "b".repeat(64),
  slotStart: "2026-08-25T17:00:00.000Z",
  slotEnd: "2026-08-25T17:45:00.000Z",
  label: "18:00",
  dateIso: "2026-08-25",
  expiresAt: "2026-08-24T13:00:00.000Z",
};

/** A state with an active reservation, sitting on the details step. */
function reserved(): AttemptState {
  return attemptReducer(
    attemptReducer(initialAttemptState, {
      type: "select-date",
      date: "2026-08-24",
    }),
    { type: "reserved", reservation: RESERVATION },
  );
}

describe("the reservation survives the booking steps", () => {
  test("reserving moves to details and holds the slot", () => {
    const state = reserved();
    assert.equal(state.step, 3);
    assert.deepEqual(state.reservation, RESERVATION);
    assert.equal(state.changingTime, false);
  });

  test("it survives moving on to review", () => {
    const state = attemptReducer(reserved(), { type: "go-to-step", step: 4 });
    assert.equal(state.step, 4);
    assert.deepEqual(state.reservation, RESERVATION);
  });

  test("it survives going back from review to details", () => {
    const onReview = attemptReducer(reserved(), { type: "go-to-step", step: 4 });
    const backToDetails = attemptReducer(onReview, {
      type: "go-to-step",
      step: 3,
    });
    assert.equal(backToDetails.step, 3);
    assert.deepEqual(backToDetails.reservation, RESERVATION);
  });

  test("it survives repeated back and forth navigation", () => {
    let state = reserved();
    for (const step of [4, 3, 4, 3, 4] as const) {
      state = attemptReducer(state, { type: "go-to-step", step });
      assert.deepEqual(state.reservation, RESERVATION);
    }
  });

  test("going back to the time step keeps the hold and enters change mode", () => {
    const state = attemptReducer(reserved(), { type: "go-to-step", step: 2 });
    assert.equal(state.step, 2);
    assert.deepEqual(state.reservation, RESERVATION);
    // Change mode, so a stray click cannot silently take a second hold.
    assert.equal(state.changingTime, true);
  });

  test("going back to the date step also keeps the hold", () => {
    const state = attemptReducer(reserved(), { type: "go-to-step", step: 1 });
    assert.deepEqual(state.reservation, RESERVATION);
    // The requested step is honoured. Forcing it to 2 here is what used to
    // make "Change date" a dead button.
    assert.equal(state.step, 1);
    assert.equal(state.changingTime, true);
  });

  test("choosing a date never disturbs the reservation", () => {
    const state = attemptReducer(reserved(), {
      type: "select-date",
      date: "2026-08-26",
    });
    assert.deepEqual(state.reservation, RESERVATION);
    assert.equal(state.selectedDate, "2026-08-26");
  });
});

describe("changing the reserved time", () => {
  test("starting a change keeps the existing hold", () => {
    const state = attemptReducer(reserved(), { type: "start-change-time" });
    assert.equal(state.changingTime, true);
    assert.equal(state.step, 2);
    assert.deepEqual(state.reservation, RESERVATION);
  });

  test("the previous hold is always sent, so the server can release it", () => {
    const state = attemptReducer(reserved(), { type: "start-change-time" });
    assert.deepEqual(previousHoldFor(state), {
      slotStart: RESERVATION.slotStart,
      token: RESERVATION.token,
    });
  });

  test("a successful switch leaves exactly one reservation", () => {
    const changing = attemptReducer(reserved(), { type: "start-change-time" });
    const switched = attemptReducer(changing, {
      type: "reserved",
      reservation: OTHER_RESERVATION,
    });

    assert.deepEqual(switched.reservation, OTHER_RESERVATION);
    assert.notEqual(switched.reservation?.slotStart, RESERVATION.slotStart);
    assert.equal(switched.changingTime, false);
    assert.equal(switched.step, 3);
  });

  test("a new reservation carries its own fresh expiry", () => {
    const changing = attemptReducer(reserved(), { type: "start-change-time" });
    const switched = attemptReducer(changing, {
      type: "reserved",
      reservation: OTHER_RESERVATION,
    });
    assert.equal(switched.reservation?.expiresAt, OTHER_RESERVATION.expiresAt);
    assert.notEqual(switched.reservation?.expiresAt, RESERVATION.expiresAt);
  });

  test("a failed switch leaves the original reservation untouched", () => {
    const changing = attemptReducer(reserved(), { type: "start-change-time" });
    // A rejected acquisition dispatches nothing, so the state must be unchanged.
    assert.deepEqual(changing.reservation, RESERVATION);
    assert.equal(changing.changingTime, true);
  });

  test("abandoning the change returns to details with the original slot", () => {
    const changing = attemptReducer(reserved(), { type: "start-change-time" });
    const kept = attemptReducer(changing, { type: "cancel-change-time" });

    assert.deepEqual(kept.reservation, RESERVATION);
    assert.equal(kept.changingTime, false);
    assert.equal(kept.step, 3);
    assert.equal(kept.selectedDate, RESERVATION.dateIso);
  });

  test("abandoning a change with no reservation does nothing", () => {
    const state = attemptReducer(initialAttemptState, {
      type: "cancel-change-time",
    });
    assert.deepEqual(state, initialAttemptState);
  });
});

/**
 * Regression tests for the "Change date" defect.
 *
 * Every route to the date step goes through `go-to-step`, which used to force
 * a held reservation back to step 2. The button therefore did nothing, and a
 * customer wanting a different day had to cancel and lose their slot.
 *
 * Slot A below is the held Thursday 17:00 appointment; Slot B is the
 * alternative on another date.
 */
describe("changing the reserved date", () => {
  /** Slot A held, customer has pressed "Change date" from the time step. */
  function browsingDates(): AttemptState {
    return attemptReducer(
      attemptReducer(reserved(), { type: "start-change-time" }),
      { type: "go-to-step", step: 1 },
    );
  }

  test("Change date actually reaches the date picker", () => {
    assert.equal(browsingDates().step, 1);
  });

  test("the original reservation is still held while browsing dates", () => {
    assert.deepEqual(browsingDates().reservation, RESERVATION);
  });

  test("browsing dates is a change in progress, not a fresh booking", () => {
    assert.equal(browsingDates().changingTime, true);
  });

  test("the countdown does not reset, because the expiry never changes", () => {
    const browsing = browsingDates();
    const onAnotherDate = attemptReducer(browsing, {
      type: "select-date",
      date: "2026-08-27",
    });
    const backAgain = attemptReducer(onAnotherDate, {
      type: "go-to-step",
      step: 1,
    });

    // The bar derives its countdown from expiresAt alone, so an untouched
    // expiry is an untouched countdown however far the customer navigates.
    for (const state of [browsing, onAnotherDate, backAgain]) {
      assert.equal(state.reservation?.expiresAt, RESERVATION.expiresAt);
    }
  });

  test("selecting another date does not release the original slot", () => {
    const state = attemptReducer(browsingDates(), {
      type: "select-date",
      date: "2026-08-27",
    });
    assert.deepEqual(state.reservation, RESERVATION);
    assert.equal(state.selectedDate, "2026-08-27");
  });

  test("viewing another day's times keeps the original held and in change mode", () => {
    const state = attemptReducer(browsingDates(), {
      type: "select-date",
      date: "2026-08-27",
    });
    assert.equal(state.step, 2);
    assert.equal(state.changingTime, true);
    assert.deepEqual(state.reservation, RESERVATION);
  });

  test("the original hold is still offered for release-after-acquire", () => {
    const state = attemptReducer(browsingDates(), {
      type: "select-date",
      date: "2026-08-27",
    });
    // Sent with the acquisition of Slot B so the server can release Slot A —
    // but only once Slot B is safely taken.
    assert.deepEqual(previousHoldFor(state), {
      slotStart: RESERVATION.slotStart,
      token: RESERVATION.token,
    });
  });

  test("a failed acquisition on the new date leaves the original untouched", () => {
    // A rejected acquisition dispatches nothing at all, so the state a
    // customer is left with is exactly the one they were browsing from.
    const browsing = attemptReducer(browsingDates(), {
      type: "select-date",
      date: "2026-08-27",
    });
    assert.deepEqual(browsing.reservation, RESERVATION);
    assert.equal(browsing.reservation?.expiresAt, RESERVATION.expiresAt);
    assert.equal(browsing.changingTime, true);
  });

  test("the customer can abandon the change and keep the original", () => {
    const kept = attemptReducer(
      attemptReducer(browsingDates(), {
        type: "select-date",
        date: "2026-08-27",
      }),
      { type: "cancel-change-time" },
    );

    assert.deepEqual(kept.reservation, RESERVATION);
    assert.equal(kept.changingTime, false);
    assert.equal(kept.step, 3);
    // Back on the original appointment's date, not the one being browsed.
    assert.equal(kept.selectedDate, RESERVATION.dateIso);
  });

  test("a successful switch to another date leaves exactly one reservation", () => {
    const switched = attemptReducer(
      attemptReducer(browsingDates(), {
        type: "select-date",
        date: OTHER_RESERVATION.dateIso,
      }),
      { type: "reserved", reservation: OTHER_RESERVATION },
    );

    assert.deepEqual(switched.reservation, OTHER_RESERVATION);
    assert.notEqual(switched.reservation?.slotStart, RESERVATION.slotStart);
    assert.equal(switched.changingTime, false);
    assert.equal(switched.step, 3);
    assert.equal(switched.selectedDate, OTHER_RESERVATION.dateIso);
  });

  test("the switched reservation carries its own fresh thirty minutes", () => {
    const switched = attemptReducer(browsingDates(), {
      type: "reserved",
      reservation: OTHER_RESERVATION,
    });
    assert.equal(switched.reservation?.expiresAt, OTHER_RESERVATION.expiresAt);
    assert.notEqual(switched.reservation?.expiresAt, RESERVATION.expiresAt);
  });

  test("expiry while browsing dates returns to time selection and holds nothing", () => {
    const expired = attemptReducer(browsingDates(), { type: "expired" });
    assert.equal(expired.reservation, null);
    assert.equal(expired.step, 2);
    assert.equal(expired.changingTime, false);
    assert.equal(previousHoldFor(expired), undefined);
  });

  test("cancelling while browsing dates gives the reservation up deliberately", () => {
    const cancelled = attemptReducer(browsingDates(), {
      type: "cancel-booking",
    });
    assert.deepEqual(cancelled, initialAttemptState);
  });

  test("reaching the date step from review also keeps the hold", () => {
    const onReview = attemptReducer(reserved(), { type: "go-to-step", step: 4 });
    const onDates = attemptReducer(onReview, { type: "go-to-step", step: 1 });

    assert.equal(onDates.step, 1);
    assert.equal(onDates.changingTime, true);
    assert.deepEqual(onDates.reservation, RESERVATION);
  });

  test("with no reservation the date step is plain navigation", () => {
    const state = attemptReducer(initialAttemptState, {
      type: "go-to-step",
      step: 1,
    });
    assert.equal(state.step, 1);
    assert.equal(state.changingTime, false);
    assert.equal(state.reservation, null);
  });
});

describe("the customer's own slot", () => {
  test("their reserved slot is recognised as theirs", () => {
    assert.equal(isOwnReservation(reserved(), RESERVATION.slotStart), true);
  });

  test("another slot is not", () => {
    assert.equal(
      isOwnReservation(reserved(), OTHER_RESERVATION.slotStart),
      false,
    );
  });

  test("with no reservation, nothing is theirs", () => {
    assert.equal(
      isOwnReservation(initialAttemptState, RESERVATION.slotStart),
      false,
    );
  });
});

describe("ending the attempt", () => {
  test("cancelling clears the reservation and returns to the start", () => {
    const state = attemptReducer(reserved(), { type: "cancel-booking" });
    assert.equal(state.reservation, null);
    assert.equal(state.step, 1);
    assert.equal(state.selectedDate, null);
    assert.equal(state.changingTime, false);
  });

  test("expiry clears the reservation and returns to time selection", () => {
    const state = attemptReducer(reserved(), { type: "expired" });
    assert.equal(state.reservation, null);
    assert.equal(state.step, 2);
    assert.equal(state.changingTime, false);
  });

  test("nothing is sent as a previous hold once it has gone", () => {
    const expired = attemptReducer(reserved(), { type: "expired" });
    assert.equal(previousHoldFor(expired), undefined);
  });

  test("degraded mode sends no previous hold, because there is no token", () => {
    const degraded = attemptReducer(initialAttemptState, {
      type: "reserved",
      reservation: { ...RESERVATION, token: null, expiresAt: null, degraded: true },
    });
    assert.equal(previousHoldFor(degraded), undefined);
  });
});

describe("only three things can clear a reservation", () => {
  test("navigation, date selection and change mode never do", () => {
    const safeActions = [
      { type: "go-to-step", step: 1 },
      { type: "go-to-step", step: 2 },
      { type: "go-to-step", step: 3 },
      { type: "go-to-step", step: 4 },
      { type: "select-date", date: "2026-09-01" },
      { type: "start-change-time" },
      { type: "cancel-change-time" },
    ] as const;

    for (const action of safeActions) {
      const state = attemptReducer(reserved(), action);
      assert.ok(
        state.reservation !== null,
        `${action.type} must not clear the reservation`,
      );
    }
  });

  test("only expiry and cancellation do", () => {
    assert.equal(
      attemptReducer(reserved(), { type: "expired" }).reservation,
      null,
    );
    assert.equal(
      attemptReducer(reserved(), { type: "cancel-booking" }).reservation,
      null,
    );
  });
});
