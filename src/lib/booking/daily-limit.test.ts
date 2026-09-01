import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  acquireDailyBookingLock,
  DAILY_LOCK_TTL_SECONDS,
  releaseDailyBookingLock,
} from "./daily-limit";
import { KvUnavailableError, type KvClient } from "@/lib/kv/store";

/** A store with real SET NX semantics and a controllable clock. */
class FakeKv implements KvClient {
  private data = new Map<string, { value: string; expiresAt: number }>();
  now = 1_000_000;
  /** Every TTL a key was written with, for asserting the lock is short. */
  readonly ttls: number[] = [];

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
    this.ttls.push(ttlSeconds);
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
    return entry ? Math.ceil((entry.expiresAt - this.now) / 1000) : -2;
  }
  async mget(keys: string[]) {
    return keys.map((key) => this.live(key)?.value ?? null);
  }
  async set(key: string, value: string, ttlSeconds: number) {
    this.data.set(key, { value, expiresAt: this.now + ttlSeconds * 1000 });
  }
  async incrementWithTtl() {
    return 1;
  }
}

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

const DAY = "2026-09-04";
const OTHER_DAY = "2026-09-05";

let kv: FakeKv;
beforeEach(() => {
  kv = new FakeKv();
});

/**
 * The guard that stops two bookings counting the same nine appointments.
 *
 * It is only a guard. Google remains the authority on how many bookings a day
 * holds; this exists so that the count and the write cannot be interleaved.
 */
describe("the per-day booking lock", () => {
  test("one caller takes it", async () => {
    const lock = await acquireDailyBookingLock(DAY, kv);
    assert.equal(lock.status, "acquired");
    if (lock.status === "acquired") assert.ok(lock.token.length > 0);
  });

  test("a second caller for the same day is turned away", async () => {
    await acquireDailyBookingLock(DAY, kv);
    // No retries here: the point is that it does not simply take it too.
    const second = await acquireDailyBookingLock(DAY, kv, 1, 0);
    assert.equal(second.status, "busy");
  });

  test("another day is unaffected", async () => {
    await acquireDailyBookingLock(DAY, kv);
    const other = await acquireDailyBookingLock(OTHER_DAY, kv, 1, 0);
    assert.equal(other.status, "acquired");
  });

  test("releasing lets the next caller straight in", async () => {
    const first = await acquireDailyBookingLock(DAY, kv);
    if (first.status !== "acquired") return assert.fail();

    assert.equal(await releaseDailyBookingLock(DAY, first.token, kv), true);
    assert.equal((await acquireDailyBookingLock(DAY, kv, 1, 0)).status, "acquired");
  });

  test("someone else's token cannot release it", async () => {
    const first = await acquireDailyBookingLock(DAY, kv);
    if (first.status !== "acquired") return assert.fail();

    assert.equal(await releaseDailyBookingLock(DAY, "not-the-token", kv), false);
    assert.equal((await acquireDailyBookingLock(DAY, kv, 1, 0)).status, "busy");
  });

  test("it retries briefly, so ordinary contention is invisible", async () => {
    const first = await acquireDailyBookingLock(DAY, kv);
    if (first.status !== "acquired") return assert.fail();

    // Released while the second caller is still retrying.
    setTimeout(() => void releaseDailyBookingLock(DAY, first.token, kv), 30);

    const second = await acquireDailyBookingLock(DAY, kv, 5, 25);
    assert.equal(second.status, "acquired");
  });

  test("it gives up rather than waiting forever", async () => {
    await acquireDailyBookingLock(DAY, kv);
    const started = Date.now();
    const second = await acquireDailyBookingLock(DAY, kv, 3, 10);

    assert.equal(second.status, "busy");
    assert.ok(Date.now() - started < 1000, "it waited far too long");
  });

  test("a request that dies cannot wedge the day for long", async () => {
    await acquireDailyBookingLock(DAY, kv);
    assert.deepEqual(kv.ttls, [DAILY_LOCK_TTL_SECONDS]);
    assert.ok(DAILY_LOCK_TTL_SECONDS <= 30, "the lock outlives a booking");

    // Nothing releases it; the TTL does.
    kv.advanceSeconds(DAILY_LOCK_TTL_SECONDS + 1);
    assert.equal((await acquireDailyBookingLock(DAY, kv, 1, 0)).status, "acquired");
  });

  test("no store at all means unguarded, not blocked", async () => {
    // Bookings must not fail because Redis is missing. The Google count is
    // still the authority; only the race window returns.
    assert.equal((await acquireDailyBookingLock(DAY, null)).status, "unavailable");
    assert.equal(await releaseDailyBookingLock(DAY, "token", null), false);
  });

  test("an outage is treated the same way", async () => {
    assert.equal(
      (await acquireDailyBookingLock(DAY, brokenKv)).status,
      "unavailable",
    );
    assert.equal(await releaseDailyBookingLock(DAY, "token", brokenKv), false);
  });

  test("each acquisition gets its own token", async () => {
    const first = await acquireDailyBookingLock(DAY, kv);
    if (first.status !== "acquired") return assert.fail();
    await releaseDailyBookingLock(DAY, first.token, kv);

    const second = await acquireDailyBookingLock(DAY, kv);
    if (second.status !== "acquired") return assert.fail();
    assert.notEqual(second.token, first.token);
  });
});
