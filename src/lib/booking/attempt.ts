/**
 * The state of one booking attempt.
 *
 * Pulled out of the component and made a pure reducer because the bug this
 * replaces was a state-ownership mistake, not a rendering one: the reservation
 * used to belong to the UI step, so navigating backwards could quietly drop or
 * duplicate it. Here the reservation belongs to the *attempt*, and only three
 * actions can ever clear it — switching to a new one, expiry, and an explicit
 * cancellation.
 *
 * Pure and dependency-free, so every navigation rule is directly testable.
 */

export type Step = 1 | 2 | 3 | 4;

export type Reservation = {
  /** Opaque hold token. Null in degraded mode, when there is no hold store. */
  token: string | null;
  slotStart: string;
  slotEnd: string;
  /** "17:00" */
  label: string;
  /** "2026-08-24" */
  dateIso: string;
  /** Null in degraded mode: there is no TTL to count down. */
  expiresAt: string | null;
  degraded: boolean;
};

export type AttemptState = {
  step: Step;
  selectedDate: string | null;
  reservation: Reservation | null;
  /** True while the customer is browsing alternatives to an existing hold. */
  changingTime: boolean;
};

export type AttemptAction =
  | { type: "select-date"; date: string }
  | { type: "reserved"; reservation: Reservation }
  | { type: "start-change-time" }
  | { type: "cancel-change-time" }
  | { type: "go-to-step"; step: Step }
  | { type: "expired" }
  | { type: "cancel-booking" };

export const initialAttemptState: AttemptState = {
  step: 1,
  selectedDate: null,
  reservation: null,
  changingTime: false,
};

export function attemptReducer(
  state: AttemptState,
  action: AttemptAction,
): AttemptState {
  switch (action.type) {
    case "select-date":
      // Picking a date never disturbs an existing reservation — the customer
      // may be browsing alternatives and decide to keep what they have.
      // `changingTime` is carried through deliberately, so browsing from the
      // date step to another day's times stays a change in progress.
      return { ...state, selectedDate: action.date, step: 2 };

    case "reserved":
      // A new reservation is active. The server has already released the
      // previous hold, and only after successfully taking this one.
      return {
        ...state,
        reservation: action.reservation,
        selectedDate: action.reservation.dateIso,
        changingTime: false,
        step: 3,
      };

    case "start-change-time":
      // The existing hold stays exactly as it is while alternatives are shown.
      return {
        ...state,
        changingTime: true,
        step: 2,
        selectedDate: state.selectedDate ?? state.reservation?.dateIso ?? null,
      };

    case "cancel-change-time":
      if (!state.reservation) return state;
      return {
        ...state,
        changingTime: false,
        selectedDate: state.reservation.dateIso,
        step: 3,
      };

    case "go-to-step": {
      // Plain navigation. Never touches the reservation: this is the rule the
      // old implementation broke.
      if (state.reservation && action.step <= 2) {
        // Date and time are only meaningful with an explicit change in mind
        // once a slot is held, so reaching either enters change mode rather
        // than exposing slots that would silently take a second hold.
        //
        // The requested step itself is honoured. Forcing it to 2 was the bug
        // behind "Change date" doing nothing: every route to the date step
        // goes through this action, so a held reservation made the date
        // picker unreachable and the only way out was cancelling.
        return { ...state, step: action.step, changingTime: true };
      }
      return { ...state, step: action.step };
    }

    case "expired":
      return {
        ...state,
        reservation: null,
        changingTime: false,
        step: 2,
      };

    case "cancel-booking":
      return { ...initialAttemptState };

    default:
      return state;
  }
}

/**
 * The current reservation, sent with every acquisition so the server can
 * release it once the replacement is safely taken. Always sent when one
 * exists, including for the same slot, so re-selecting what the attempt
 * already owns is recognised rather than reported as a conflict.
 */
export function previousHoldFor(
  state: AttemptState,
): { slotStart: string; token: string } | undefined {
  const reservation = state.reservation;
  if (!reservation?.token) return undefined;
  return { slotStart: reservation.slotStart, token: reservation.token };
}

/** Whether a slot should be shown as the customer's own reservation. */
export function isOwnReservation(
  state: AttemptState,
  slotStart: string,
): boolean {
  return state.reservation?.slotStart === slotStart;
}
