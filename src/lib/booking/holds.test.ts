import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  acquireHold,
  checkHold,
  findCompletedBooking,
  findHeldSlots,
  generateHoldToken,
  HOLD_DURATION_SECONDS,
  isWellFormedToken,
  markBookingCompleted,
  releaseHold,
} from "./holds";
import { rateLimit, rateLimits } from "./rate-limit";
import { isSlotStillAvailable } from "./slots";
import { zonedTimeToUtc } from "./time";
import { buildEventId } from "@/lib/google/calendar";
import { KvUnavailableError, type KvClient } from "@/lib/kv/store";

/**
 * A fake store with the same semantics as Redis: SET NX, TTL expiry and
 * compare-and-delete. Time is controlled, so the 30-minute expiry can be
 * tested without waiting for it.
 */
class FakeKv implements KvClient {
  private data = new Map<string, { value: string; expiresAt: number }>();
  now = 1_000_000;

  advanceSeconds(seconds: number) {
    this.now += seconds * 1000;
  }

  private live(key: string) {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now) {
      this.data.delete(key);
      return null;
    }
    return entry;
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number) {
    if (this.live(key)) return false;
    this.data.set(key, { value, expiresAt: this.now + ttlSeconds * 1000 });
    return true;
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }

  async deleteIfEqual(key: string, value: string) {
    const entry = this.live(key);
    if (!entry || entry.value !== value) return false;
    this.data.delete(key);
    return true;
  }

  async ttl(key: string) {
    const entry = this.live(key);
    if (!entry) return -2;
    return Math.ceil((entry.expiresAt - this.now) / 1000);
  }

  async mget(keys: string[]) {
    return keys.map((key) => this.live(key)?.value ?? null);
  }

  async set(key: string, value: string, ttlSeconds: number) {
    this.data.set(key, { value, expiresAt: this.now + ttlSeconds * 1000 });
  }

  async incrementWithTtl(key: string, ttlSeconds: number) {
    const entry = this.live(key);
    const count = entry ? Number(entry.value) + 1 : 1;
    this.data.set(key, {
      value: String(count),
      expiresAt: entry ? entry.expiresAt : this.now + ttlSeconds * 1000,
    });
    return count;
  }
}

/** A store that is down. Every call fails the way a network outage would. */
const brokenKv: KvClient = {
  setIfAbsent: async () => {
    throw new KvUnavailableError();
  },
  get: async () => {
    throw new KvUnavailableError();
  },
  deleteIfEqual: async () => {
    throw new KvUnavailableError();
  },
  ttl: async () => {
    throw new KvUnavailableError();
  },
  mget: async () => {
    throw new KvUnavailableError();
  },
  set: async () => {
    throw new KvUnavailableError();
  },
  incrementWithTtl: async () => {
    throw new KvUnavailableError();
  },
};

const SLOT_A = "2026-08-20T13:00:00.000Z";
const SLOT_B = "2026-08-20T14:00:00.000Z";

let kv: FakeKv;
beforeEach(() => {
  kv = new FakeKv();
});

describe("acquiring a hold", () => {
  test("the first customer gets the slot", async () => {
    const result = await acquireHold(SLOT_A, undefined, kv);
    assert.equal(result.status, "acquired");
    if (result.status === "acquired") {
      assert.equal(result.slotStart, SLOT_A);
      assert.match(result.token, /^[0-9a-f]{64}$/);
    }
  });

  test("a second customer cannot take the same slot", async () => {
    const first = await acquireHold(SLOT_A, undefined, kv);
    assert.equal(first.status, "acquired");

    const second = await acquireHold(SLOT_A, undefined, kv);
    assert.equal(second.status, "taken");
  });

  test("the first customer's hold is unaffected by the second attempt", async () => {
    const first = await acquireHold(SLOT_A, undefined, kv);
    assert.equal(first.status, "acquired");
    await acquireHold(SLOT_A, undefined, kv);

    if (first.status !== "acquired") return;
    const check = await checkHold(SLOT_A, first.token, kv);
    assert.equal(check.status, "valid");
  });

  test("the hold lasts exactly thirty minutes", async () => {
    assert.equal(HOLD_DURATION_SECONDS, 1800);
    const result = await acquireHold(SLOT_A, undefined, kv);
    assert.equal(result.status, "acquired");
    assert.equal(await kv.ttl(`booking-hold:${SLOT_A}`), 1800);
  });

  test("tokens are unpredictable and distinct", () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => generateHoldToken()),
    );
    assert.equal(tokens.size, 200);
  });
});

