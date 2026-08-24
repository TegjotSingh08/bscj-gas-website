import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import { getPartsInZone, zonedTimeToUtc } from "@/lib/booking/time";
import { TERMS_VERSION } from "@/lib/booking/terms";

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

/** What the route actually asked the calendar and the mailer to do. */
let lastEvent: { description: string } | null = null;
let lastEmail: {
  to: string;
  email: { subject: string; html: string; text: string };
  reference: string;
} | null = null;

/** The description written into the calendar event, for the last booking. */
function eventDescription(): string {
  assert.ok(lastEvent, "no calendar event was created");
  return lastEvent.description;
}

/** The rendered confirmation email, for the last booking. */
function confirmationEmail(): { subject: string; html: string; text: string } {
  assert.ok(lastEmail, "no confirmation email was sent");
  return lastEmail.email;
}

/**
 * Slots are computed relative to now rather than hard-coded, because the route
 * validates them against the real availability rules — minimum notice, the
 * 30-day horizon and the closed Saturday. A fixed calendar date would quietly
 * start failing once it fell into the past.
 */
function slotDaysAhead(days: number): string {
  const target = new Date(Date.now() + days * 24 * 60 * 60000);
  const parts = getPartsInZone(target, "Europe/London");
  // Saturdays are not worked, so shift onto the Sunday.
  const at14 = zonedTimeToUtc({ ...parts, hour: 14, minute: 0 }, "Europe/London");
  if (at14.getUTCDay() === 6) {
    return slotDaysAhead(days + 1);
  }
  return at14.toISOString();
}

/** Inside the 14-day cancellation period, so an express request is required. */
const SLOT_START = slotDaysAhead(3);
/** Beyond the cancellation period, so no express request is needed. */
const FAR_SLOT_START = slotDaysAhead(20);
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
    createEvent: async (input: { description: string }) => {
      calls.push("google:create-event");
      lastEvent = input;
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
    sendBookingConfirmation: async (input: {
      to: string;
      email: { subject: string; html: string; text: string };
      reference: string;
    }) => {
      calls.push("resend:send");
      lastEmail = input;
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
      termsAccepted: true,
      termsVersion: TERMS_VERSION,
      // SLOT_START is inside the cancellation period, so this is required.
      earlyPerformanceRequested: true,
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
  lastEvent = null;
  lastEmail = null;
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

    // The slot is built at 14:00 London whatever the UTC offset that day, so
    // a label of 14:00 proves the response is rendered in London time rather
    // than echoing the UTC instant back.
    assert.equal(body.booking.startLabel, "14:00");
    assert.equal(body.booking.endLabel, "14:45");

    const expectedDay = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(SLOT_START));
    assert.ok(
      body.booking.dateLabel.includes(expectedDay),
      `${body.booking.dateLabel} should contain ${expectedDay}`,
    );
  });
});

/**
 * The contractual gate, exercised against the real handler.
 *
 * A booking made online is a distance service contract. The customer must have
 * accepted the terms they were actually shown, and where the appointment falls
 * inside the 14-day cancellation period the engineer may not attend without
 * the customer's express request. None of that may be decidable by the
 * browser, and none of it may be reached after a calendar event exists.
 */
