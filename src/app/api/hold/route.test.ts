import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import { getPartsInZone, zonedTimeToUtc } from "@/lib/booking/time";

/**
 * The reservation endpoint, with the product-aware rules it now applies.
 *
 * Two things are proved here that the pure engine cannot prove on its own:
 * that Google is consulted *before* anything is reserved, so a hold can never
 * outrank the calendar; and that the slot is validated against the length of
 * the product actually being reserved.
 */

let calls: string[] = [];
let busy: { start: Date; end: Date }[] = [];

mock.module("@/lib/google/calendar", {
  namedExports: {
    fetchBusyPeriods: async () => {
      calls.push("google:freebusy");
      return busy;
    },
    CalendarApiError: class CalendarApiError extends Error {},
    CalendarNotConfiguredError: class CalendarNotConfiguredError extends Error {},
  },
});

let acquireOutcome: "acquired" | "taken" | "unavailable" = "acquired";
let lastAcquire: { slotStart: string; productId: string } | null = null;

mock.module("@/lib/booking/holds", {
  namedExports: {
    acquireHold: async (slotStart: string, productId: string) => {
      calls.push("redis:acquire");
      lastAcquire = { slotStart, productId };
      if (acquireOutcome !== "acquired") return { status: acquireOutcome };
      return {
        status: "acquired",
        token: "b".repeat(64),
        slotStart,
        productId,
        expiresAt: new Date(Date.now() + 1800_000).toISOString(),
      };
    },
    releaseHold: async () => true,
    isWellFormedToken: (value: unknown) =>
      typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
    HOLD_DURATION_SECONDS: 1800,
  },
});

mock.module("@/lib/booking/rate-limit", {
  namedExports: {
    rateLimit: async () => ({ ok: true, retryAfterSeconds: 0 }),
    pruneRateLimits: () => {},
    clientKey: () => "test-client",
    rateLimits: {
      availability: { limit: 60, windowSeconds: 60 },
      hold: { limit: 20, windowSeconds: 600 },
      booking: { limit: 8, windowSeconds: 600 },
    },
  },
});

const { POST } = await import("./route");

function slotDaysAhead(days: number, hour: number): string {
  const target = new Date(Date.now() + days * 24 * 60 * 60000);
  const parts = getPartsInZone(target, "Europe/London");
  const at = zonedTimeToUtc({ ...parts, hour, minute: 0 }, "Europe/London");
  if (at.getUTCDay() === 6) return slotDaysAhead(days + 1, hour);
  return at.toISOString();
}

const SEVEN_PM = slotDaysAhead(10, 19);
const EIGHT_PM = slotDaysAhead(10, 20);
const MIDDAY = slotDaysAhead(10, 12);

async function hold(body: Record<string, unknown>) {
  const response = await POST(
    new Request("http://localhost/api/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}

function minutes(start: string, end: string): number {
  return (new Date(end).getTime() - new Date(start).getTime()) / 60000;
}

beforeEach(() => {
  calls = [];
  busy = [];
  acquireOutcome = "acquired";
  lastAcquire = null;
});

describe("a reservation is validated against its own product", () => {
  test("the calendar is read before anything is reserved", async () => {
    await hold({ slotStart: MIDDAY });
    assert.deepEqual(calls, ["google:freebusy", "redis:acquire"]);
  });

  test("a slot Google says is busy is never reserved", async () => {
    busy = [
      {
        start: new Date(MIDDAY),
        end: new Date(new Date(MIDDAY).getTime() + 45 * 60000),
      },
    ];
    const { status, body } = await hold({ slotStart: MIDDAY });

    assert.equal(status, 409);
    assert.equal(body.error, "slot_taken");
    assert.equal(calls.includes("redis:acquire"), false);
  });

  test("no product named reserves a CP12", async () => {
    const { body } = await hold({ slotStart: MIDDAY });
    assert.equal(body.productId, "cp12");
    assert.equal(lastAcquire?.productId, "cp12");
    assert.equal(minutes(body.slotStart, body.slotEnd), 45);
  });

  test("a bundle is reserved for sixty minutes", async () => {
    const { body } = await hold({
      slotStart: MIDDAY,
      productId: "cp12-boiler-service",
    });
    assert.equal(body.productId, "cp12-boiler-service");
    assert.equal(lastAcquire?.productId, "cp12-boiler-service");
    assert.equal(minutes(body.slotStart, body.slotEnd), 60);
  });

  test("the appointment end is the server's, not the browser's", async () => {
    const { body } = await hold({
      slotStart: MIDDAY,
      productId: "cp12-boiler-service",
      // Ignored: there is no field for it, and the end is derived.
      slotEnd: new Date(new Date(MIDDAY).getTime() + 5 * 60000).toISOString(),
      durationMinutes: 5,
    });
    assert.equal(minutes(body.slotStart, body.slotEnd), 60);
  });

  test("an unknown product is refused before Google is even asked", async () => {
    for (const productId of ["cp12-free", "", 7, null]) {
      const { status } = await hold({ slotStart: MIDDAY, productId });
      assert.equal(status, 400, `accepted ${JSON.stringify(productId)}`);
    }
    assert.equal(calls.length, 0);
  });

  test("19:00 may be reserved for either product", async () => {
    const cp12 = await hold({ slotStart: SEVEN_PM });
    assert.equal(cp12.status, 200);
    assert.equal(minutes(cp12.body.slotStart, cp12.body.slotEnd), 45);

    const bundle = await hold({
      slotStart: SEVEN_PM,
      productId: "cp12-boiler-service",
    });
    assert.equal(bundle.status, 200);
    assert.equal(minutes(bundle.body.slotStart, bundle.body.slotEnd), 60);
  });

  test("20:00 may be reserved for neither", async () => {
    for (const productId of ["cp12", "cp12-boiler-service"]) {
      const { status, body } = await hold({ slotStart: EIGHT_PM, productId });
      assert.equal(status, 409, `20:00 reserved for ${productId}`);
      assert.equal(body.error, "slot_taken");
      assert.equal(calls.includes("redis:acquire"), false);
    }
  });

  test("a slot lost to someone else is reported, not reserved anyway", async () => {
    acquireOutcome = "taken";
    const { status, body } = await hold({
      slotStart: MIDDAY,
      productId: "cp12-boiler-service",
    });
    assert.equal(status, 409);
    assert.equal(body.error, "slot_taken");
  });

  test("without a reservation store the booking still proceeds", async () => {
    // Degraded, not broken: Google decides at confirmation, first confirmed
    // wins — the behaviour that existed before holds.
    acquireOutcome = "unavailable";
    const { status, body } = await hold({
      slotStart: MIDDAY,
      productId: "cp12-boiler-service",
    });

    assert.equal(status, 200);
    assert.equal(body.held, false);
    assert.equal(body.degraded, true);
    assert.equal(body.productId, "cp12-boiler-service");
    assert.equal(minutes(body.slotStart, body.slotEnd), 60);
  });

  test("a previous reservation travels with its own product", async () => {
    // The server has to know how many starts the old reservation occupied
    // before it can give them back.
    const { status } = await hold({
      slotStart: MIDDAY,
      productId: "cp12",
      previous: {
        slotStart: SEVEN_PM,
        token: "a".repeat(64),
        productId: "cp12-boiler-service",
      },
    });
    assert.equal(status, 200);
  });

  test("a malformed previous reservation is refused outright", async () => {
    const { status } = await hold({
      slotStart: MIDDAY,
      previous: { slotStart: SEVEN_PM, token: "not-a-token" },
    });
    assert.equal(status, 400);
  });
});
