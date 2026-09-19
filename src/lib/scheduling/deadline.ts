import { parseIsoDate, zonedTimeToUtc } from "@/lib/booking/time";

/**
 * By when the work has to be done.
 *
 * Two dates can say so, and they mean different things:
 *
 * - **`completeByDate`** on the job — the date the agent *asked* for. A
 *   commercial request: a tenancy starts, a mortgage completes, somebody wants
 *   it done before they go away.
 * - **`dueDate`** on the property's active compliance cycle — the date the
 *   existing certificate stops covering the property. A legal position.
 *
 * They are **never** collapsed into one another and both are preserved
 * separately wherever they are recorded. What scheduling needs is a single
 * cutoff, and the cutoff is **the earlier of the two**: meeting the later one
 * while missing the earlier is still missing a deadline.
 *
 * If only one exists, that one is the cutoff. If neither exists there is no
 * deadline at all — not a deadline of "some time", and not a risk level of
 * "normal", both of which would imply a commitment nobody made.
 *
 * Pure, so every rule below is testable without a database, a request or a
 * clock. The reading from Postgres lives in `deadline-lookup.ts`.
 */

/** Which of the two dates the cutoff came from. */
export type DeadlineSource =
  /** The agent's requested completion date is the earlier one. */
  | "requested"
  /** The certificate's due date is the earlier one. */
  | "certificate"
  /** They fall on the same day, so both are being met or missed together. */
  | "both";

export type DeadlineInput = {
  /** `job.complete_by_date`, an ISO date or null. */
  requestedBy: string | null;
  /** `compliance_cycle.due_date` for the active cycle, an ISO date or null. */
  certificateDueBy: string | null;
};

export type SchedulingDeadline =
  | {
      status: "none";
      /** Carried even when empty, so a caller can always show both. */
      requestedBy: null;
      certificateDueBy: null;
    }
  | {
      status: "set";
      /** The cutoff: the earlier of the two, as an ISO date. */
      date: string;
      source: DeadlineSource;
      /** Both, always, whichever one won. */
      requestedBy: string | null;
      certificateDueBy: string | null;
      /**
       * The instant an appointment must **end at or before**.
       *
       * Midnight at the *start of the following day*, London. "Finish by the
       * end of that date" is a wall-clock statement, and Europe/London is not
       * a fixed offset — an appointment on the day the clocks go back has an
       * hour more in it than the same wall-clock day in July.
       */
      endsBefore: Date;
    };

const NONE: SchedulingDeadline = {
  status: "none",
  requestedBy: null,
  certificateDueBy: null,
};

/** The earlier of two ISO dates. Lexicographic works because they are ISO. */
function earlier(a: string, b: string): string {
  return a <= b ? a : b;
}

/**
 * The cutoff, or none.
 *
 * A malformed date is treated as absent rather than as a cutoff nobody can
 * compute: a bad string must not silently become a deadline that refuses every
 * slot, and it must not become one that accepts every slot either. Absent is
 * the reading that changes nothing.
 */
export function resolveDeadline(
  input: DeadlineInput,
  timeZone: string,
): SchedulingDeadline {
  const requestedBy = normaliseDate(input.requestedBy);
  const certificateDueBy = normaliseDate(input.certificateDueBy);

  if (!requestedBy && !certificateDueBy) return NONE;

  const date = requestedBy
    ? certificateDueBy
      ? earlier(requestedBy, certificateDueBy)
      : requestedBy
    : certificateDueBy!;

  const parsed = parseIsoDate(date);
  if (!parsed) return NONE;

  let source: DeadlineSource;
  if (requestedBy && certificateDueBy) {
    source =
      requestedBy === certificateDueBy
        ? "both"
        : requestedBy < certificateDueBy
          ? "requested"
          : "certificate";
  } else {
    source = requestedBy ? "requested" : "certificate";
  }

  return {
    status: "set",
    date,
    source,
    requestedBy,
    certificateDueBy,
    endsBefore: endOfDayInZone(date, timeZone),
  };
}

function normaliseDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.slice(0, 10);
  return parseIsoDate(trimmed) ? trimmed : null;
}

/**
 * Midnight at the start of the day *after* the given date, in the zone.
 *
 * Exclusive on purpose: an appointment ending at exactly 00:00 the next day
 * finished on the deadline date, and one ending a minute later did not.
 */
export function endOfDayInZone(isoDate: string, timeZone: string): Date {
  const parsed = parseIsoDate(isoDate);
  if (!parsed) return new Date(NaN);

  // Calendar arithmetic, not instant arithmetic: adding 24 hours to a London
  // midnight lands at 23:00 or 01:00 on the two days the clocks change.
  const next = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + 1));
  return zonedTimeToUtc(
    {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
      hour: 0,
      minute: 0,
    },
    timeZone,
  );
}

/** Whether an appointment finishes within the cutoff. No deadline, no answer. */
export function meetsDeadline(
  appointmentEnd: Date,
  deadline: SchedulingDeadline,
): boolean {
  if (deadline.status === "none") return true;
  return appointmentEnd.getTime() <= deadline.endsBefore.getTime();
}

/**
 * Whether the cutoff has already gone by.
 *
 * Nothing bookable can meet it, so the tenant must be told that plainly rather
 * than shown an empty list and left to guess. A job whose deadline passed
 * before anyone offered a time is the case this exists for.
 */
export function isDeadlinePast(
  deadline: SchedulingDeadline,
  now: Date,
): boolean {
  if (deadline.status === "none") return false;
  return now.getTime() >= deadline.endsBefore.getTime();
}

/** What the tenant's page and the confirmation endpoint exchange. */
export type DeadlineNotice = {
  /** ISO date of the cutoff. */
  date: string;
  source: DeadlineSource;
  requestedBy: string | null;
  certificateDueBy: string | null;
  /** The instant an appointment must end at or before, as an ISO string. */
  endsBeforeIso: string;
};

/**
 * The cutoff in a form that can cross to the browser.
 *
 * It is not a secret — the tenant is being asked to respect it — but it is
 * also **not** authorisation: the server re-derives all of this at
 * confirmation and never trusts what comes back.
 */
export function toNotice(deadline: SchedulingDeadline): DeadlineNotice | null {
  if (deadline.status === "none") return null;
  return {
    date: deadline.date,
    source: deadline.source,
    requestedBy: deadline.requestedBy,
    certificateDueBy: deadline.certificateDueBy,
    endsBeforeIso: deadline.endsBefore.toISOString(),
  };
}