describe("terms and cancellation rights are enforced server-side", () => {
  test("a booking without accepted terms is refused", async () => {
    const response = await POST(bookingRequest({ termsAccepted: false }));
    assert.equal(response.status, 400);
  });

  test("no calendar event is created when the terms are not accepted", async () => {
    await POST(bookingRequest({ termsAccepted: false }));
    assert.equal(calls.includes("google:create-event"), false);
  });

  test("no confirmation email is sent when the terms are not accepted", async () => {
    await POST(bookingRequest({ termsAccepted: false }));
    assert.equal(calls.includes("resend:send"), false);
  });

  test("omitting the acceptance entirely is refused", async () => {
    const response = await POST(bookingRequest({ termsAccepted: undefined }));
    assert.equal(response.status, 400);
    assert.equal(calls.includes("google:create-event"), false);
  });

  test("a truthy value cannot stand in for acceptance", async () => {
    for (const forged of ["true", "yes", 1, "on"]) {
      calls = [];
      const response = await POST(bookingRequest({ termsAccepted: forged }));
      assert.equal(response.status, 400, `${JSON.stringify(forged)} must fail`);
      assert.equal(calls.includes("google:create-event"), false);
    }
  });

  test("a stale terms version is refused, even with acceptance ticked", async () => {
    const response = await POST(
      bookingRequest({ termsAccepted: true, termsVersion: "2020-01-01" }),
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, "terms_required");
    assert.equal(body.problem, "terms_version_stale");
    assert.equal(calls.includes("google:create-event"), false);
  });

  test("a missing terms version is refused", async () => {
    const response = await POST(bookingRequest({ termsVersion: undefined }));
    assert.equal(response.status, 400);
    assert.equal(calls.includes("google:create-event"), false);
  });

  test("an appointment inside the cancellation period needs the express request", async () => {
    const response = await POST(
      bookingRequest({ earlyPerformanceRequested: false }),
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.problem, "early_performance_not_requested");
    assert.equal(calls.includes("google:create-event"), false);
  });

  test("omitting the express request is the same as not making one", async () => {
    const response = await POST(
      bookingRequest({ earlyPerformanceRequested: undefined }),
    );
    assert.equal(response.status, 400);
    assert.equal(calls.includes("google:create-event"), false);
  });

  test("the browser cannot make the requirement disappear", async () => {
    // The payload carries only whether the customer ticked the box. Whether a
    // request was needed is recomputed here from the slot, so stripping the
    // field — or claiming the appointment is far away — changes nothing.
    const response = await POST(
      bookingRequest({
        earlyPerformanceRequested: false,
        // A fabricated field the server has never heard of.
        earlyPerformanceRequired: false,
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(calls.includes("google:create-event"), false);
  });

  test("an appointment beyond the period needs no express request", async () => {
    const response = await POST(
      bookingRequest({
        slotStart: FAR_SLOT_START,
        earlyPerformanceRequested: false,
      }),
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });

  test("the address confirmation stays a separate requirement", async () => {
    // Accepting the terms does not confirm the address, and vice versa.
    const response = await POST(
      bookingRequest({ addressConfirmedByCustomer: false }),
    );
    assert.equal(response.status, 400);
    assert.equal(calls.includes("google:create-event"), false);
  });

  test("the gate closes before the postcode service and the calendar are touched", async () => {
    // Deliberately a stale *version* rather than termsAccepted:false. The
    // schema types acceptance as a literal true, so `false` never reaches the
    // gate at all — it is rejected at parse time, and a test using it would
    // pass without proving anything about ordering. A stale version parses
    // cleanly and can only be caught by the gate itself.
    await POST(bookingRequest({ termsVersion: "2020-01-01" }));

    assert.equal(calls.includes("postcodes:lookup"), false);
    assert.equal(calls.includes("google:freebusy"), false);
    assert.equal(calls.includes("google:create-event"), false);
  });

  test("a rejected booking never reaches the free postcode service", async () => {
    // Postcodes.io is donated public infrastructure. A request that cannot
    // succeed should not consume a lookup.
    await POST(bookingRequest({ earlyPerformanceRequested: false }));
    assert.equal(calls.includes("postcodes:lookup"), false);
  });
});

describe("the booking records what was agreed", () => {
  test("the calendar event carries the terms version accepted", async () => {
    await POST(bookingRequest());
    assert.ok(eventDescription().includes(`Terms accepted: v${TERMS_VERSION}`));
  });

  test("it records the end of the cancellation period", async () => {
    await POST(bookingRequest());
    assert.match(eventDescription(), /Cancellation period ends: \w+, \d+ \w+ \d{4}/);
  });

  test("it records that an early start was requested", async () => {
    await POST(bookingRequest());
    assert.match(eventDescription(), /Early-start requested: yes/);
  });

  test("it records when no early start was needed", async () => {
    await POST(bookingRequest({ slotStart: FAR_SLOT_START }));
    assert.match(eventDescription(), /Early-start requested: not needed/);
  });

  test("no hold token, key or secret is written into the event", async () => {
    await POST(bookingRequest());
    const description = eventDescription();

    assert.equal(description.includes(HOLD_TOKEN), false);
    assert.equal(description.includes("attempt-0001"), false);
    assert.equal(/token/i.test(description), false);
  });
});

/**
 * Regulation 16 confirmation.
 *
 * The information has to reach the customer on a durable medium. An email is
 * one; a link inside an email to a page that can change is not. So these
 * assertions are against the rendered email body, not against a link in it.
 */
describe("the confirmation carries the cancellation information", () => {
  test("the email states the 14-day right and the exact deadline", async () => {
    await POST(bookingRequest());
    const { text } = confirmationEmail();

    assert.match(text, /right to cancel this contract within 14 days/i);
    assert.match(text, /cancellation period expires at the end of \w+, \d+ \w+ \d{4}/i);
  });

  test("the email says how to cancel, without demanding a particular form", async () => {
    await POST(bookingRequest());
    const { text } = confirmationEmail();

    assert.match(text, /tell us clearly that you want to/i);
    assert.match(text, /you do\s*\n?\s*not have to/i);
  });

  test("the email records the terms version accepted", async () => {
    await POST(bookingRequest());
    assert.ok(confirmationEmail().text.includes(TERMS_VERSION));
    assert.ok(confirmationEmail().html.includes(TERMS_VERSION));
  });

  test("an early start is spelled out, with the proportionate-payment rule", async () => {
    await POST(bookingRequest());
    const { text } = confirmationEmail();

    assert.match(text, /inside that 14-day period/i);
    assert.match(text, /lose the right to cancel/i);
    assert.match(text, /proportionate amount/i);
  });

  test("an appointment outside the period says so instead", async () => {
    await POST(bookingRequest({ slotStart: FAR_SLOT_START }));
    const { text } = confirmationEmail();

    assert.match(text, /falls after that period/i);
    assert.equal(/lose the right to cancel/i.test(text), false);
  });

  test("the cancellation information reaches both parts of the email", async () => {
    await POST(bookingRequest());
    const { html, text } = confirmationEmail();

    for (const body of [html, text]) {
      assert.match(body, /right to cancel/i);
    }
  });

  test("nothing promises a cancellation charge", async () => {
    await POST(bookingRequest());
    const { html, text } = confirmationEmail();

    for (const body of [html, text]) {
      assert.equal(/cancellation fee of/i.test(body), false);
      assert.equal(/£5/.test(body), false);
    }
  });

  test("the cancellation information is only sent once the booking exists", async () => {
    await POST(bookingRequest());
    assert.ok(
      calls.indexOf("google:create-event") < calls.indexOf("resend:send"),
    );
  });
});
