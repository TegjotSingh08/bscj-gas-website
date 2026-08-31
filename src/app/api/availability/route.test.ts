import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Availability is product-aware.
 *
 * The two services are different lengths, so they rule out different times.
 * Answering a bundle customer with the CP12's availability would offer them
 * slots that cannot be honoured — which is only discovered at the very end,
 * when Google refuses the write.
 *
 * Google, Redis and the rate limiter are faked; the availability engine and
 * the route itself are the production code.
 */

let busy: { start: Date; end: Date }[] = [];

mock.module("@/lib/google/calendar", {
  namedExports: {
    fetchBusyPeriods: async () => busy,
    CalendarApiError: class CalendarApiError extends Error {},
    CalendarNotConfiguredError: class CalendarNotConfiguredError extends Error {},
  },
});

mock.module("@/lib/booking/holds", {
  namedExports: {
    findHeldSlots: async () => new Set<string>(),
    isWellFormedToken: (value: unknown) =>
      typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
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

const { GET } = await import("./route");

type Day = { date: string; slots: { startIso: string; endIso: string; label: string }[] };

async function availability(query = ""): Promise<{
  status: number;
  body: { days?: Day[]; productId?: string; error?: string };
}> {
  const response = await GET(
    new Request(`http://localhost/api/availability${query}`),
  );
  return { status: response.status, body: await response.json() };
}

/** Every slot offered across the whole horizon, for one product. */
async function slots(query = ""): Promise<
  { startIso: string; endIso: string; label: string }[]
> {
  const { body } = await availability(query);
  assert.ok(body.days, "no days were returned");
  return body.days.flatMap((day) => day.slots);
}

beforeEach(() => {
  busy = [];
});

describe("availability is asked for one product at a time", () => {
  test("no product named means the CP12, as it always did", async () => {
    const { status, body } = await availability();
    assert.equal(status, 200);
    assert.equal(body.productId, "cp12");
  });

  test("a named product is echoed back", async () => {
    const { status, body } = await availability("?product=cp12-boiler-service");
    assert.equal(status, 200);
    assert.equal(body.productId, "cp12-boiler-service");
  });

  test("an unknown product is refused rather than quietly answered", async () => {
    // Answering with the CP12's times would offer a bundle customer slots
    // that cannot be honoured.
    for (const product of ["cp12-free", "boiler", "", "CP12"]) {
      const { status, body } = await availability(
        `?product=${encodeURIComponent(product)}`,
      );
      assert.equal(status, 400, `accepted "${product}"`);
      assert.equal(body.error, "bad_product");
    }
  });

  test("CP12 slots run forty-five minutes", async () => {
    for (const slot of await slots()) {
      const minutes =
        (new Date(slot.endIso).getTime() - new Date(slot.startIso).getTime()) /
        60000;
      assert.equal(minutes, 45);
    }
  });

  test("bundle slots run sixty minutes", async () => {
    for (const slot of await slots("?product=cp12-boiler-service")) {
      const minutes =
        (new Date(slot.endIso).getTime() - new Date(slot.startIso).getTime()) /
        60000;
      assert.equal(minutes, 60);
    }
  });

  test("neither product is offered a start after 19:00", async () => {
    for (const query of ["", "?product=cp12-boiler-service"]) {
      const labels = new Set((await slots(query)).map((slot) => slot.label));
      assert.equal(labels.has("20:00"), false);
      assert.equal(labels.has("19:00"), true, `19:00 missing for "${query}"`);
    }
  });

  test("both products are offered the same starts", async () => {
    // The bundle is longer, but it does not lose the last slot of the day to
    // that: the buffer may overrun closing time, the appointment may not.
    const cp12 = (await slots()).map((slot) => slot.startIso).sort();
    const bundle = (await slots("?product=cp12-boiler-service"))
      .map((slot) => slot.startIso)
      .sort();
    assert.deepEqual(bundle, cp12);
  });

  test("a busy hour removes the bundle that would run into it", async () => {
    const all = await slots("?product=cp12-boiler-service");
    const target = all.find((slot) => slot.label === "14:00");
    assert.ok(target, "expected a 14:00 slot to exist");

    // A job occupying 15:00–15:45 leaves no room for a 14:00–15:00 bundle:
    // the buffer needs fifteen minutes either side.
    busy = [
      {
        start: new Date(new Date(target.startIso).getTime() + 60 * 60000),
        end: new Date(new Date(target.startIso).getTime() + 105 * 60000),
      },
    ];

    const remaining = await slots("?product=cp12-boiler-service");
    assert.equal(
      remaining.some((slot) => slot.startIso === target.startIso),
      false,
    );
  });
});
