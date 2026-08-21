import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Transaction-order tests against the real /api/book handler.
 *
 * The rule being protected: the confirmation email is attempted only after the
 * Google Calendar event exists, and an email failure can never turn a
 * confirmed appointment into a failed booking.
 *
 * Google, Redis and Resend are replaced with recording fakes so the order of
 * operations is observable. Everything else — validation, pricing, the hold
 * check, the response shape — is the production code.
 */

/** Every side effect, in the order it happened. */
let calls: string[] = [];

let calendarBehaviour: "succeeds" | "fails" | "slot_busy" = "succeeds";
let emailBehaviour: "sent" | "failed" | "not_configured" = "sent";
let holdBehaviour: "valid" | "expired" | "unavailable" = "valid";
let completedMarker: string | null = null;

const SLOT_START = "2026-08-24T16:00:00.000Z";
const HOLD_TOKEN = "a".repeat(64);

mock.module("@/lib/google/calendar", {
  namedExports: {
    fetchBusyPeriods: async () => {
      calls.push("google:freebusy");
      if (calendarBehaviour === "slot_busy") {
        return [
          {
            start: new Date(SLOT_START),
            end: new Date(new Date(SLOT_START).getTime() + 45 * 60000),
          },
        ];
      }
      return [];
    },
    createEvent: async () => {
      calls.push("google:create-event");
      if (calendarBehaviour === "fails") {
        const error = new Error("calendar down");
        error.name = "CalendarApiError";
        throw new CalendarApiError("calendar down", 502);
      }
      return { id: "event-abc123", htmlLink: "https://example.invalid" };
    },
    buildEventId: () => "event-abc123",
    CalendarApiError: class CalendarApiError extends Error {
      readonly status: number;
      constructor(message: string, status: number) {
        super(message);
        this.name = "CalendarApiError";
        this.status = status;
      }
    },
    CalendarNotConfiguredError: class CalendarNotConfiguredError extends Error {},
    DuplicateBookingError: class DuplicateBookingError extends Error {},
  },
});

const { CalendarApiError } = await import("@/lib/google/calendar");

mock.module("@/lib/booking/holds", {
  namedExports: {
    checkHold: async () => {
      calls.push("redis:check-hold");
      return holdBehaviour === "valid"
        ? { status: "valid", secondsRemaining: 900 }
        : { status: holdBehaviour };
    },
    releaseHold: async () => {
      calls.push("redis:release-hold");
      return true;
    },
    markBookingCompleted: async () => {
      calls.push("redis:mark-completed");
    },
    findCompletedBooking: async () => {
      calls.push("redis:find-completed");
      return completedMarker;
    },
  },
});

mock.module("@/lib/email/send", {
  namedExports: {
    sendBookingConfirmation: async () => {
      calls.push("resend:send");
      if (emailBehaviour === "sent") return { status: "sent", id: "resend-1" };
      if (emailBehaviour === "not_configured") return { status: "not_configured" };
      return { status: "failed", reason: "rejected" };
    },
    isEmailConfigured: () => true,
  },
});

/**
 * The postcode provider is faked: the suite must never call the live service.
 */
let postcodeBehaviour: "valid" | "not_found" | "unavailable" | "out_of_area" = "valid";

mock.module("@/lib/address/postcodes-io", {
  namedExports: {
    PostcodesIoProvider: class {
      async lookup() {
        calls.push("postcodes:lookup");
        if (postcodeBehaviour === "not_found") return { status: "not_found" };
        if (postcodeBehaviour === "unavailable") {
          return { status: "provider_unavailable" };
        }
        return {
          status: "valid",
          postcode: {
            postcode: "WV99 1AA",
            outcode: "WV99",
            areaName: "Wolverhampton",
            // Far away when the test wants an out-of-area postcode.
            latitude: postcodeBehaviour === "out_of_area" ? 51.5072 : 52.6,
            longitude: postcodeBehaviour === "out_of_area" ? -0.1276 : -2.12,
          },
        };
      }
    },
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

function bookingRequest(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/book", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slotStart: SLOT_START,
      fullName: "Jane Smith",
      email: "jane@example.com",
      phone: "07700 900123",
      houseOrName: "24",
      street: "Example Road",
      postcode: "WV99 1AA",
      addressConfirmedByCustomer: true,
      customerType: "landlord",
      applianceCount: 1,
      holdToken: HOLD_TOKEN,
      idempotencyKey: "attempt-0001",
      ...overrides,
    }),
  });
}

beforeEach(() => {
  calls = [];
  calendarBehaviour = "succeeds";
  emailBehaviour = "sent";
  holdBehaviour = "valid";
  completedMarker = null;
  postcodeBehaviour = "valid";
});

