import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Setting and moving a tenant's appointment.
 *
 * The three failures this file exists for, all of them previously invisible to
 * a unit test because there was no test of this module at all:
 *
 * 1. **Rescheduling threw.** `scheduled → scheduled` is not a legal lifecycle
 *    move, `assertTransition` raised, and the route had no `catch` — so every
 *    tenant who changed their mind got HTTP 500 and the words "we could not
 *    confirm that appointment".
 * 2. **Two changes to one job could both land**, because the guarded UPDATE
 *    matched on the status alone and two reschedules both read `scheduled`.
 *    The loser also wrote an activity row and queued an email for an
 *    appointment that was never made.
 * 3. **A 409 from Google was believed.** Google keeps cancelled events under
 *    their ids and this one is reused whenever a job returns to a time it once
 *    held, so "the id is taken" was read as "the appointment is there" and the
 *    job was marked synced against an event nobody would attend.
 */

// ---------------------------------------------------------------------------
// The database, reduced to what these decisions turn on
// ---------------------------------------------------------------------------

type JobRow = {
  id: string;
  reference: string;
  productId: string;
  lifecycleStatus: string;
  appointmentStart: Date | null;
  appointmentEnd: Date | null;
  agentOrganisationId: string | null;
  propertyId: string;
  calendarEventId: string | null;
  calendarPreviousEventId: string | null;
  calendarSyncState: string;
  deadlineExceptionAt: Date | null;
  updatedAt: Date;
};

const PROPERTY = {
  id: "property-1",
  houseOrName: "12",
  street: "Example Street",
  town: "Wolverhampton",
  postcode: "WV1 1AA",
  accessNotes: null,
};

let job: JobRow;
/** Values another request wrote between this one's read and its write. */
let interleave: (() => void) | null = null;
let inserts: { table: string; row: Record<string, unknown> }[] = [];
/** `appointment.rescheduled` rows the job already carries. */
let history: { detail: Record<string, unknown> }[] = [];
let batches: number = 0;
let updateFails = false;
/** The database refuses the write that records a successful calendar sync. */
let failAcknowledgement = false;

function baseJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    reference: "BSCJ-FX0001",
    productId: "cp12",
    lifecycleStatus: "tenant_outreach",
    appointmentStart: null,
    appointmentEnd: null,
    agentOrganisationId: "org-1",
    propertyId: PROPERTY.id,
    calendarEventId: null,
    calendarPreviousEventId: null,
    calendarSyncState: "not_required",
    deadlineExceptionAt: null,
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * Captures the predicate an UPDATE was guarded with.
 *
 * Drizzle's `and(...)` is opaque, so the guard is re-stated by the fake from
 * what the module read. That is fair here because the question these tests ask
 * is *whether the module re-reads and compares at all* — the SQL itself is
 * exercised for real by the live concurrency run recorded in the handoff,
 * where two simultaneous confirmations produced one appointment.
 */
/** Drizzle keeps the SQL name on a symbol; the fake only needs a label. */
function nameOf(table: unknown): string {
  const symbol = Object.getOwnPropertySymbols(table as object).find((s) =>
    String(s).includes("Name"),
  );
  return symbol
    ? String((table as Record<symbol, unknown>)[symbol])
    : "unknown";
}

function makeDb() {
  return {
    select() {
      return {
        from(table: unknown) {
          // The timeline is read by `orphanedEventIdsForJob`; everything else
          // in this module reads the job.
          const isActivity = nameOf(table) === "activity";

          const rows = () =>
            isActivity
              ? history.map((entry) => ({ detail: entry.detail }))
              : [
                  {
                    ...job,
                    // `cleanupSupersededEvent` selects this column under a
                    // shorter name; the fake answers to both spellings.
                    previousEventId: job.calendarPreviousEventId,
                    job: { ...job },
                    property: PROPERTY,
                  },
                ];

          const chain = {
            innerJoin: () => chain,
            leftJoin: () => chain,
            where: () => chain,
            limit: async () => rows(),
            then: (resolve: (value: unknown) => void) =>
              Promise.resolve(rows()).then(resolve),
          };
          return chain;
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          const guardedBy = { status: job.lifecycleStatus, start: job.appointmentStart };
          const chain = {
            where: () => chain,
            returning: async () => {
              if (updateFails) throw new Error("write refused");
              if (
                failAcknowledgement &&
                values.calendarSyncState === "synced"
              ) {
                // The event is in Google; Postgres will not say so.
                throw new Error("connection lost after the calendar write");
              }
              // Whatever a racing request did, it did it here.
              interleave?.();
              interleave = null;

              const matches =
                job.lifecycleStatus === guardedBy.status &&
                (guardedBy.start === null
                  ? job.appointmentStart === null
                  : job.appointmentStart?.getTime() ===
                    guardedBy.start.getTime());

              if (!matches) return [];
              Object.assign(job, values);
              return [{ id: job.id }];
            },
            then: (resolve: (value: unknown) => void) => {
              Object.assign(job, values);
              return Promise.resolve([]).then(resolve);
            },
          };
          return chain;
        },
      };
    },
    insert(table: unknown) {
      const name = nameOf(table);
      return {
        values(row: Record<string, unknown>) {
          const statement = {
            table: name,
            row,
            onConflictDoNothing: () => statement,
            run: () => inserts.push({ table: name, row }),
            returning: async () => {
              inserts.push({ table: name, row });
              return [{ id: `${name}-id` }];
            },
            then: (resolve: (value: unknown) => void) => {
              inserts.push({ table: name, row });
              return Promise.resolve(undefined).then(resolve);
            },
          };
          return statement;
        },
      };
    },
    async batch(statements: { run: () => void }[]) {
      batches += 1;
      for (const statement of statements) statement.run();
      return [];
    },
  };
}

