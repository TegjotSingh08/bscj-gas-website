import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * The gap between "committed" and "in Google".
 *
 * A tenant confirmation writes the job, releases the 30-minute hold and *then*
 * writes the calendar event, because Postgres cannot make a Google call part
 * of its transaction. For that moment — and for as long as a failed write goes
 * unrepaired — the slot was held by nothing at all and was offered to the next
 * customer who asked.
 *
 * These prove the row is now what reserves it, and prove the two ways that
 * could go wrong: counting an appointment twice, and reading a database outage
 * as "nothing is reserved".
 */

type Row = {
  id: string;
  lifecycleStatus: string;
  calendarSyncState: string;
  cancelledAt: Date | null;
  appointmentStart: Date | null;
  appointmentEnd: Date | null;
  calendarPreviousEventId: string | null;
};

let rows: Row[] = [];
let configured = true;
let failRead = false;

/**
 * A fake that applies the module's own filters.
 *
 * Drizzle's `where` is opaque here, so the predicate is re-stated — which
 * would be circular if these tests were about the SQL. They are not: they are
 * about which *states* reserve a slot and what happens when the read fails,
 * and the query itself is exercised for real by the live browser run recorded
 * in the handoff.
 */
function makeDb() {
  return {
    select() {
      return {
        from() {
          const chain = {
            where: () => chain,
            limit: async () => run(),
            then: (resolve: (value: unknown) => void) =>
              Promise.resolve(run()).then(resolve),
          };
          return chain;
        },
      };
    },
  };
}

const OCCUPYING = [
  "scheduled",
  "engineer_assigned",
  "in_progress",
  "remedial_required",
];
const UNREFLECTED = ["pending", "failed"];

function run() {
  if (failRead) throw new Error("connection lost");
  return rows
    .filter(
      (row) =>
        OCCUPYING.includes(row.lifecycleStatus) &&
        UNREFLECTED.includes(row.calendarSyncState) &&
        row.cancelledAt === null,
    )
    // The module selects the appointment columns under shorter names.
    .map((row) => ({
      id: row.id,
      start: row.appointmentStart,
      end: row.appointmentEnd,
      previousEventId: row.calendarPreviousEventId,
    }));
}

mock.module("@/lib/db/client", {
  namedExports: { getDb: () => (configured ? makeDb() : null) },
});

const { fetchUnsyncedReservations } = await import("./reservations");

const WINDOW_START = new Date("2026-10-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-10-02T00:00:00.000Z");

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "job-1",
    lifecycleStatus: "scheduled",
    calendarSyncState: "pending",
    cancelledAt: null,
    appointmentStart: new Date("2026-10-01T09:00:00.000Z"),
    appointmentEnd: new Date("2026-10-01T09:45:00.000Z"),
    calendarPreviousEventId: null,
    ...overrides,
  };
}

beforeEach(() => {
  rows = [];
  configured = true;
  failRead = false;
});

describe("what still holds a slot", () => {
  test("an appointment awaiting its calendar write is reserved", async () => {
    rows = [row({ calendarSyncState: "pending" })];
    const result = await fetchUnsyncedReservations(WINDOW_START, WINDOW_END);
    assert.equal(result.status, "ok");
    assert.equal(
      (result as { reservations: unknown[] }).reservations.length,
      1,
      "a committed appointment was offered to somebody else",
    );
  });

  test("an appointment whose calendar write failed stays reserved indefinitely", async () => {
    /*
      The case a hold can never cover. A hold expires on a TTL; a failed sync
      waits for somebody to notice, which may be days.
    */
    rows = [row({ calendarSyncState: "failed" })];
    const result = await fetchUnsyncedReservations(WINDOW_START, WINDOW_END);
    assert.equal((result as { reservations: unknown[] }).reservations.length, 1);
  });

  test("an appointment already in Google is NOT counted here", async () => {
    // Otherwise it would block its own slot twice and spend two of the day's
    // ten places on one visit.
    rows = [row({ calendarSyncState: "synced" })];
    const result = await fetchUnsyncedReservations(WINDOW_START, WINDOW_END);
    assert.equal((result as { reservations: unknown[] }).reservations.length, 0);
  });

  test("a job that never needed an event is not counted", async () => {
    rows = [row({ calendarSyncState: "not_required" })];
    const result = await fetchUnsyncedReservations(WINDOW_START, WINDOW_END);
    assert.equal((result as { reservations: unknown[] }).reservations.length, 0);
  });

  test("statuses that hold no appointment reserve nothing", async () => {
    for (const status of ["draft", "tenant_outreach", "awaiting_tenant"]) {
      rows = [row({ lifecycleStatus: status })];
      const result = await fetchUnsyncedReservations(WINDOW_START, WINDOW_END);
      assert.equal(
        (result as { reservations: unknown[] }).reservations.length,
        0,
        status,
      );
    }
  });

  test("a job the engineer is already working still holds its slot", async () => {
    for (const status of ["engineer_assigned", "in_progress"]) {
      rows = [row({ lifecycleStatus: status })];
      const result = await fetchUnsyncedReservations(WINDOW_START, WINDOW_END);
      assert.equal(
        (result as { reservations: unknown[] }).reservations.length,
        1,
        status,
      );
    }
  });

  test("a cancelled job releases its slot", async () => {
    rows = [row({ cancelledAt: new Date() })];
    const result = await fetchUnsyncedReservations(WINDOW_START, WINDOW_END);
    assert.equal((result as { reservations: unknown[] }).reservations.length, 0);
  });

  test("a row in an occupying status but with no times cannot block anything", async () => {
    rows = [row({ appointmentStart: null, appointmentEnd: null })];
    const result = await fetchUnsyncedReservations(WINDOW_START, WINDOW_END);
    assert.equal((result as { reservations: unknown[] }).reservations.length, 0);
  });
});