describe("hold expiry", () => {
  test("a slot becomes available again once the hold expires", async () => {
    const first = await acquireHold(SLOT_A, undefined, kv);
    assert.equal(first.status, "acquired");

    kv.advanceSeconds(HOLD_DURATION_SECONDS + 1);

    const second = await acquireHold(SLOT_A, undefined, kv);
    assert.equal(second.status, "acquired");
  });

  test("an expired token is rejected at confirmation", async () => {
    const result = await acquireHold(SLOT_A, undefined, kv);
    assert.equal(result.status, "acquired");
    if (result.status !== "acquired") return;

    kv.advanceSeconds(HOLD_DURATION_SECONDS + 1);

    const check = await checkHold(SLOT_A, result.token, kv);
    assert.equal(check.status, "expired");
  });

  test("a hold is still valid one second before it expires", async () => {
    const result = await acquireHold(SLOT_A, undefined, kv);
    if (result.status !== "acquired") return assert.fail();

    kv.advanceSeconds(HOLD_DURATION_SECONDS - 1);

    const check = await checkHold(SLOT_A, result.token, kv);
    assert.equal(check.status, "valid");
  });
});

describe("changing the chosen time", () => {
  test("choosing another slot releases the previous hold", async () => {
    const first = await acquireHold(SLOT_A, undefined, kv);
    if (first.status !== "acquired") return assert.fail();

    const second = await acquireHold(
      SLOT_B,
      { slotStart: SLOT_A, token: first.token },
      kv,
    );
    assert.equal(second.status, "acquired");

    // The old slot is free for anyone else again.
    assert.equal(await kv.get(`booking-hold:${SLOT_A}`), null);
    const other = await acquireHold(SLOT_A, undefined, kv);
    assert.equal(other.status, "acquired");
  });

  test("one session never ends up holding two slots", async () => {
    const first = await acquireHold(SLOT_A, undefined, kv);
    if (first.status !== "acquired") return assert.fail();
    await acquireHold(SLOT_B, { slotStart: SLOT_A, token: first.token }, kv);

    const heldByAnyone = await findHeldSlots([SLOT_A, SLOT_B], undefined, kv);
    assert.deepEqual([...heldByAnyone], [SLOT_B]);
  });

  test("re-selecting the slot already held is not treated as a conflict", async () => {
    const first = await acquireHold(SLOT_A, undefined, kv);
    if (first.status !== "acquired") return assert.fail();

    const again = await acquireHold(
      SLOT_A,
      { slotStart: SLOT_A, token: first.token },
      kv,
    );
    assert.equal(again.status, "acquired");
    if (again.status === "acquired") assert.equal(again.token, first.token);
  });

  test("someone else's token cannot release a hold", async () => {
    const first = await acquireHold(SLOT_A, undefined, kv);
    if (first.status !== "acquired") return assert.fail();

    const released = await releaseHold(SLOT_A, generateHoldToken(), kv);
    assert.equal(released, false);
    assert.equal((await checkHold(SLOT_A, first.token, kv)).status, "valid");
  });
});

describe("token validation", () => {
  test("a forged token is rejected", async () => {
    await acquireHold(SLOT_A, undefined, kv);
    const check = await checkHold(SLOT_A, generateHoldToken(), kv);
    assert.equal(check.status, "mismatch");
  });

  test("a token for the wrong slot is rejected", async () => {
    const first = await acquireHold(SLOT_A, undefined, kv);
    if (first.status !== "acquired") return assert.fail();

    const check = await checkHold(SLOT_B, first.token, kv);
    assert.equal(check.status, "expired");
  });

  test("malformed tokens are rejected without reaching the store", async () => {
    assert.equal(isWellFormedToken("short"), false);
    assert.equal(isWellFormedToken(""), false);
    assert.equal(isWellFormedToken(null), false);
    assert.equal(isWellFormedToken(12345), false);
    assert.equal(isWellFormedToken("z".repeat(64)), false);
    assert.equal(isWellFormedToken(generateHoldToken()), true);
  });

  test("no hold at all reads as expired, never as valid", async () => {
    const check = await checkHold(SLOT_A, generateHoldToken(), kv);
    assert.equal(check.status, "expired");
  });
});