mock.module("@/lib/db/client", {
  namedExports: { getDb: () => makeDb() },
});

// ---------------------------------------------------------------------------
// Google, reduced to what these decisions turn on
// ---------------------------------------------------------------------------

type FakeEvent = {
  id: string;
  status: string;
  start: Date | null;
  end: Date | null;
  isBooking: boolean;
};

let events = new Map<string, FakeEvent>();
let calendarCalls: string[] = [];
let createThrows: "duplicate" | "api" | null = null;
let deleteThrows = false;

class DuplicateBookingError extends Error {}

mock.module("@/lib/google/calendar", {
  namedExports: {
    DuplicateBookingError,
    CalendarApiError: class CalendarApiError extends Error {},
    CalendarNotConfiguredError: class extends Error {},
    fetchBusyPeriods: async () => [],
    fetchBookingEvents: async () => [],
    createEvent: async (input: { eventId: string; start: Date; end: Date }) => {
      calendarCalls.push(`create:${input.eventId}`);
      if (createThrows === "duplicate") throw new DuplicateBookingError();
      if (createThrows === "api") throw new Error("google is down");
      if (events.has(input.eventId)) throw new DuplicateBookingError();
      events.set(input.eventId, {
        id: input.eventId,
        status: "confirmed",
        start: input.start,
        end: input.end,
        isBooking: true,
      });
      return { id: input.eventId };
    },
    fetchEvent: async (id: string) => {
      calendarCalls.push(`fetch:${id}`);
      return events.get(id) ?? null;
    },
    replaceEvent: async (input: { eventId: string; start: Date; end: Date }) => {
      calendarCalls.push(`replace:${input.eventId}`);
      events.set(input.eventId, {
        id: input.eventId,
        status: "confirmed",
        start: input.start,
        end: input.end,
        isBooking: true,
      });
      return "replaced";
    },
    deleteEvent: async (id: string) => {
      calendarCalls.push(`delete:${id}`);
      if (deleteThrows) throw new Error("google is down");
      events.delete(id);
      return "deleted";
    },
    eventMatchesAppointment: (
      snapshot: FakeEvent,
      expected: { start: Date; end: Date },
    ) =>
      snapshot.status !== "cancelled" &&
      snapshot.isBooking &&
      snapshot.start?.getTime() === expected.start.getTime() &&
      snapshot.end?.getTime() === expected.end.getTime(),
  },
});

mock.module("@/lib/booking/holds", {
  namedExports: {
    checkHold: async () => ({ status: "valid", secondsRemaining: 900 }),
    releaseHold: async () => true,
  },
});

mock.module("@/lib/booking/daily-limit", {
  namedExports: {
    acquireDailyBookingLock: async () => ({ status: "acquired", token: "t" }),
    releaseDailyBookingLock: async () => true,
  },
});

mock.module("@/lib/booking/reservations", {
  namedExports: {
    fetchUnsyncedReservations: async () => ({ status: "ok", reservations: [] }),
  },
});

/** The two dates a cutoff is made of, as the confirmation re-reads them. */
let jobDeadline: { requestedBy: string | null; certificateDueBy: string | null } = {
  requestedBy: null,
  certificateDueBy: null,
};

mock.module("./deadline-lookup", {
  namedExports: {
    fetchJobDeadline: async () => {
      const { resolveDeadline } = await import("./deadline");
      return {
        deadline: resolveDeadline(jobDeadline, "Europe/London"),
        complianceCycleId: null,
      };
    },
  },
});