describe("transaction order", () => {
  test("a successful booking runs calendar first, then email", async () => {
    const response = await POST(bookingRequest());
    assert.equal(response.status, 200);

    const createdAt = calls.indexOf("google:create-event");
    const emailedAt = calls.indexOf("resend:send");

    assert.ok(createdAt >= 0, "the event must be created");
    assert.ok(emailedAt >= 0, "the email must be attempted");
    assert.ok(
      createdAt < emailedAt,
      `email must come after the calendar event, got: ${calls.join(" → ")}`,
    );
  });

  test("availability is re-checked before the event is written", async () => {
    await POST(bookingRequest());
    assert.ok(
      calls.indexOf("google:freebusy") < calls.indexOf("google:create-event"),
    );
  });

  test("the hold is validated before any calendar write", async () => {
    await POST(bookingRequest());
    assert.ok(
      calls.indexOf("redis:check-hold") < calls.indexOf("google:create-event"),
    );
  });

  test("the hold is released only after the event exists", async () => {
    await POST(bookingRequest());
    assert.ok(
      calls.indexOf("google:create-event") < calls.indexOf("redis:release-hold"),
    );
  });

  test("no email is sent when the calendar write fails", async () => {
    calendarBehaviour = "fails";
    const response = await POST(bookingRequest());

    assert.equal(response.status, 502);
    assert.ok(!calls.includes("resend:send"), "email must not be attempted");
  });

  test("no email is sent when the slot was taken during the hold", async () => {
    calendarBehaviour = "slot_busy";
    const response = await POST(bookingRequest());

    assert.equal(response.status, 409);
    assert.ok(!calls.includes("google:create-event"));
    assert.ok(!calls.includes("resend:send"));
  });

  test("no email is sent when the hold has expired", async () => {
    holdBehaviour = "expired";
    const response = await POST(bookingRequest());

    assert.equal(response.status, 409);
    assert.ok(!calls.includes("google:create-event"));
    assert.ok(!calls.includes("resend:send"));
  });

  test("no email is sent when validation fails", async () => {
    const response = await POST(bookingRequest({ email: "not-an-email" }));

    assert.equal(response.status, 400);
    assert.ok(!calls.includes("google:create-event"));
    assert.ok(!calls.includes("resend:send"));
  });
});

describe("an email failure never undoes a booking", () => {
  test("the booking still succeeds when the provider rejects the email", async () => {
    emailBehaviour = "failed";
    const response = await POST(bookingRequest());
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.booking.emailSent, false);
    assert.ok(body.booking.reference.startsWith("BSCJ-"));
  });

  test("the booking still succeeds when email is not configured at all", async () => {
    emailBehaviour = "not_configured";
    const response = await POST(bookingRequest());
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.booking.emailSent, false);
  });

  test("a failed email does not create a second calendar event", async () => {
    emailBehaviour = "failed";
    await POST(bookingRequest());
    assert.equal(
      calls.filter((call) => call === "google:create-event").length,
      1,
    );
  });

  test("a failed email does not release and recreate the appointment", async () => {
    emailBehaviour = "failed";
    await POST(bookingRequest());
    // Exactly one release, the normal post-booking one.
    assert.equal(
      calls.filter((call) => call === "redis:release-hold").length,
      1,
    );
  });

  test("a successful email is reported to the customer", async () => {
    const response = await POST(bookingRequest());
    const body = await response.json();
    assert.equal(body.booking.emailSent, true);
    assert.equal(body.booking.customerEmail, "jane@example.com");
  });
});

describe("duplicate confirmations", () => {
  test("a repeat submission creates no second event and sends no second email", async () => {
    const first = await POST(bookingRequest());
    assert.equal(first.status, 200);
    assert.equal(calls.filter((c) => c === "resend:send").length, 1);

    // The completed marker is what a second click would find.
    completedMarker = "event-abc123";
    calls = [];

    const second = await POST(bookingRequest());
    const body = await second.json();

    assert.equal(second.status, 409);
    assert.equal(body.error, "duplicate");
    assert.ok(!calls.includes("google:create-event"));
    assert.ok(!calls.includes("resend:send"), "must not email twice");
  });

  test("the duplicate check happens before the hold is examined", async () => {
    completedMarker = "event-abc123";
    await POST(bookingRequest());

    // Without this ordering a double click would report a false expiry,
    // because the first submission already released its own hold.
    assert.ok(calls.includes("redis:find-completed"));
    assert.ok(!calls.includes("redis:check-hold"));
  });
});

describe("the response given to the browser", () => {
  test("carries the booking reference, not internal identifiers", async () => {
    const response = await POST(bookingRequest());
    const body = await response.json();
    const serialised = JSON.stringify(body);

    assert.match(body.booking.reference, /^BSCJ-[0-9A-Z]{6}$/);
    assert.ok(!serialised.includes("event-abc123"), "raw event id leaked");
    assert.ok(!serialised.includes(HOLD_TOKEN), "hold token leaked");
    assert.ok(!serialised.includes("RESEND_API_KEY"));
  });

  test("carries the server-derived price, not a submitted one", async () => {
    const response = await POST(
      bookingRequest({ applianceCount: 5, priceTotal: 1 }),
    );
    const body = await response.json();
    // 45 base + 2 extra appliances at 15.
    assert.equal(body.booking.priceTotal, 75);
  });

  test("shows times in Europe/London, not UTC", async () => {
    const response = await POST(bookingRequest());
    const body = await response.json();

    // 16:00 UTC in August is 17:00 in London.
    assert.equal(body.booking.startLabel, "17:00");
    assert.equal(body.booking.endLabel, "17:45");
    assert.ok(body.booking.dateLabel.includes("24 August 2026"));
  });
});
