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
/** Customer bookings the calendar already holds, for the daily cap. */
let bookings: { id: string; start: Date }[] = [];

mock.module("@/lib/google/calendar", {
  namedExports: {
    fetchBusyPeriods: async () => busy,
    fetchBookingEvents: async () => bookings,
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
  bookings = [];
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

  test("neither product is offered a start after 21:00", async () => {
    for (const query of [
      "",
      "?product=boiler-service",
      "?product=cp12-boiler-service",
    ]) {
      const labels = new Set((await slots(query)).map((slot) => slot.label));
      assert.equal(labels.has("20:00"), true, `20:00 missing for "${query}"`);
      assert.equal(labels.has("21:00"), true, `21:00 missing for "${query}"`);
      assert.equal(labels.has("22:00"), false, `22:00 offered for "${query}"`);
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

/**
 * The school run, and what the daily cap actually counts.
 *
 * Two rules meet here. A busy period hides the times it covers, whoever put it
 * on the diary — so the recurring weekday school run removes 15:00 and 16:00
 * without a line of code knowing it exists, and stops removing them the moment
 * it is deleted. A booking count is customers only, so that same event never
 * costs the day one of its ten appointments.
 */
describe("blocking events, weekends and the daily cap", () => {
  /** Every slot label offered on one date. */
  async function labelsOn(date: string, query = ""): Promise<string[]> {
    const { body } = await availability(query);
    assert.ok(body.days);
    return body.days.find((day) => day.date === date)?.slots.map((s) => s.label) ?? [];
  }

  /**
   * The first offered date on the given London weekday, **never today**.
   *
   * Today is deliberately skipped. The route reads the real clock, so on a day
   * that happens to be the weekday under test the afternoon slots fall inside
   * the 12-hour notice window and are correctly absent — which made these
   * assertions pass in the morning and fail in the afternoon. Any later date
   * has a full day of availability whatever time the suite runs at, which
   * pins the behaviour without pinning a global clock the route does not
   * accept.
   */
  async function firstDateOnWeekday(weekday: number): Promise<string> {
    const { body } = await availability();
    assert.ok(body.days);

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const match = body.days.find((day) => {
      if (day.date <= today) return false;
      const [y, m, d] = day.date.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === weekday;
    });
    assert.ok(match, `no offered date fell on weekday ${weekday}`);
    return match.date;
  }

  /** A busy period at wall-clock hours on a London date. */
  function busyOn(date: string, fromHour: number, toHour: number) {
    const [y, m, d] = date.split("-").map(Number);
    const asUtc = (hour: number) =>
      new Date(
        new Date(`${date}T00:00:00Z`).getTime() +
          hour * 3_600_000 -
          // Resolve the London offset for that date rather than assuming it.
          offsetMinutesFor(y, m, d) * 60_000,
      );
    return { start: asUtc(fromHour), end: asUtc(toHour) };
  }

  function offsetMinutesFor(y: number, m: number, d: number): number {
    const noon = new Date(Date.UTC(y, m - 1, d, 12));
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(noon);
    const londonHour = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
    return (londonHour - 12) * 60;
  }

  /** `count` customer bookings on a date, at successive hours. */
  function bookingsOn(date: string, count: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: `bscj-${date}-${index}`,
      start: busyOn(date, 10 + index, 11 + index).start,
    }));
  }

  test("15:00 and 16:00 are offered when the calendar is free", async () => {
    const weekday = await firstDateOnWeekday(3);
    const labels = await labelsOn(weekday);

    assert.ok(labels.includes("15:00"), "15:00 was missing on a free weekday");
    assert.ok(labels.includes("16:00"), "16:00 was missing on a free weekday");
  });

  test("a 15:00–17:00 school run removes 15:00 and 16:00", async () => {
    const weekday = await firstDateOnWeekday(3);
    busy = [busyOn(weekday, 15, 17)];

    const labels = await labelsOn(weekday);
    assert.equal(labels.includes("15:00"), false);
    assert.equal(labels.includes("16:00"), false);
  });

  test("it also takes 17:00, because of the travel buffer", async () => {
    /*
      Worth pinning, because it is a business consequence rather than a bug: a
      block ending at 17:00 is widened by the 15-minute travel buffer to 17:15,
      so a 17:00 appointment would start before the engineer could get there.
      A 15:00–17:00 event therefore costs three slots, not two.

      14:00 survives: 14:00–14:45 finishes exactly as the buffer begins.
    */
    const weekday = await firstDateOnWeekday(3);
    busy = [busyOn(weekday, 15, 17)];

    const labels = await labelsOn(weekday);
    assert.equal(labels.includes("17:00"), false);
    assert.ok(labels.includes("14:00"), "14:00–14:45 clears 15:00 by the buffer");
    assert.ok(labels.includes("18:00"), "the evening beyond the buffer was lost");
  });

  test("deleting the school run brings 15:00 and 16:00 straight back", async () => {
    const weekday = await firstDateOnWeekday(3);

    busy = [busyOn(weekday, 15, 17)];
    assert.equal((await labelsOn(weekday)).includes("15:00"), false);

    // Nothing in the application remembers the event: it is only ever absent
    // from what Google reports.
    busy = [];
    assert.equal((await labelsOn(weekday)).includes("15:00"), true);
    assert.equal((await labelsOn(weekday)).includes("16:00"), true);
  });

  test("a weekday school run does not follow the weekend", async () => {
    const weekday = await firstDateOnWeekday(3);
    const sunday = await firstDateOnWeekday(0);
    busy = [busyOn(weekday, 15, 17)];

    const sundayLabels = await labelsOn(sunday);
    assert.ok(sundayLabels.includes("15:00"), "Sunday lost 15:00 to a weekday event");
    assert.ok(sundayLabels.includes("16:00"), "Sunday lost 16:00 to a weekday event");
  });

  test("Saturday stays closed, as the trading days say", async () => {
    // Working days are Monday to Friday plus Sunday. Nothing here changes that.
    const { body } = await availability();
    assert.ok(body.days);
    for (const day of body.days) {
      const [y, m, d] = day.date.split("-").map(Number);
      if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 6) continue;
      assert.deepEqual(day.slots, [], `${day.date} is a Saturday and was offered`);
    }
  });

  test("a blocking event costs times but not one of the ten bookings", async () => {
    const weekday = await firstDateOnWeekday(3);
    busy = [busyOn(weekday, 15, 17)];
    bookings = [];

    const labels = await labelsOn(weekday);
    assert.ok(
      labels.length > 0,
      "an ordinary diary entry closed the day as though it were a booking",
    );
    assert.equal(labels.includes("15:00"), false);
  });

  test("nine bookings still leave the day open", async () => {
    const weekday = await firstDateOnWeekday(3);
    bookings = bookingsOn(weekday, 9);

    assert.ok((await labelsOn(weekday)).length > 0, "a ninth booking closed the day");
  });

  test("ten bookings offer nothing further that day", async () => {
    const weekday = await firstDateOnWeekday(3);
    bookings = bookingsOn(weekday, 10);

    assert.deepEqual(await labelsOn(weekday), []);
  });

  test("a full day does not close the days around it", async () => {
    const weekday = await firstDateOnWeekday(3);
    const sunday = await firstDateOnWeekday(0);
    bookings = bookingsOn(weekday, 10);

    assert.deepEqual(await labelsOn(weekday), []);
    assert.ok((await labelsOn(sunday)).length > 0, "a full day closed another day");
  });
});