let cancelledNotifications = 0;

mock.module("@/lib/notifications/outbox", {
  namedExports: {
    DEADLINE_EXCEPTION_KIND: "appointment.deadline_exception",
    lateBookingRows: (input: { jobId: string; appointmentStart: Date }) =>
      ["agent", "bscj"].map((recipient) => ({
        jobId: input.jobId,
        kind: "late-booking-exception",
        recipient,
        idempotencyKey: `late-booking-exception:${input.jobId}:${input.appointmentStart.toISOString()}:${recipient}`,
      })),
    cancelSupersededNotifications: async () => {
      cancelledNotifications += 1;
      return 0;
    },
  },
});

mock.module("@/lib/booking/slots", {
  namedExports: {
    countBookingsByDate: () => new Map(),
    isDayFullyBooked: () => false,
    isSlotStillAvailable: () => true,
  },
});

const {
  calendarEventIdForJob,
  cleanupSupersededEvent,
  confirmTenantAppointment,
  orphanedEventIdsForJob,
  syncJobToCalendar,
  withoutOwnAppointment,
} = await import("./confirm");

/** A weekday well inside the booking window, at a configured start time. */
const SLOT_A = "2026-10-05T09:00:00.000Z";
const SLOT_B = "2026-10-06T10:00:00.000Z";

function endOf(slot: string, minutes = 45): Date {
  return new Date(new Date(slot).getTime() + minutes * 60000);
}

beforeEach(() => {
  job = baseJob();
  jobDeadline = { requestedBy: null, certificateDueBy: null };
  cancelledNotifications = 0;
  interleave = null;
  inserts = [];
  history = [];
  batches = 0;
  updateFails = false;
  failAcknowledgement = false;
  events = new Map();
  calendarCalls = [];
  createThrows = null;
  deleteThrows = false;
});

// ---------------------------------------------------------------------------

describe("initial scheduling", () => {
  test("a job awaiting its tenant becomes scheduled", async () => {
    const result = await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
    });

    assert.equal(result.status, "confirmed");
    assert.equal((result as { mode: string }).mode, "initial");
    assert.equal(job.lifecycleStatus, "scheduled");
    assert.equal(job.calendarSyncState, "pending");
    assert.equal(
      job.calendarPreviousEventId,
      null,
      "an initial booking supersedes nothing",
    );
  });

  test("the timeline entry and the queued email are written together", async () => {
    await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
    });

    assert.equal(batches, 1, "they were not written in one transaction");
    assert.equal(
      inserts.find((i) => i.table === "activity")?.row.kind,
      "appointment.scheduled",
    );
    assert.ok(inserts.find((i) => i.table === "outbound_email"));
  });

  test("a status the tenant may not act from is refused as a value, not a throw", async () => {
    for (const status of ["completed", "cancelled", "in_progress", "draft"]) {
      job = baseJob({ lifecycleStatus: status });
      const result = await confirmTenantAppointment({
        jobId: "job-1",
        slotStart: SLOT_A,
        holdToken: "a".repeat(64),
      });
      assert.equal(result.status, "not_schedulable", status);
    }
  });
});

describe("rescheduling", () => {
  test("a booked tenant can move to a different time", async () => {
    /*
      This is the 500. `assertTransition(scheduled, scheduled)` threw out of a
      route with no catch, so the answer to "I'd like a different day" was a
      server error.
    */
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarEventId: "old-event",
      calendarSyncState: "synced",
    });

    const result = await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_B,
      holdToken: "a".repeat(64),
    });

    assert.equal(result.status, "confirmed");
    assert.equal((result as { mode: string }).mode, "reschedule");
    assert.equal(job.appointmentStart?.toISOString(), SLOT_B);
  });

  test("the superseded event is recorded on the row by the same write", async () => {
    // Committed with the move, so a process that dies on the next line leaves
    // work that can be found rather than a phantom entry in the diary.
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarEventId: "old-event",
      calendarSyncState: "synced",
    });

    await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_B,
      holdToken: "a".repeat(64),
    });

    assert.equal(job.calendarPreviousEventId, "old-event");
    assert.equal(
      job.calendarEventId,
      null,
      "the old event is no longer this job's event",
    );
    assert.equal(job.calendarSyncState, "pending");
  });

  test("it is recorded as a reschedule, with where it moved from", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarEventId: "old-event",
      calendarSyncState: "synced",
    });

    await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_B,
      holdToken: "a".repeat(64),
    });

    const activity = inserts.find((i) => i.table === "activity")!;
    assert.equal(activity.row.kind, "appointment.rescheduled");
    assert.equal(
      (activity.row.detail as Record<string, string>).previousStart,
      new Date(SLOT_A).toISOString(),
    );
  });

  test("re-confirming the same time is idempotent, not a second move", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarEventId: "old-event",
      calendarSyncState: "synced",
    });

    const result = await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
    });

    assert.equal(result.status, "already");
    assert.equal(job.calendarEventId, "old-event", "the event was disturbed");
    assert.deepEqual(inserts, [], "a retry wrote to the timeline");
  });
});