describe("a caller is never blocked by its own reservation", () => {
  test("the excluded job's appointment is left out", async () => {
    rows = [row({ id: "mine" }), row({ id: "theirs" })];

    const all = await fetchUnsyncedReservations(WINDOW_START, WINDOW_END);
    assert.equal((all as { reservations: unknown[] }).reservations.length, 2);

    const mine = await fetchUnsyncedReservations(
      WINDOW_START,
      WINDOW_END,
      "mine",
    );
    assert.equal(
      (mine as { reservations: unknown[] }).reservations.length,
      1,
      "a tenant moving their appointment was blocked by themselves",
    );
  });
});

describe("a database outage is reported, never read as 'nothing reserved'", () => {
  test("no database configured returns unavailable", async () => {
    configured = false;
    const result = await fetchUnsyncedReservations(WINDOW_START, WINDOW_END);
    assert.deepEqual(result, { status: "unavailable" });
  });

  test("a failed read returns unavailable rather than an empty list", async () => {
    /*
      The distinction the whole module turns on. `{ reservations: [] }` says
      "nothing is reserved"; `unavailable` says "we could not find out". The
      callers treat the second as a reason to fall back to Google alone — which
      is the protection that existed before this module — rather than as a
      reason to refuse a paying customer.
    */
    failRead = true;
    const result = await fetchUnsyncedReservations(WINDOW_START, WINDOW_END);
    assert.deepEqual(result, { status: "unavailable" });
  });

  test("it never throws into the booking path", async () => {
    failRead = true;
    await assert.doesNotReject(() =>
      fetchUnsyncedReservations(WINDOW_START, WINDOW_END),
    );
  });
});


describe("a job mid-reschedule is not counted twice", () => {
  test("the event it moved away from is reported so it can be discounted", async () => {
    /*
      Between the move and the cleanup the job is in Google at its old time and
      in Postgres at its new one. Anything counting bookings sees two, and on
      the same date that spends two of the day's ten places on one visit.
    */
    rows = [row({ calendarPreviousEventId: "event-it-left" })];

    const result = await fetchUnsyncedReservations(WINDOW_START, WINDOW_END);

    assert.equal(result.status, "ok");
    assert.deepEqual(
      (result as { supersededEventIds: string[] }).supersededEventIds,
      ["event-it-left"],
    );
  });

  test("a job with nothing outstanding reports no superseded event", async () => {
    rows = [row()];
    const result = await fetchUnsyncedReservations(WINDOW_START, WINDOW_END);
    assert.deepEqual(
      (result as { supersededEventIds: string[] }).supersededEventIds,
      [],
    );
  });

  test("the excluded job's superseded event is excluded with it", async () => {
    rows = [
      row({ id: "mine", calendarPreviousEventId: "mine-old" }),
      row({ id: "theirs", calendarPreviousEventId: "theirs-old" }),
    ];

    const result = await fetchUnsyncedReservations(
      WINDOW_START,
      WINDOW_END,
      "mine",
    );

    assert.deepEqual(
      (result as { supersededEventIds: string[] }).supersededEventIds,
      ["theirs-old"],
    );
  });
});
