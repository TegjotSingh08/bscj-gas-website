import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * A booking that exists in the calendar but not in the database.
 *
 * The invariant: **an appointment already created in Google must never become
 * a failed booking because our own bookkeeping failed.** The public route is
 * built around it — the calendar write is the point of no return, and every
 * step after it is allowed to fail silently.
 *
 * What was missing was the other half. A failed persistence left no trace that
 * could be acted on, and the duplicate guard refused the retry that might have
 * fixed it — so the booking existed only as an entry in a diary and could not
 * be recovered without asking the customer to book again.
 *
 * The two rules recovery must never break are asserted here as hard as the
 * happy path: **it creates no second calendar event, and it sends nothing.**
 */

type Entry = { value: string; expiresAt: number | null };

let store = new Map<string, Entry>();
let storeFails = false;
/** A failure the store did not label as its own. */
let storeThrowsUnlabelled = false;

const kv = {
  async get(key: string) {
    if (storeThrowsUnlabelled) throw new TypeError("something else went wrong");
    if (storeFails) throw new KvUnavailableError();
    return store.get(key)?.value ?? null;
  },
  async set(key: string, value: string, ttlSeconds: number) {
    if (storeThrowsUnlabelled) throw new TypeError("something else went wrong");
    if (storeFails) throw new KvUnavailableError();
    store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  },
  async setIfAbsent() {
    return true;
  },
  async deleteIfEqual(key: string, value: string) {
    if (storeFails) throw new KvUnavailableError();
    if (store.get(key)?.value !== value) return false;
    store.delete(key);
    return true;
  },
  async ttl() {
    return 60;
  },
  async mget() {
    return [];
  },
  async incrementWithTtl() {
    return 1;
  },
  async scanKeys(pattern: string, limit: number) {
    if (storeFails) throw new KvUnavailableError();
    const prefix = pattern.replace(/\*$/, "");
    return [...store.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
  },
};

class KvUnavailableError extends Error {}

mock.module("@/lib/kv/store", {
  namedExports: {
    KvUnavailableError,
    getKvClient: () => kv,
    isKvConfigured: () => true,
    setKvClientForTesting: () => {},
  },
});

let persistResult: unknown = { status: "created", jobId: "job-1" };
let persistCalls: { idempotencyKey: string }[] = [];

mock.module("./persist-booking", {
  namedExports: {
    persistWebsiteBooking: async (input: { idempotencyKey: string }) => {
      persistCalls.push({ idempotencyKey: input.idempotencyKey });
      return persistResult;
    },
  },
});

let calendarEvents = new Map<string, { id: string; status: string }>();
let calendarCalls: string[] = [];
let calendarThrows = false;

mock.module("@/lib/google/calendar", {
  namedExports: {
    fetchEvent: async (id: string) => {
      calendarCalls.push(`fetch:${id}`);
      if (calendarThrows) throw new Error("google is down");
      return calendarEvents.get(id) ?? null;
    },
    createEvent: async () => {
      calendarCalls.push("create");
      throw new Error("recovery must never create an event");
    },
    deleteEvent: async () => {
      calendarCalls.push("delete");
      return "deleted";
    },
  },
});

let emailsSent: string[] = [];

mock.module("@/lib/email/send", {
  namedExports: {
    sendBookingConfirmation: async () => {
      emailsSent.push("confirmation");
      return { status: "sent" };
    },
    sendBookingNotification: async () => {
      emailsSent.push("notification");
      return { status: "sent" };
    },
  },
});

const {
  listUnpersistedBookings,
  parseStoredBooking,
  recordUnpersistedBooking,
  recoverUnpersistedBooking,
  recoverUnpersistedBookings,
} = await import("./booking-recovery");
import type { PersistBookingInput } from "./persist-booking";

const BOOKING: PersistBookingInput = {
  reference: "BSCJ-FX0001",
  idempotencyKey: "attempt-1",
  calendarEventId: "event-abc",
  customerType: "homeowner",
  fullName: "A Customer",
  company: null,
  email: "person@example.com",
  phone: "+447700900123",
  houseOrName: "12",
  street: "Example Street",
  town: "Wolverhampton",
  postcode: "WV1 1AA",
  accessNotes: null,
  tenantName: null,
  tenantPhone: null,
  productId: "cp12",
  applianceCount: 3,
  extraAppliances: 0,
  extraAppliancePrice: 15,
  priceTotal: 45,
  appointmentStart: new Date("2026-10-01T09:00:00.000Z"),
  appointmentEnd: new Date("2026-10-01T09:45:00.000Z"),
  durationMinutes: 45,
};

beforeEach(() => {
  store = new Map();
  storeFails = false;
  storeThrowsUnlabelled = false;
  persistResult = { status: "created", jobId: "job-1" };
  persistCalls = [];
  calendarEvents = new Map([["event-abc", { id: "event-abc", status: "confirmed" }]]);
  calendarCalls = [];
  calendarThrows = false;
  emailsSent = [];
});

describe("the note survives the outage that caused it", () => {
  test("it is written somewhere other than the database that just failed", async () => {
    /*
      The whole design decision in one test. Persistence failed because
      Postgres was unreachable, so a recovery row in Postgres is the same bet
      placed twice.
    */
    assert.equal(await recordUnpersistedBooking(BOOKING), "recorded");
    assert.equal(store.size, 1);
    assert.ok([...store.keys()][0].startsWith("booking-unpersisted:"));
  });

  test("it round-trips exactly, dates included", async () => {
    await recordUnpersistedBooking(BOOKING);
    const raw = store.get("booking-unpersisted:attempt-1")!.value;
    const parsed = parseStoredBooking(raw);

    assert.ok(parsed);
    assert.equal(parsed.reference, BOOKING.reference);
    assert.equal(parsed.priceTotal, 45);
    assert.deepEqual(parsed.appointmentStart, BOOKING.appointmentStart);
    assert.deepEqual(parsed.appointmentEnd, BOOKING.appointmentEnd);
  });

  test("a store outage is reported, never thrown at the customer", async () => {
    storeFails = true;
    assert.equal(await recordUnpersistedBooking(BOOKING), "unavailable");
  });

  test("it is held for a week, not forever", async () => {
    await recordUnpersistedBooking(BOOKING);
    const entry = store.get("booking-unpersisted:attempt-1")!;
    const days = (entry.expiresAt! - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(days > 6.9 && days < 7.1, `held for ${days} days`);
  });
});

describe("what recovery refuses to accept", () => {
  test("a payload that is not the shape we wrote is refused, not guessed at", () => {
    for (const raw of [
      "not json",
      "{}",
      JSON.stringify({ v: 2, booking: {} }),
      JSON.stringify({ v: 1, booking: { ...BOOKING, productId: "not-a-product" } }),
      JSON.stringify({ v: 1, booking: { ...BOOKING, appointmentStart: "nonsense" } }),
      JSON.stringify({ v: 1, booking: { ...BOOKING, calendarEventId: "" } }),
    ]) {
      assert.equal(parseStoredBooking(raw), null, raw.slice(0, 40));
    }
  });

  test("an unreadable note is left in place rather than discarded", async () => {
    // It is the only pointer to a booking a person could still reconcile.
    store.set("booking-unpersisted:attempt-1", { value: "corrupt", expiresAt: null });

    const result = await recoverUnpersistedBooking("attempt-1");

    assert.equal(result.status, "failed");
    assert.ok(store.get("booking-unpersisted:attempt-1"));
  });
});

describe("recovering the missing record", () => {
  test("it writes the job that was missing", async () => {
    await recordUnpersistedBooking(BOOKING);
    const result = await recoverUnpersistedBooking("attempt-1");

    assert.deepEqual(result, { status: "recovered", jobId: "job-1" });
    assert.equal(persistCalls.length, 1);
    assert.equal(persistCalls[0].idempotencyKey, "attempt-1");
  });

  test("it creates NO second calendar event", async () => {
    await recordUnpersistedBooking(BOOKING);
    await recoverUnpersistedBooking("attempt-1");

    assert.equal(
      calendarCalls.filter((c) => c === "create").length,
      0,
      "recovery booked the customer a second appointment",
    );
  });

  test("it sends the customer NOTHING", async () => {
    await recordUnpersistedBooking(BOOKING);
    await recoverUnpersistedBooking("attempt-1");

    assert.deepEqual(
      emailsSent,
      [],
      "recovery re-sent a confirmation for a booking already confirmed",
    );
  });

  test("it verifies the appointment still exists before writing a job for it", async () => {
    await recordUnpersistedBooking(BOOKING);
    await recoverUnpersistedBooking("attempt-1");
    assert.ok(calendarCalls.includes("fetch:event-abc"));
  });

  test("a cancelled appointment is not resurrected as a job", async () => {
    calendarEvents.set("event-abc", { id: "event-abc", status: "cancelled" });
    await recordUnpersistedBooking(BOOKING);

    const result = await recoverUnpersistedBooking("attempt-1");

    assert.equal(result.status, "event_missing");
    assert.equal(persistCalls.length, 0, "a cancelled visit became a job");
  });

  test("a vanished appointment is not resurrected either", async () => {
    calendarEvents.delete("event-abc");
    await recordUnpersistedBooking(BOOKING);

    const result = await recoverUnpersistedBooking("attempt-1");
    assert.equal(result.status, "event_missing");
    assert.equal(persistCalls.length, 0);
  });

  test("a second attempt does nothing, however many times it is called", async () => {
    await recordUnpersistedBooking(BOOKING);

    await recoverUnpersistedBooking("attempt-1");
    const again = await recoverUnpersistedBooking("attempt-1");
    const andAgain = await recoverUnpersistedBooking("attempt-1");

    assert.equal(again.status, "nothing_to_do");
    assert.equal(andAgain.status, "nothing_to_do");
    assert.equal(persistCalls.length, 1, "it wrote the job more than once");
  });

  test("a booking that turns out to have been recorded is recognised", async () => {
    persistResult = { status: "exists", jobId: "already-there" };
    await recordUnpersistedBooking(BOOKING);

    const result = await recoverUnpersistedBooking("attempt-1");
    assert.deepEqual(result, { status: "recovered", jobId: "already-there" });
  });

  test("nothing outstanding is a no-op", async () => {
    const result = await recoverUnpersistedBooking("never-seen");
    assert.equal(result.status, "nothing_to_do");
    assert.equal(persistCalls.length, 0);
  });

  test("a database still down leaves the note for the next pass", async () => {
    persistResult = { status: "failed", reason: "write_failed" };
    await recordUnpersistedBooking(BOOKING);

    const result = await recoverUnpersistedBooking("attempt-1");

    assert.equal(result.status, "failed");
    assert.ok(
      store.get("booking-unpersisted:attempt-1"),
      "the only record of the booking was thrown away",
    );
  });

  test("a calendar it cannot reach leaves the note too", async () => {
    /*
      "We could not ask" is not "it is not there". Discarding the note here
      would destroy the only automatic route back to a booking that is
      perfectly real.
    */
    calendarThrows = true;

    await recordUnpersistedBooking(BOOKING);
    const result = await recoverUnpersistedBooking("attempt-1");

    assert.equal(result.status, "failed");
    assert.ok(store.get("booking-unpersisted:attempt-1"));
    assert.equal(persistCalls.length, 0, "it wrote a job it could not verify");
  });
});

describe("the sweep", () => {
  test("an unlistable store is reported, not read as an empty queue", async () => {
    storeFails = true;
    const listing = await listUnpersistedBookings(10);
    assert.equal(listing.status, "unavailable");

    const sweep = await recoverUnpersistedBookings(10);
    assert.equal(
      sweep.listed,
      false,
      "an unreachable store was reported as nothing outstanding",
    );
  });

  test("it is bounded", async () => {
    for (let i = 0; i < 40; i += 1) {
      await recordUnpersistedBooking({
        ...BOOKING,
        idempotencyKey: `attempt-${i}`,
      });
    }

    const listing = await listUnpersistedBookings(5);
    assert.equal(listing.status, "ok");
    assert.equal((listing as { keys: string[] }).keys.length, 5);
  });
});


describe("nothing here can fail a booking that already happened", () => {
  test("an unlabelled store failure is a value, not a throw", async () => {
    /*
      `recoverUnpersistedBooking` is called from `/api/book` on a duplicate
      submission, outside the handler's try/catch. It used to rethrow anything
      that was not a `KvUnavailableError`, which would have turned a repeat
      click into HTTP 500 — a new failure mode in the public booking flow,
      introduced by the machinery meant to protect it.
    */
    storeThrowsUnlabelled = true;

    const result = await recoverUnpersistedBooking("attempt-1");

    assert.equal(result.status, "failed");
    assert.equal((result as { reason: string }).reason, "store_error");
  });

  test("recording is a value too, however the store fails", async () => {
    storeThrowsUnlabelled = true;
    await assert.doesNotReject(() => recordUnpersistedBooking(BOOKING));
    assert.equal(await recordUnpersistedBooking(BOOKING), "unavailable");
  });
});

describe("when both stores are down, somebody is told", () => {
  test("no reservation store at all is reported, loudly", async () => {
    /*
      The worst case the design has: Postgres would not take the booking and
      there is nowhere to put the note, so this booking has no automatic route
      back. The appointment is real and the customer is confirmed — the only
      thing that makes a manual rebuild possible is saying so.
    */
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      assert.equal(await recordUnpersistedBooking(BOOKING, null), "unavailable");
    } finally {
      console.warn = original;
    }

    assert.equal(warnings.length, 1, "the booking was lost in silence");
    assert.match(warnings[0], /NOT RECORDED/);
    assert.match(warnings[0], /BSCJ-FX0001/, "no reference to search for");
  });

  test("a store that refuses the write is reported too", async () => {
    storeFails = true;

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      await recordUnpersistedBooking(BOOKING);
    } finally {
      console.warn = original;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /NOT RECORDED/);
  });

  test("what is reported is a reference and a category, never the customer", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      await recordUnpersistedBooking(BOOKING, null);
    } finally {
      console.warn = original;
    }

    const line = warnings.join(" ");
    for (const secret of [
      BOOKING.fullName,
      BOOKING.email,
      BOOKING.phone,
      BOOKING.postcode,
      BOOKING.street,
      BOOKING.idempotencyKey,
    ]) {
      assert.equal(line.includes(secret), false, `the log leaked ${secret}`);
    }
  });
});