describe("two changes to one job cannot both succeed", () => {
  test("the loser is told the job moved, not that the slot was taken", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarEventId: "old-event",
      calendarSyncState: "synced",
    });

    // Somebody else moves the job between this request's read and its write.
    interleave = () => {
      job.appointmentStart = new Date("2026-10-07T09:00:00.000Z");
      job.appointmentEnd = endOf("2026-10-07T09:00:00.000Z");
    };

    const result = await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_B,
      holdToken: "a".repeat(64),
    });

    assert.equal(
      result.status,
      "conflict",
      "a job that moved was reported as a slot someone else had taken",
    );
  });

  test("the loser writes no activity and queues no email", async () => {
    /*
      The requirement in its own words: a conditional update that loses a race
      must not still commit its activity or outbound-email records. It used to,
      because both inserts ran regardless of how many rows the UPDATE matched.
    */
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarEventId: "old-event",
      calendarSyncState: "synced",
    });

    interleave = () => {
      job.appointmentStart = new Date("2026-10-07T09:00:00.000Z");
    };

    await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_B,
      holdToken: "a".repeat(64),
    });

    assert.deepEqual(inserts, []);
    assert.equal(batches, 0);
  });

  test("a loser whose winner chose the same time is told 'already'", async () => {
    // Two tabs, one tenant, one time. Not a conflict — the outcome they asked
    // for is the outcome they got.
    job = baseJob({ lifecycleStatus: "awaiting_tenant" });

    interleave = () => {
      job.lifecycleStatus = "scheduled";
      job.appointmentStart = new Date(SLOT_A);
      job.appointmentEnd = endOf(SLOT_A);
    };

    const result = await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
    });

    assert.equal(result.status, "already");
    assert.deepEqual(inserts, []);
  });
});

describe("a caller is not blocked by its own appointment", () => {
  test("its own block is removed from the busy periods", () => {
    const own = { start: new Date(SLOT_A), end: endOf(SLOT_A) };
    const other = {
      start: new Date("2026-10-05T12:00:00.000Z"),
      end: new Date("2026-10-05T12:45:00.000Z"),
    };

    assert.deepEqual(withoutOwnAppointment([own, other], own), [other]);
    assert.deepEqual(withoutOwnAppointment([own, other], null), [own, other]);
  });
});

describe("a 409 from Google is verified, never believed", () => {
  test("an existing event that matches the appointment is success", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarSyncState: "pending",
    });
    const eventId = calendarEventIdForJob("job-1", SLOT_A);
    events.set(eventId, {
      id: eventId,
      status: "confirmed",
      start: new Date(SLOT_A),
      end: endOf(SLOT_A),
      isBooking: true,
    });
    createThrows = "duplicate";

    assert.equal(await syncJobToCalendar("job-1"), "synced");
    assert.ok(calendarCalls.includes(`fetch:${eventId}`), "it did not look");
    assert.equal(
      calendarCalls.filter((c) => c.startsWith("replace:")).length,
      0,
      "a matching event was rewritten for no reason",
    );
  });

  test("a CANCELLED event under the same id is overwritten, not called synced", async () => {
    /*
      The defect. Google keeps a cancelled event under its id, and this id is
      reused whenever a job returns to a time it once held — so the job would
      have been marked synced against an appointment nobody would attend.
    */
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarSyncState: "pending",
    });
    const eventId = calendarEventIdForJob("job-1", SLOT_A);
    events.set(eventId, {
      id: eventId,
      status: "cancelled",
      start: new Date(SLOT_A),
      end: endOf(SLOT_A),
      isBooking: true,
    });
    createThrows = "duplicate";

    assert.equal(await syncJobToCalendar("job-1"), "synced");
    assert.ok(
      calendarCalls.includes(`replace:${eventId}`),
      "a cancelled event was accepted as the appointment",
    );
    assert.equal(events.get(eventId)?.status, "confirmed");
  });

  test("an event at a different time under the same id is overwritten", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarSyncState: "pending",
    });
    const eventId = calendarEventIdForJob("job-1", SLOT_A);
    events.set(eventId, {
      id: eventId,
      status: "confirmed",
      start: new Date(SLOT_B),
      end: endOf(SLOT_B),
      isBooking: true,
    });
    createThrows = "duplicate";

    assert.equal(await syncJobToCalendar("job-1"), "synced");
    assert.ok(calendarCalls.includes(`replace:${eventId}`));
    assert.equal(events.get(eventId)?.start?.toISOString(), SLOT_A);
  });

  test("an ambiguous failure is recorded as failed, not guessed at", async () => {
    // A timeout where the event may or may not have been created. `failed` is
    // the honest state for "we do not know", and the retry resolves it.
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarSyncState: "pending",
    });
    createThrows = "api";

    assert.equal(await syncJobToCalendar("job-1"), "failed");
    assert.equal(job.calendarSyncState, "failed");
  });
});