describe("availability filtering", () => {
  test("slots held by others are reported as held", async () => {
    await acquireHold(SLOT_A, undefined, kv);
    const held = await findHeldSlots([SLOT_A, SLOT_B], undefined, kv);
    assert.ok(held.has(SLOT_A));
    assert.ok(!held.has(SLOT_B));
  });

  test("a customer still sees the slot they themselves hold", async () => {
    const mine = await acquireHold(SLOT_A, undefined, kv);
    if (mine.status !== "acquired") return assert.fail();

    const held = await findHeldSlots(
      [SLOT_A, SLOT_B],
      { slotStart: SLOT_A, token: mine.token },
      kv,
    );
    assert.equal(held.size, 0);
  });

  test("presenting the wrong token does not unhide someone else's slot", async () => {
    await acquireHold(SLOT_A, undefined, kv);
    const held = await findHeldSlots(
      [SLOT_A],
      { slotStart: SLOT_A, token: generateHoldToken() },
      kv,
    );
    assert.ok(held.has(SLOT_A));
  });
});

describe("completed bookings", () => {
  test("a completed attempt is recognised on a repeat submission", async () => {
    await markBookingCompleted("attempt-1", "event-abc", kv);
    assert.equal(await findCompletedBooking("attempt-1", kv), "event-abc");
  });

  test("an unrelated attempt is not treated as completed", async () => {
    await markBookingCompleted("attempt-1", "event-abc", kv);
    assert.equal(await findCompletedBooking("attempt-2", kv), null);
  });
});

describe("store outage cannot bypass the calendar safety net", () => {
  test("acquiring reports unavailable rather than success", async () => {
    const result = await acquireHold(SLOT_A, undefined, brokenKv);
    assert.equal(result.status, "unavailable");
  });

  test("checking reports unavailable, never valid", async () => {
    const check = await checkHold(SLOT_A, generateHoldToken(), brokenKv);
    assert.equal(check.status, "unavailable");
    // The route treats "unavailable" as "cannot vouch for the hold" and relies
    // on the Google re-check. It must never be read as a valid reservation.
    assert.notEqual(check.status, "valid");
  });

  test("an outage never claims a slot is free", async () => {
    // findHeldSlots returns nothing held, which degrades availability to
    // Google alone. It must not invent the opposite either.
    const held = await findHeldSlots([SLOT_A], undefined, brokenKv);
    assert.equal(held.size, 0);
  });

  test("releasing during an outage fails quietly and relies on TTL", async () => {
    assert.equal(await releaseHold(SLOT_A, generateHoldToken(), brokenKv), false);
  });

  test("with no store configured at all, holds report unavailable", async () => {
    assert.equal((await acquireHold(SLOT_A, undefined, null)).status, "unavailable");
    assert.equal(
      (await checkHold(SLOT_A, generateHoldToken(), null)).status,
      "unavailable",
    );
  });
});