describe("a stale sync cannot restore an obsolete appointment", () => {
  test("a sync that finishes after the job moved reports superseded", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarSyncState: "pending",
    });

    // The tenant moves again while the calendar write is in flight.
    interleave = () => {
      job.appointmentStart = new Date(SLOT_B);
      job.appointmentEnd = endOf(SLOT_B);
    };

    const outcome = await syncJobToCalendar("job-1");

    assert.equal(outcome, "superseded");
    assert.notEqual(
      job.calendarSyncState,
      "synced",
      "an obsolete appointment was stamped onto the newer one",
    );
  });

  test("the event a superseded sync wrote is removed again", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarSyncState: "pending",
    });
    const staleId = calendarEventIdForJob("job-1", SLOT_A);

    interleave = () => {
      job.appointmentStart = new Date(SLOT_B);
      job.appointmentEnd = endOf(SLOT_B);
    };

    await syncJobToCalendar("job-1");

    assert.ok(
      calendarCalls.includes(`delete:${staleId}`),
      "the stale event was left in the diary",
    );
  });

  test("an event id left over from an earlier time does not count as synced", async () => {
    // `synced` plus a stale id is not the same fact as `synced` for this
    // appointment, and short-circuiting on the state alone would skip the write.
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarEventId: "an-id-from-an-earlier-time",
      calendarSyncState: "synced",
    });

    assert.equal(await syncJobToCalendar("job-1"), "synced");
    assert.equal(job.calendarEventId, calendarEventIdForJob("job-1", SLOT_A));
  });
});

describe("the original booking is never lost to a failed replacement", () => {
  test("cleanup does nothing while the replacement is not confirmed present", async () => {
    /*
      The sequence's whole point. Until the new event exists, the old one is
      the only appointment the engineer can see — deleting it would turn a
      recoverable inconsistency into a visit nobody knows about.
    */
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_B),
      appointmentEnd: endOf(SLOT_B),
      calendarEventId: null,
      calendarPreviousEventId: "old-event",
      calendarSyncState: "failed",
    });

    assert.equal(await cleanupSupersededEvent("job-1"), "nothing_to_do");
    assert.equal(
      calendarCalls.filter((c) => c.startsWith("delete:")).length,
      0,
      "the only surviving appointment was deleted",
    );
    assert.equal(
      job.calendarPreviousEventId,
      "old-event",
      "the outstanding work was forgotten",
    );
  });

  test("once the replacement exists, the old event goes and the row is cleared", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_B),
      appointmentEnd: endOf(SLOT_B),
      calendarEventId: "new-event",
      calendarPreviousEventId: "old-event",
      calendarSyncState: "synced",
    });

    assert.equal(await cleanupSupersededEvent("job-1"), "cleaned");
    assert.ok(calendarCalls.includes("delete:old-event"));
    assert.equal(job.calendarPreviousEventId, null);
  });

  test("a cleanup Google refuses stays on the queue", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_B),
      appointmentEnd: endOf(SLOT_B),
      calendarEventId: "new-event",
      calendarPreviousEventId: "old-event",
      calendarSyncState: "synced",
    });
    deleteThrows = true;

    assert.equal(await cleanupSupersededEvent("job-1"), "failed");
    assert.equal(
      job.calendarPreviousEventId,
      "old-event",
      "an unfinished cleanup was marked done",
    );
  });

  test("it never deletes the live appointment, whatever the columns say", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_B),
      appointmentEnd: endOf(SLOT_B),
      calendarEventId: "same-event",
      calendarPreviousEventId: "same-event",
      calendarSyncState: "synced",
    });

    assert.equal(await cleanupSupersededEvent("job-1"), "cleaned");
    assert.equal(
      calendarCalls.filter((c) => c.startsWith("delete:")).length,
      0,
      "the live appointment was deleted",
    );
    assert.equal(job.calendarPreviousEventId, null);
  });

  test("nothing outstanding is a no-op", async () => {
    job = baseJob({ calendarPreviousEventId: null });
    assert.equal(await cleanupSupersededEvent("job-1"), "nothing_to_do");
  });
});

describe("the calendar wrote but the database would not acknowledge it", () => {
  test("the failure is a value the caller can act on, never a throw", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarSyncState: "pending",
    });
    failAcknowledgement = true;

    const { reconcileJobCalendar } = await import("./confirm");
    const outcome = await reconcileJobCalendar("job-1");

    assert.equal(outcome.sync, "failed");
  });

  test("the row stays on the reconciliation queue, so the slot stays reserved", async () => {
    /*
      The state that matters. `pending` is what `reservations.ts` reads to keep
      the slot out of everybody else's availability, and it is also what the
      sweep reads to finish the job. Nothing is lost — the appointment is in
      the calendar and the row still says the work is outstanding.
    */
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarSyncState: "pending",
    });
    failAcknowledgement = true;

    const { reconcileJobCalendar } = await import("./confirm");
    await reconcileJobCalendar("job-1");

    assert.ok(
      ["pending", "failed"].includes(job.calendarSyncState),
      `the job left the queue as ${job.calendarSyncState}`,
    );
    assert.ok(
      events.has(calendarEventIdForJob("job-1", SLOT_A)),
      "the appointment itself was lost",
    );
  });

  test("the retry finds its own event, verifies it, and settles", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarSyncState: "pending",
    });
    failAcknowledgement = true;
    await syncJobToCalendar("job-1");

    // The database comes back.
    failAcknowledgement = false;
    calendarCalls = [];
    const outcome = await syncJobToCalendar("job-1");

    assert.equal(outcome, "synced");
    assert.equal(job.calendarSyncState, "synced");
    assert.equal(job.calendarEventId, calendarEventIdForJob("job-1", SLOT_A));
    assert.equal(
      events.size,
      1,
      "the retry created a second appointment for the same job",
    );
  });
});


describe("no event outlives the appointment it belonged to", () => {
  const SLOT_C = "2026-10-07T11:00:00.000Z";

  test("a superseded event is recoverable from the timeline alone", async () => {
    /*
      `calendar_previous_event_id` holds one id. Two moves in a row while
      Google is unreachable overwrite the first, and the event it named would
      otherwise sit in the engineer's diary forever with nothing pointing at
      it.

      It does not need to be stored: an event id is a pure function of the job
      and the slot, and every slot the job has left is on its own timeline.
    */
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_C),
      appointmentEnd: endOf(SLOT_C),
      calendarEventId: calendarEventIdForJob("job-1", SLOT_C),
      calendarSyncState: "synced",
      // Only the most recent move survived in the column.
      calendarPreviousEventId: calendarEventIdForJob("job-1", SLOT_B),
    });
    history = [
      { detail: { previousStart: SLOT_A } },
      { detail: { previousStart: SLOT_B } },
    ];

    const orphans = await orphanedEventIdsForJob("job-1");

    assert.ok(
      orphans.includes(calendarEventIdForJob("job-1", SLOT_A)),
      "the id the column could not hold was unrecoverable",
    );
    assert.ok(orphans.includes(calendarEventIdForJob("job-1", SLOT_B)));
  });

  test("A to B and back to A never proposes deleting the live event", async () => {
    /*
      The id is derived from the slot, so returning to a time reuses the id the
      job held there before. A sweep that deleted every historical id would
      delete the appointment the tenant is actually waiting for.
    */
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarEventId: calendarEventIdForJob("job-1", SLOT_A),
      calendarSyncState: "synced",
    });
    history = [
      { detail: { previousStart: SLOT_A } },
      { detail: { previousStart: SLOT_B } },
    ];

    const orphans = await orphanedEventIdsForJob("job-1");

    assert.equal(
      orphans.includes(calendarEventIdForJob("job-1", SLOT_A)),
      false,
      "the live appointment was listed for deletion",
    );
    assert.deepEqual(orphans, [calendarEventIdForJob("job-1", SLOT_B)]);
  });

  test("the current event id is spared even if the appointment column disagrees", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_C),
      appointmentEnd: endOf(SLOT_C),
      // A stale pointer, as a half-finished sync would leave.
      calendarEventId: calendarEventIdForJob("job-1", SLOT_B),
      calendarSyncState: "pending",
    });
    history = [{ detail: { previousStart: SLOT_B } }];

    const orphans = await orphanedEventIdsForJob("job-1");
    assert.deepEqual(orphans, [], "an event the row still points at was listed");
  });

  test("a malformed timeline entry is skipped, not guessed at", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_C),
      appointmentEnd: endOf(SLOT_C),
      calendarEventId: calendarEventIdForJob("job-1", SLOT_C),
      calendarSyncState: "synced",
    });
    history = [
      { detail: { previousStart: "not a date" } },
      { detail: {} },
      { detail: { previousStart: 12345 } },
    ];

    assert.deepEqual(await orphanedEventIdsForJob("job-1"), []);
  });

  test("a job with no history has nothing to clean", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarSyncState: "synced",
    });
    history = [];
    assert.deepEqual(await orphanedEventIdsForJob("job-1"), []);
  });
});

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