describe("distributed rate limiting", () => {
  test("requests under the limit pass", async () => {
    for (let i = 0; i < rateLimits.hold.limit; i += 1) {
      const result = await rateLimit("hold:1.2.3.4", rateLimits.hold.limit, 600, kv);
      assert.equal(result.ok, true);
    }
  });

  test("the request over the limit is refused", async () => {
    for (let i = 0; i < rateLimits.hold.limit; i += 1) {
      await rateLimit("hold:1.2.3.4", rateLimits.hold.limit, 600, kv);
    }
    const blocked = await rateLimit("hold:1.2.3.4", rateLimits.hold.limit, 600, kv);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfterSeconds > 0);
  });

  test("the counter is shared, so separate instances see one total", async () => {
    // Two callers sharing one store is exactly the multi-instance case.
    for (let i = 0; i < 5; i += 1) {
      await rateLimit("hold:5.6.7.8", 6, 600, kv);
    }
    assert.equal((await rateLimit("hold:5.6.7.8", 6, 600, kv)).ok, true);
    assert.equal((await rateLimit("hold:5.6.7.8", 6, 600, kv)).ok, false);
  });

  test("different clients are counted separately", async () => {
    for (let i = 0; i < 8; i += 1) await rateLimit("hold:1.1.1.1", 8, 600, kv);
    assert.equal((await rateLimit("hold:1.1.1.1", 8, 600, kv)).ok, false);
    assert.equal((await rateLimit("hold:2.2.2.2", 8, 600, kv)).ok, true);
  });

  test("the window resets once it has passed", async () => {
    for (let i = 0; i < 8; i += 1) await rateLimit("hold:3.3.3.3", 8, 600, kv);
    assert.equal((await rateLimit("hold:3.3.3.3", 8, 600, kv)).ok, false);

    kv.advanceSeconds(601);
    assert.equal((await rateLimit("hold:3.3.3.3", 8, 600, kv)).ok, true);
  });

  test("an outage still limits, falling back to per-instance counting", async () => {
    const key = `hold:outage-${Math.random()}`;
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await rateLimit(key, 3, 600, brokenKv)).ok, true);
    }
    assert.equal((await rateLimit(key, 3, 600, brokenKv)).ok, false);
  });
});


describe("a hold never outranks Google Calendar", () => {
  // A real configured slot: 14:00 London on a working Thursday.
  const slotStart = zonedTimeToUtc(
    { year: 2026, month: 8, day: 20, hour: 14, minute: 0 },
    "Europe/London",
  );
  const slotIso = slotStart.toISOString();
  const wellBefore = zonedTimeToUtc(
    { year: 2026, month: 8, day: 19, hour: 6, minute: 0 },
    "Europe/London",
  );

  test("the slot is bookable when the calendar is clear and the hold is valid", async () => {
    const held = await acquireHold(slotIso, undefined, kv);
    assert.equal(held.status, "acquired");
    if (held.status !== "acquired") return;

    assert.equal((await checkHold(slotIso, held.token, kv)).status, "valid");
    assert.equal(isSlotStillAvailable(slotIso, [], wellBefore), true);
  });

  test("a valid hold does not make a slot bookable once Google shows it busy", async () => {
    const held = await acquireHold(slotIso, undefined, kv);
    if (held.status !== "acquired") return assert.fail();

    // The engineer accepts something else into the diary mid-hold.
    const busy = [
      {
        start: slotStart,
        end: new Date(slotStart.getTime() + 45 * 60000),
      },
    ];

    // The reservation is still perfectly valid...
    assert.equal((await checkHold(slotIso, held.token, kv)).status, "valid");
    // ...and the calendar still refuses the booking. Google decides.
    assert.equal(isSlotStillAvailable(slotIso, busy, wellBefore), false);
  });
});

describe("double-clicking confirm creates one booking", () => {
  const slotIso = "2026-08-20T13:00:00.000Z";

  test("the second submission is recognised as already completed", async () => {
    const attempt = "attempt-double-click";

    // First click: books, records completion, releases the hold.
    const held = await acquireHold(slotIso, undefined, kv);
    if (held.status !== "acquired") return assert.fail();
    await markBookingCompleted(attempt, "event-xyz", kv);
    await releaseHold(slotIso, held.token, kv);

    // Second click arrives with the same attempt key. The completed marker is
    // checked before the hold, so the now-released hold is not mistaken for an
    // expiry, and no second event is created.
    assert.equal(await findCompletedBooking(attempt, kv), "event-xyz");
    assert.equal((await checkHold(slotIso, held.token, kv)).status, "expired");
  });

  test("both clicks would target the same calendar event id anyway", () => {
    const attempt = "attempt-double-click";
    assert.equal(
      buildEventId(slotIso, attempt),
      buildEventId(slotIso, attempt),
    );
  });
});