/** SLOT_A falls on 2026-10-05 and SLOT_B on 2026-10-06. */
const BEFORE_A = "2026-10-04";
const ON_A = "2026-10-05";
/** Later than either, for moving *back* into the deadline. */
const LATER_SLOT = "2026-10-07T11:00:00.000Z";

describe("a slot that meets the deadline books normally", () => {
  test("an appointment finishing on the deadline date is ordinary", async () => {
    jobDeadline = { requestedBy: ON_A, certificateDueBy: null };

    const result = await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
    });

    assert.equal(result.status, "confirmed");
    assert.equal(job.deadlineExceptionAt, null, "an on-time booking was flagged");
    assert.equal(
      inserts.some((i) => i.row.kind === "appointment.deadline_exception"),
      false,
    );
    assert.equal(
      inserts.some((i) => i.table === "outbound_email" && i.row.recipient === "agent"),
      false,
      "an on-time booking queued a late-booking alert",
    );
  });

  test("no deadline at all books normally", async () => {
    jobDeadline = { requestedBy: null, certificateDueBy: null };

    const result = await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
    });

    assert.equal(result.status, "confirmed");
    assert.equal(job.deadlineExceptionAt, null);
  });
});

describe("a slot after the deadline is refused until it is accepted", () => {
  test("without acknowledgement it is refused, and nothing is written", async () => {
    jobDeadline = { requestedBy: BEFORE_A, certificateDueBy: null };

    const result = await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
    });

    assert.equal(result.status, "deadline_exceeded");
    assert.equal(job.lifecycleStatus, "tenant_outreach", "the job was moved");
    assert.deepEqual(inserts, [], "a refused booking wrote to the timeline");
  });

  test("the refusal names the cutoff and keeps both dates", async () => {
    jobDeadline = { requestedBy: BEFORE_A, certificateDueBy: "2026-12-01" };

    const result = (await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
    })) as { deadline: Record<string, unknown>; overdue: boolean };

    assert.equal(result.deadline.date, BEFORE_A);
    assert.equal(result.deadline.source, "requested");
    assert.equal(result.deadline.requestedBy, BEFORE_A);
    assert.equal(result.deadline.certificateDueBy, "2026-12-01");
  });

  test("an already-passed deadline is reported as overdue", async () => {
    // Nothing bookable can meet it, so the tenant must be told that plainly
    // rather than shown an empty list.
    jobDeadline = { requestedBy: "2020-01-01", certificateDueBy: null };

    const result = (await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
    })) as { status: string; overdue: boolean };

    assert.equal(result.status, "deadline_exceeded");
    assert.equal(result.overdue, true);
  });

  test("with acknowledgement it books, and is recorded as late", async () => {
    jobDeadline = { requestedBy: BEFORE_A, certificateDueBy: null };

    const result = await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
      acknowledgedLateBooking: true,
    });

    assert.equal(result.status, "confirmed");
    assert.ok(job.deadlineExceptionAt, "the exception flag was not set");

    const exception = inserts.find(
      (i) => i.row.kind === "appointment.deadline_exception",
    );
    assert.ok(exception, "no exception was recorded");
    const detail = exception.row.detail as Record<string, unknown>;
    assert.equal(detail.deadlineDate, BEFORE_A);
    assert.equal(detail.requestedBy, BEFORE_A);
    assert.equal(detail.appointmentStart, SLOT_A);
    assert.ok(detail.acknowledgedAt, "the acknowledgement was not recorded");
  });

  test("the deadline is never moved to fit the appointment", async () => {
    /*
      The rule that matters most. A late booking records that it is late; it
      must never rewrite the date it missed, and it must never extend the
      certificate.
    */
    jobDeadline = { requestedBy: BEFORE_A, certificateDueBy: "2026-10-04" };

    await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
      acknowledgedLateBooking: true,
    });

    const detail = inserts.find(
      (i) => i.row.kind === "appointment.deadline_exception",
    )!.row.detail as Record<string, unknown>;

    assert.equal(detail.deadlineDate, BEFORE_A);
    assert.equal(detail.certificateDueBy, "2026-10-04");
    assert.equal(
      Object.prototype.hasOwnProperty.call(job, "completeByDate") &&
        (job as Record<string, unknown>).completeByDate !== undefined,
      false,
      "the confirmation wrote to the requested completion date",
    );
  });

  test("both recipients are queued, in the same transaction", async () => {
    jobDeadline = { requestedBy: BEFORE_A, certificateDueBy: null };

    await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
      acknowledgedLateBooking: true,
    });

    const alerts = inserts.filter(
      (i) => i.table === "outbound_email" && i.row.kind === "late-booking-exception",
    );
    assert.deepEqual(
      alerts.map((a) => a.row.recipient).sort(),
      ["agent", "bscj"],
    );
    assert.equal(batches, 1, "the alerts were not written with the appointment");
  });
});

describe("a tampered acknowledgement cannot hide a late booking", () => {
  test("claiming acknowledgement books late AND records it as late", async () => {
    /*
      The flag only ever *permits*. The cutoff is re-read from the database
      here and the exception is written here, so forging the flag books an
      appointment that is recorded, flagged and notified exactly as if the
      tenant had ticked the box. What it cannot do is make the booking look
      on-time.
    */
    jobDeadline = { requestedBy: BEFORE_A, certificateDueBy: null };

    await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
      acknowledgedLateBooking: true,
    });

    assert.ok(job.deadlineExceptionAt);
    assert.ok(
      inserts.some((i) => i.row.kind === "appointment.deadline_exception"),
    );
    assert.equal(
      inserts.filter((i) => i.row.kind === "late-booking-exception").length,
      2,
      "a forged acknowledgement skipped the notifications",
    );
  });

  test("a slot the browser was told was fine is re-judged here", async () => {
    /*
      The page filtered against a cutoff it read when it rendered. If the agent
      moved the date in between, the browser's view is stale — and this is the
      decision, not that view.
    */
    jobDeadline = { requestedBy: "2026-12-31", certificateDueBy: null };
    const beforeChange = await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
    });
    assert.equal(beforeChange.status, "confirmed");

    // The agent brings the date forward, past the appointment already taken.
    job = baseJob();
    inserts = [];
    jobDeadline = { requestedBy: BEFORE_A, certificateDueBy: null };

    const afterChange = await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
    });
    assert.equal(afterChange.status, "deadline_exceeded");
  });
});

describe("rescheduling and the exception flag", () => {
  test("moving from a late slot into a compliant one clears the flag", async () => {
    /*
      The tenant has fixed the problem. Leaving the flag up would keep the job
      on the needs-attention list forever for something that is no longer true
      — while the exception's own timeline entry stays, so the history is not
      rewritten.
    */
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(LATER_SLOT),
      appointmentEnd: endOf(LATER_SLOT),
      calendarEventId: "old-event",
      calendarSyncState: "synced",
      deadlineExceptionAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    jobDeadline = { requestedBy: ON_A, certificateDueBy: null };

    const result = await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_A,
      holdToken: "a".repeat(64),
    });

    assert.equal(result.status, "confirmed");
    assert.equal(job.deadlineExceptionAt, null, "the flag was left up");
  });

  test("moving from one late slot to another re-records the exception", async () => {
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarEventId: "old-event",
      calendarSyncState: "synced",
      deadlineExceptionAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    jobDeadline = { requestedBy: BEFORE_A, certificateDueBy: null };

    await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_B,
      holdToken: "a".repeat(64),
      acknowledgedLateBooking: true,
    });

    const detail = inserts.find(
      (i) => i.row.kind === "appointment.deadline_exception",
    )!.row.detail as Record<string, unknown>;
    assert.equal(
      detail.appointmentStart,
      SLOT_B,
      "the exception still described the old appointment",
    );
  });

  test("a move stands down alerts queued for the time it left", async () => {
    // A queued alert describes a visit that is no longer happening.
    job = baseJob({
      lifecycleStatus: "scheduled",
      appointmentStart: new Date(SLOT_A),
      appointmentEnd: endOf(SLOT_A),
      calendarEventId: "old-event",
      calendarSyncState: "synced",
    });
    jobDeadline = { requestedBy: null, certificateDueBy: null };

    await confirmTenantAppointment({
      jobId: "job-1",
      slotStart: SLOT_B,
      holdToken: "a".repeat(64),
    });

    assert.equal(cancelledNotifications, 1);
  });
});
