import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import { getPartsInZone, zonedTimeToUtc } from "@/lib/booking/time";
import { setKvClientForTesting, type KvClient } from "@/lib/kv/store";
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

let calendarBehaviour: "succeeds" | "fails" | "slot_busy" | "duplicate" =
  "succeeds";
let emailBehaviour: "sent" | "failed" | "not_configured" = "sent";
let holdBehaviour: "valid" | "expired" | "unavailable" = "valid";
let completedMarker: string | null = null;
/** The product the route asked the hold store to give back. */
let releasedProductId: string | null = null;

/** What the route actually asked the calendar and the mailer to do. */
let lastEvent: {
  description: string;
  summary: string;
  start: Date;
  end: Date;
} | null = null;
let lastEmail: {
  to: string;
  email: { subject: string; html: string; text: string };
  reference: string;
} | null = null;

/** How the V2 record behaves, and what reached it. */
let persistBehaviour: "records" | "unavailable" | "not_configured" = "records";
let persistCalls: Record<string, unknown>[] = [];
/** Jobs the fake has already recorded, keyed by idempotency key. */
let persistedKeys = new Map<string, string>();

/** The internal alert to BSCJ, and how the transport behaves for it. */
let notificationBehaviour: "sent" | "failed" | "not_configured" = "sent";
let lastNotification: {
  email: { subject: string; html: string; text: string };
  reference: string;
  customerEmail: string;
} | null = null;

/** The rendered internal notification, for the last booking. */
function notificationEmail(): { subject: string; html: string; text: string } {
  assert.ok(lastNotification, "no internal notification was sent");
  return lastNotification.email;
}

/** The description written into the calendar event, for the last booking. */
function eventDescription(): string {
  assert.ok(lastEvent, "no calendar event was created");
  return lastEvent.description;
}

/** The calendar event itself, for the last booking. */
function calendarEvent(): {
  description: string;
  summary: string;
  start: Date;
  end: Date;
} {
  assert.ok(lastEvent, "no calendar event was created");
  return lastEvent;
}

/** "19:00" for an instant, in the booking timezone. */
function londonTime(instant: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
}

/** How long the appointment written to the calendar actually runs. */
function eventMinutes(): number {
  const event = calendarEvent();
  return (event.end.getTime() - event.start.getTime()) / 60000;
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
function slotDaysAhead(days: number, hour = 14): string {
  const target = new Date(Date.now() + days * 24 * 60 * 60000);
  const parts = getPartsInZone(target, "Europe/London");
  // Saturdays are not worked, so shift onto the Sunday.
  const at = zonedTimeToUtc({ ...parts, hour, minute: 0 }, "Europe/London");
  if (at.getUTCDay() === 6) {
    return slotDaysAhead(days + 1, hour);
  }
  return at.toISOString();
}

/** The last start of the working day, and the one that must never exist. */
// SEVEN_PM/EIGHT_PM keep their names from when the day ended at 20:00; they
// now point at 21:00 and 22:00, which are the same two cases.
const SEVEN_PM = slotDaysAhead(20, 21);
const EIGHT_PM = slotDaysAhead(20, 22);

/** Inside the 14-day cancellation period, so an express request is required. */
const SLOT_START = slotDaysAhead(3);
/** Beyond the cancellation period, so no express request is needed. */
const FAR_SLOT_START = slotDaysAhead(20);
const HOLD_TOKEN = "a".repeat(64);

/**
 * Customer bookings already on the calendar for the day under test.
 *
 * `createEvent` pushes to it, so a second request in the same test counts the
 * first one — which is what makes the concurrency test meaningful.
 */
let existingBookings: { id: string; start: Date }[] = [];

/** Set only by the concurrency tests. See `meetingPoint`. */
let bookingReadBarrier: (() => Promise<void>) | null = null;

/**
 * Hoisted so the fake `createEvent` can throw the very class the route checks
 * with `instanceof`. A second definition would be a different class, and the
 * route would fall through to its generic 500 instead of its 409.
 */
class FakeDuplicateBookingError extends Error {
  constructor() {
    super("duplicate");
    this.name = "DuplicateBookingError";
  }
}

mock.module("@/lib/google/calendar", {
  namedExports: {
    fetchBookingEvents: async () => {
      calls.push("google:list-bookings");
      // Widens the window between counting and writing, so a concurrency test
      // exercises the guard instead of the scheduler. Null in every other test.
      // Snapshot at read time, exactly as a real response is: what existed
      // when Google was asked, not what exists when the caller resumes.
      // Spreading after the wait let the fake serialise the requests by itself
      // and quietly hid the race this is here to expose.
      const answer = [...existingBookings];
      if (bookingReadBarrier) await bookingReadBarrier();
      return answer;
    },
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
    createEvent: async (input: {
      description: string;
      summary: string;
      start: Date;
      end: Date;
    }) => {
      calls.push("google:create-event");
      lastEvent = input;
      existingBookings.push({ id: "event-abc123", start: input.start });
      if (calendarBehaviour === "duplicate") {
        // Google refuses an event id it has already seen. The deterministic
        // id means a repeat submission lands here rather than booking twice.
        throw new FakeDuplicateBookingError();
      }
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
    DuplicateBookingError: FakeDuplicateBookingError,
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
    releaseHold: async (
      _slotStart: string,
      _token: string,
      productId?: string,
    ) => {
      calls.push("redis:release-hold");
      releasedProductId = productId ?? null;
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
    sendBookingNotification: async (input: {
      email: { subject: string; html: string; text: string };
      reference: string;
      customerEmail: string;
    }) => {
      calls.push("resend:notify");
      lastNotification = input;
      if (notificationBehaviour === "sent") return { status: "sent", id: "resend-2" };
      if (notificationBehaviour === "not_configured") {
        return { status: "not_configured" };
      }
      return { status: "failed", reason: "rejected" };
    },
    isEmailConfigured: () => true,
    isBookingNotificationConfigured: () => notificationBehaviour !== "not_configured",
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

/**
 * The V2 record.
 *
 * Mocked so the booking route's use of it is observable, and so a database
 * failure can be simulated without one. The module's own behaviour — what it
 * writes, and that it never throws — is tested in
 * `lib/jobs/persist-booking.test.ts`.
 */
mock.module("@/lib/jobs/persist-booking", {
  namedExports: {
    persistWebsiteBooking: async (input: Record<string, unknown>) => {
      calls.push("db:persist-job");
      persistCalls.push(input);
      /*
        The real module catches everything and returns a value. A fake that
        threw would be testing a module that cannot exist — so "unavailable"
        returns the failure the way the real one does.
      */
      if (persistBehaviour === "unavailable") {
        return { status: "failed", reason: "write_failed" };
      }
      if (persistBehaviour === "not_configured") {
        return { status: "not_configured" };
      }
      // Idempotent by the submission's key, exactly as the real one is.
      const key = input.idempotencyKey as string;
      if (persistedKeys.has(key)) {
        return { status: "exists", jobId: persistedKeys.get(key) };
      }
      const jobId = `job-${persistedKeys.size + 1}`;
      persistedKeys.set(key, jobId);
      return { status: "created", jobId };
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
  lastNotification = null;
  notificationBehaviour = "sent";
  releasedProductId = null;
  existingBookings = [];
  bookingReadBarrier = null;
  persistBehaviour = "records";
  persistCalls = [];
  persistedKeys = new Map();
  setKvClientForTesting(null);
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

/**
 * The client can now be trusted to catch blank contact details, but it is not
 * the thing that matters. A request posted straight at the API must be refused
 * before anything is written.
 */
describe("required customer details are enforced at the API", () => {
  const missing: [string, Record<string, unknown>][] = [
    ["a blank name", { fullName: "" }],
    ["a whitespace-only name", { fullName: "   " }],
    ["a one-character name", { fullName: "J" }],
    ["a missing name field", { fullName: undefined }],
    ["a blank email", { email: "" }],
    ["a malformed email", { email: "not-an-email" }],
    ["a missing email field", { email: undefined }],
    ["a blank mobile", { phone: "" }],
    ["a landline", { phone: "01902123456" }],
    ["a missing mobile field", { phone: undefined }],
    ["an unknown customer type", { customerType: "something-else" }],
    ["a blank house number", { houseOrName: "" }],
    ["a blank street", { street: "" }],
    ["a malformed postcode", { postcode: "ZZZ" }],
    ["all three contact fields blank", { fullName: "", email: "", phone: "" }],
  ];

  for (const [label, overrides] of missing) {
    test(`${label} is rejected with 400`, async () => {
      const response = await POST(bookingRequest(overrides));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "validation_failed");
    });

    test(`${label} creates no calendar event`, async () => {
      await POST(bookingRequest(overrides));
      assert.equal(calls.includes("google:create-event"), false);
      assert.equal(calls.includes("resend:send"), false);
    });
  }

  test("the mobile is normalised before it reaches the calendar", async () => {
    await POST(bookingRequest({ phone: "07700 900 123" }));
    assert.ok(eventDescription().includes("Phone: +447700900123"));
  });

  test("a complete submission still books normally", async () => {
    const response = await POST(bookingRequest());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });
});

/**
 * The internal alert to BSCJ.
 *
 * A booking otherwise only appears quietly in the calendar, which is unsafe
 * when a customer can book a slot for later the same day. It is operational,
 * not contractual: it must always follow a successful booking, must never
 * precede one, and must never be able to undo one.
 */
describe("BSCJ is notified when a booking is created", () => {
  test("a successful booking sends one customer email and one internal alert", async () => {
    await POST(bookingRequest());

    assert.equal(calls.filter((c) => c === "resend:send").length, 1);
    assert.equal(calls.filter((c) => c === "resend:notify").length, 1);
  });

  test("the alert is sent only after the calendar event exists", async () => {
    await POST(bookingRequest());
    assert.ok(
      calls.indexOf("google:create-event") < calls.indexOf("resend:notify"),
      `notification must follow the event, got: ${calls.join(" → ")}`,
    );
  });

  test("the customer's confirmation goes first", async () => {
    // The customer is the one waiting on a screen.
    await POST(bookingRequest());
    assert.ok(calls.indexOf("resend:send") < calls.indexOf("resend:notify"));
  });

  test("it carries the reference, date, time and address", async () => {
    await POST(bookingRequest());
    const { text } = notificationEmail();

    assert.match(text, /BSCJ-/);
    assert.ok(text.includes("14:00"));
    assert.ok(text.includes("14:45"));
    assert.ok(text.includes("24 Example Road"));
    assert.ok(text.includes("WV99 1AA"));
  });

  test("it carries the customer's name, normalised mobile and email", async () => {
    await POST(bookingRequest({ phone: "07700 900 123" }));
    const { text } = notificationEmail();

    assert.ok(text.includes("Jane Smith"));
    assert.ok(text.includes("+447700900123"));
    assert.ok(text.includes("jane@example.com"));
  });

  test("it carries the customer type, appliance count and server-derived price", async () => {
    await POST(bookingRequest({ applianceCount: 5 }));
    const { text } = notificationEmail();

    assert.ok(text.includes("Landlord"));
    assert.match(text, /Appliances:\s+5/);
    // 45 base + 2 extra at 15 — the figure the server calculated, not a
    // number the browser could have sent.
    assert.match(text, /£75/);
  });

  test("replying to the alert reaches the customer", async () => {
    await POST(bookingRequest());
    assert.equal(lastNotification?.customerEmail, "jane@example.com");
  });

  test("a future booking gets the normal subject", async () => {
    // SLOT_START is three days out.
    assert.equal((await POST(bookingRequest())).status, 200);
    assert.match(notificationEmail().subject, /^NEW CP12 BOOKING —/);
    assert.equal(/URGENT/.test(notificationEmail().subject), false);
  });

  test("the same-day flag is derived from the slot, not from the request", async () => {
    /*
      The urgent subject itself is proved deterministically in
      booking-notification.test.ts, which drives `isSameDay` across the
      awkward cases directly. It is not asserted through the route because a
      same-day slot is only bookable in the early hours: the 12-hour minimum
      notice means that by mid-morning no slot later today is offered at all,
      so a route-level test would pass or fail depending on the clock.

      What the route owes is that the flag is computed server-side. A booking
      three days out must never be labelled same-day, whatever is sent.
    */
    await POST(
      bookingRequest({ sameDay: true, urgent: true } as Record<string, unknown>),
    );
    assert.match(notificationEmail().subject, /^NEW CP12 BOOKING —/);
    assert.equal(/URGENT|SAME-DAY/.test(notificationEmail().subject), false);
    assert.equal(/SAME-DAY/.test(notificationEmail().text), false);
  });

  test("a missing BOOKING_NOTIFICATION_EMAIL does not break the booking", async () => {
    notificationBehaviour = "not_configured";
    const response = await POST(bookingRequest());

    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.ok(calls.includes("google:create-event"));
  });

  test("a failed alert does not fail the booking", async () => {
    notificationBehaviour = "failed";
    const response = await POST(bookingRequest());
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.booking.reference);
  });

  test("a failed alert is not reported to the customer", async () => {
    // Our alerting is not their problem, and `emailSent` is about their own
    // confirmation only.
    notificationBehaviour = "failed";
    const body = await (await POST(bookingRequest())).json();
    assert.equal(body.booking.emailSent, true);
    assert.equal("notificationSent" in body.booking, false);
  });

  test("a failed alert creates no second calendar event", async () => {
    notificationBehaviour = "failed";
    await POST(bookingRequest());
    assert.equal(calls.filter((c) => c === "google:create-event").length, 1);
  });

  test("a duplicate submission sends no second alert", async () => {
    completedMarker = "event-abc123";
    const response = await POST(bookingRequest());

    assert.equal(response.status, 409);
    assert.equal(calls.includes("resend:notify"), false);
    assert.equal(calls.includes("google:create-event"), false);
  });

  test("a rejected booking sends no alert at all", async () => {
    const rejected: Record<string, unknown>[] = [
      { fullName: "" },
      { email: "not-an-email" },
      { phone: "" },
      { termsAccepted: false },
      { termsVersion: "2020-01-01" },
      { earlyPerformanceRequested: false },
    ];

    for (const overrides of rejected) {
      calls = [];
      await POST(bookingRequest(overrides));
      assert.equal(
        calls.includes("resend:notify"),
        false,
        `${JSON.stringify(overrides)} must not notify`,
      );
    }
  });

  test("a booking that fails at the calendar sends no alert", async () => {
    calendarBehaviour = "fails";
    await POST(bookingRequest());
    assert.equal(calls.includes("resend:notify"), false);
  });

  test("a slot taken during the hold sends no alert", async () => {
    calendarBehaviour = "slot_busy";
    await POST(bookingRequest());
    assert.equal(calls.includes("resend:notify"), false);
  });

  test("customer-controlled values are escaped in the alert", async () => {
    await POST(
      bookingRequest({
        fullName: '<script>alert(1)</script>',
        accessNotes: 'Gate <img src=x onerror="steal()">',
      }),
    );
    const { html } = notificationEmail();

    assert.equal(html.includes("<script"), false);
    assert.equal(html.includes("<img"), false);
    assert.ok(html.includes("&lt;script&gt;"));
  });

  test("no internal identifier reaches the alert", async () => {
    await POST(bookingRequest());
    const { html, text } = notificationEmail();

    for (const body of [html, text]) {
      assert.equal(body.includes(HOLD_TOKEN), false);
      assert.equal(body.includes("attempt-0001"), false);
      assert.equal(body.includes("event-abc123"), false);
      assert.equal(/terms accepted/i.test(body), false);
    }
  });
});

/**
 * The second product, and the rule that makes it safe: the browser names a
 * service and nothing else. Everything a booking costs and everything it
 * occupies in the diary is decided here, from the server's own registry.
 */
describe("the service being booked is the server's decision", () => {
  test("omitting the product books the £45 CP12, exactly as before", async () => {
    const response = await POST(bookingRequest());
    const body = await response.json();

    assert.equal(body.booking.productId, "cp12");
    assert.equal(body.booking.productName, "Gas Safety Certificate (CP12)");
    assert.equal(body.booking.priceTotal, 45);
    assert.equal(eventMinutes(), 45);
  });

  test("the bundle books at £90 for sixty minutes", async () => {
    const response = await POST(
      bookingRequest({ productId: "cp12-boiler-service" }),
    );
    const body = await response.json();

    assert.equal(body.booking.productId, "cp12-boiler-service");
    assert.equal(body.booking.productName, "CP12 + Annual Boiler Service");
    assert.equal(body.booking.priceTotal, 90);
    assert.equal(eventMinutes(), 60);
  });

  test("an unknown product is refused before anything is booked", async () => {
    const response = await POST(bookingRequest({ productId: "cp12-free" }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, "validation_failed");
    assert.ok(body.fieldErrors.productId);
    assert.equal(calls.includes("google:create-event"), false);
    assert.equal(calls.includes("resend:send"), false);
  });

  test("a product of the wrong type is refused, not coerced", async () => {
    for (const productId of [42, null, ["cp12"], { id: "cp12" }, ""]) {
      const response = await POST(bookingRequest({ productId }));
      assert.equal(response.status, 400, `accepted ${JSON.stringify(productId)}`);
    }
  });

  test("a submitted price cannot change what the customer is charged", async () => {
    const response = await POST(
      bookingRequest({
        productId: "cp12-boiler-service",
        priceTotal: 1,
        price: 1,
        basePrice: 1,
        total: 1,
      }),
    );
    const body = await response.json();

    assert.equal(body.booking.priceTotal, 90);
    assert.match(eventDescription(), /Price: £90 total/);
  });

  test("a submitted duration cannot change how long the booking runs", async () => {
    // A bundle claiming to be a quarter of an hour still occupies the hour it
    // actually needs — otherwise the diary would be quietly oversold.
    const response = await POST(
      bookingRequest({
        productId: "cp12-boiler-service",
        durationMinutes: 15,
        appointmentMinutes: 15,
        slotEnd: new Date(new Date(SLOT_START).getTime() + 15 * 60000).toISOString(),
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(eventMinutes(), 60);
  });

  test("a CP12 claiming to be an hour still takes forty-five minutes", async () => {
    await POST(bookingRequest({ productId: "cp12", durationMinutes: 60 }));
    assert.equal(eventMinutes(), 45);
  });

  test("extra appliances add £15 each, on either product", async () => {
    const cp12Response = await POST(bookingRequest({ applianceCount: 4 }));
    assert.equal((await cp12Response.json()).booking.priceTotal, 60);

    const bundleOne = await POST(
      bookingRequest({
        productId: "cp12-boiler-service",
        applianceCount: 4,
        idempotencyKey: "attempt-0002",
      }),
    );
    assert.equal((await bundleOne.json()).booking.priceTotal, 105);

    const bundleTwo = await POST(
      bookingRequest({
        productId: "cp12-boiler-service",
        applianceCount: 5,
        idempotencyKey: "attempt-0003",
      }),
    );
    assert.equal((await bundleTwo.json()).booking.priceTotal, 120);
  });
});

describe("the calendar entry says which service was booked", () => {
  test("a CP12 keeps the summary it has always had", async () => {
    await POST(bookingRequest());
    assert.match(calendarEvent().summary, /^CP12 — /);
  });

  test("a bundle is distinguishable at a glance in the diary", async () => {
    await POST(bookingRequest({ productId: "cp12-boiler-service" }));
    assert.match(calendarEvent().summary, /^CP12 \+ Boiler Service — /);
  });

  test("the event records the service and its length", async () => {
    await POST(bookingRequest({ productId: "cp12-boiler-service" }));
    const description = eventDescription();
    assert.match(description, /Service: CP12 \+ Annual Boiler Service/);
    assert.match(description, /Appointment: 60 minutes/);
  });

  test("the hold is given back for the product that took it", async () => {
    await POST(bookingRequest({ productId: "cp12-boiler-service" }));
    // A bundle reserved more than one start; releasing the wrong product would
    // leave the spillover held for the rest of its TTL.
    assert.equal(releasedProductId, "cp12-boiler-service");
  });
});

describe("both emails name the service that was booked", () => {
  test("the customer's confirmation names the CP12 and its price", async () => {
    await POST(bookingRequest());
    const email = confirmationEmail();

    assert.match(email.subject, /CP12 booking/);
    for (const body of [email.html, email.text]) {
      assert.ok(body.includes("Gas Safety Certificate (CP12)"));
      assert.ok(body.includes("45"));
    }
  });

  test("the customer's confirmation names the bundle and its price", async () => {
    await POST(bookingRequest({ productId: "cp12-boiler-service" }));
    const email = confirmationEmail();

    assert.match(email.subject, /CP12 \+ boiler service booking/);
    for (const body of [email.html, email.text]) {
      assert.ok(body.includes("CP12 + Annual Boiler Service"));
      assert.ok(body.includes("90"));
    }
  });

  test("the internal alert names the CP12, exactly as it always did", async () => {
    await POST(bookingRequest({ slotStart: FAR_SLOT_START }));
    assert.match(notificationEmail().subject, /^NEW CP12 BOOKING — /);
  });

  test("the internal alert names the bundle", async () => {
    await POST(
      bookingRequest({
        slotStart: FAR_SLOT_START,
        productId: "cp12-boiler-service",
      }),
    );
    const email = notificationEmail();

    assert.match(email.subject, /^NEW CP12 \+ BOILER SERVICE BOOKING — /);
    assert.ok(email.html.includes("CP12 + Annual Boiler Service"));
    assert.ok(email.text.includes("CP12 + Annual Boiler Service"));
  });

  test("the internal alert carries the server-derived bundle total", async () => {
    await POST(
      bookingRequest({
        slotStart: FAR_SLOT_START,
        productId: "cp12-boiler-service",
        applianceCount: 4,
        priceTotal: 1,
      }),
    );
    assert.ok(notificationEmail().text.includes("£105"));
  });

  test("a future bundle gets the normal subject, not the urgent one", async () => {
    /*
      The urgent form is proved deterministically for both products in
      booking-notification.test.ts, which drives the builder directly. It is
      not asserted through the route for the same reason the CP12's is not: a
      same-day slot is only bookable in the early hours, so the result would
      depend on the clock. What the route can prove is that adding a product
      did not disturb the branch.
    */
    await POST(
      bookingRequest({
        slotStart: FAR_SLOT_START,
        productId: "cp12-boiler-service",
      }),
    );
    assert.equal(/URGENT/.test(notificationEmail().subject), false);
  });
});

/**
 * The end of the working day, enforced where it actually matters: at the
 * write, not just in what the site offered.
 *
 * An appointment must finish inside working hours; the 15-minute buffer is
 * internal and may run past closing on the last job. So 19:00 is bookable for
 * both products — 19:00–19:45 and 19:00–20:00 — and 20:00 is bookable for
 * neither. Confirmed 31 August 2026.
 */
describe("the 19:00 boundary is enforced at the booking itself", () => {
  test("a CP12 books at the last start and runs 21:00–21:45", async () => {
    const response = await POST(bookingRequest({ slotStart: SEVEN_PM }));
    assert.equal(response.status, 200);

    const event = calendarEvent();
    assert.equal(eventMinutes(), 45);
    assert.equal(londonTime(event.start), "21:00");
    assert.equal(londonTime(event.end), "21:45");
  });

  test("a bundle books at the last start and runs to exactly 22:00", async () => {
    const response = await POST(
      bookingRequest({ slotStart: SEVEN_PM, productId: "cp12-boiler-service" }),
    );
    assert.equal(response.status, 200);

    const event = calendarEvent();
    assert.equal(eventMinutes(), 60);
    assert.equal(londonTime(event.start), "21:00");
    assert.equal(
      londonTime(event.end),
      "22:00",
      "the appointment must end exactly at closing, not before it",
    );
  });

  test("the buffer running to 22:15 is never written into the event", async () => {
    // The customer's appointment is what goes in the diary. The buffer is
    // scheduling protection, and it is applied by widening busy periods when
    // the next slot is offered — never by lengthening this booking.
    await POST(
      bookingRequest({ slotStart: SEVEN_PM, productId: "cp12-boiler-service" }),
    );
    assert.equal(eventMinutes(), 60);
    assert.notEqual(eventMinutes(), 75);
  });

  test("the confirmation tells the customer 21:00–22:00", async () => {
    const response = await POST(
      bookingRequest({ slotStart: SEVEN_PM, productId: "cp12-boiler-service" }),
    );
    const body = await response.json();

    assert.equal(body.booking.startLabel, "21:00");
    assert.equal(body.booking.endLabel, "22:00");
    for (const format of [confirmationEmail().html, confirmationEmail().text]) {
      assert.ok(format.includes("21:00"));
      assert.ok(format.includes("22:00"));
    }
  });

  test("neither product may start at 22:00", async () => {
    for (const productId of ["cp12", "cp12-boiler-service"]) {
      const response = await POST(
        bookingRequest({ slotStart: EIGHT_PM, productId }),
      );
      const body = await response.json();

      assert.equal(response.status, 409, `22:00 accepted for ${productId}`);
      assert.equal(body.error, "slot_taken");
      assert.equal(calls.includes("google:create-event"), false);
    }
  });

  test("a 22:00 start is refused before anything is written", async () => {
    await POST(
      bookingRequest({ slotStart: EIGHT_PM, productId: "cp12-boiler-service" }),
    );
    // The availability re-check is the gate, and it closes ahead of the write.
    assert.ok(calls.includes("google:freebusy"));
    assert.equal(calls.includes("google:create-event"), false);
    assert.equal(calls.includes("resend:send"), false);
    assert.equal(calls.includes("resend:notify"), false);
  });
});

/**
 * The standalone Annual Boiler Service.
 *
 * The rule that matters most here is a negative one: the certificate's
 * extra-appliance surcharge must not be able to reach it. £60 is £60.
 */
describe("the standalone boiler service is a fixed £60", () => {
  const SERVICE = "boiler-service";

  test("it books at £60 for its sixty-minute allocation", async () => {
    const response = await POST(bookingRequest({ productId: SERVICE }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.booking.productId, SERVICE);
    assert.equal(body.booking.productName, "Annual Boiler Service");
    assert.equal(body.booking.priceTotal, 60);
    assert.equal(eventMinutes(), 60);
  });

  test("no appliance count can add a surcharge to it", async () => {
    for (const applianceCount of [1, 3, 4, 5, 12]) {
      const response = await POST(
        bookingRequest({
          productId: SERVICE,
          applianceCount,
          idempotencyKey: `service-${applianceCount}`,
        }),
      );
      const body = await response.json();
      assert.equal(
        body.booking.priceTotal,
        60,
        `${applianceCount} appliances changed the price`,
      );
    }
  });

  test("a submitted price cannot change what it costs", async () => {
    const response = await POST(
      bookingRequest({
        productId: SERVICE,
        priceTotal: 1,
        price: 1,
        basePrice: 1,
        extraAppliancePrice: 15,
      }),
    );
    assert.equal((await response.json()).booking.priceTotal, 60);
    assert.match(eventDescription(), /Price: £60 total/);
  });

  test("a submitted duration cannot change how long it runs", async () => {
    await POST(
      bookingRequest({
        productId: SERVICE,
        durationMinutes: 15,
        appointmentMinutes: 15,
      }),
    );
    assert.equal(eventMinutes(), 60);
  });

  test("the diary entry names the service and carries no appliance count", async () => {
    await POST(bookingRequest({ productId: SERVICE, applianceCount: 5 }));

    assert.match(calendarEvent().summary, /^Boiler Service — /);
    const description = eventDescription();
    assert.match(description, /Service: Annual Boiler Service/);
    assert.match(description, /Appointment: 60 minutes/);
    // An appliance count here would describe work that is not being done.
    assert.equal(/Appliances:/.test(description), false);
  });

  test("both emails name the service and its price, without appliances", async () => {
    await POST(
      bookingRequest({
        slotStart: FAR_SLOT_START,
        productId: SERVICE,
        applianceCount: 5,
      }),
    );

    const customer = confirmationEmail();
    assert.match(customer.subject, /Boiler Service booking/);
    for (const body of [customer.html, customer.text]) {
      assert.ok(body.includes("Annual Boiler Service"));
      assert.ok(body.includes("60"));
      assert.equal(/\bappliances\b/i.test(body), false);
    }

    const internal = notificationEmail();
    assert.match(internal.subject, /^NEW BOILER SERVICE BOOKING — /);
    for (const body of [internal.html, internal.text]) {
      assert.ok(body.includes("Annual Boiler Service"));
      assert.ok(body.includes("60"));
      assert.equal(/appliance/i.test(body), false);
    }
  });

  test("the last start is valid and runs to exactly 22:00", async () => {
    const response = await POST(
      bookingRequest({ slotStart: SEVEN_PM, productId: SERVICE }),
    );
    assert.equal(response.status, 200);
    assert.equal(eventMinutes(), 60);
    assert.equal(londonTime(calendarEvent().start), "21:00");
    assert.equal(londonTime(calendarEvent().end), "22:00");
  });

  test("22:00 is refused, as it is for every product", async () => {
    const response = await POST(
      bookingRequest({ slotStart: EIGHT_PM, productId: SERVICE }),
    );
    assert.equal(response.status, 409);
    assert.equal(calls.includes("google:create-event"), false);
  });

  test("the certificate products are untouched by any of this", async () => {
    const cp12 = await POST(bookingRequest({ applianceCount: 4 }));
    assert.equal((await cp12.json()).booking.priceTotal, 60);
    assert.equal(eventMinutes(), 45);

    const bundle = await POST(
      bookingRequest({
        productId: "cp12-boiler-service",
        applianceCount: 4,
        idempotencyKey: "bundle-regression",
      }),
    );
    assert.equal((await bundle.json()).booking.priceTotal, 105);
    assert.equal(eventMinutes(), 60);
  });
});

/**
 * The daily cap, enforced where it cannot be bypassed.
 *
 * Availability hides a full day, but availability is advice. These are the
 * checks that run against Google immediately before the write, so a crafted
 * POST cannot talk its way past them.
 */
describe("the daily booking limit is enforced at the write", () => {
  /** A real store, so the per-day lock actually serialises. */
  class FakeKv implements KvClient {
    private data = new Map<string, string>();
    async setIfAbsent(key: string, value: string) {
      if (this.data.has(key)) return false;
      this.data.set(key, value);
      return true;
    }
    async get(key: string) {
      return this.data.get(key) ?? null;
    }
    async deleteIfEqual(key: string, value: string) {
      if (this.data.get(key) !== value) return false;
      this.data.delete(key);
      return true;
    }
    async ttl() {
      return 15;
    }
    async mget(keys: string[]) {
      return keys.map((key) => this.data.get(key) ?? null);
    }
    async set(key: string, value: string) {
      this.data.set(key, value);
    }
    async incrementWithTtl() {
      return 1;
    }
  }

  /** `count` existing customer bookings on the day SLOT_START falls on. */
  function fillDay(count: number) {
    const day = new Date(SLOT_START);
    existingBookings = Array.from({ length: count }, (_, index) => ({
      id: `bscj-existing-${index}`,
      start: new Date(day.getTime() - (index + 1) * 60 * 60000),
    }));
  }

  test("the cap is checked against Google before the event is written", async () => {
    await POST(bookingRequest());
    const listed = calls.indexOf("google:list-bookings");
    const created = calls.indexOf("google:create-event");

    assert.ok(listed >= 0, "the existing bookings were never counted");
    assert.ok(listed < created, "the cap was checked after the write");
  });

  test("nine existing bookings still permit one more", async () => {
    fillDay(9);
    const response = await POST(bookingRequest());

    assert.equal(response.status, 200);
    assert.ok(calls.includes("google:create-event"));
  });

  test("ten existing bookings refuse an eleventh, whatever the client sends", async () => {
    fillDay(10);
    const response = await POST(bookingRequest());
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.error, "day_full");
    assert.equal(calls.includes("google:create-event"), false);
    assert.equal(calls.includes("resend:send"), false);
    assert.equal(calls.includes("resend:notify"), false);
  });

  test("ordinary blocking events do not count toward the ten", async () => {
    // The day is thick with the engineer's own diary, and empty of customers.
    existingBookings = [];
    const response = await POST(bookingRequest());
    assert.equal(response.status, 200);
  });

  test("bookings on other days do not fill this one", async () => {
    const otherDay = new Date(new Date(SLOT_START).getTime() + 5 * 24 * 3600_000);
    existingBookings = Array.from({ length: 10 }, (_, index) => ({
      id: `bscj-other-${index}`,
      start: new Date(otherDay.getTime() + index * 60 * 60000),
    }));

    assert.equal((await POST(bookingRequest())).status, 200);
  });

  /**
   * Holds every caller until `expected` of them have arrived, or the wait
   * elapses.
   *
   * This is what makes the concurrency test mean something. Left to the
   * scheduler, two mocked requests interleave in whatever order their promises
   * happen to resolve, and the test can pass with the guard removed. Parking
   * both requests between counting and writing guarantees the race: with no
   * lock they both count nine and both write, and with the lock the second
   * cannot reach the barrier until the first has finished and released.
   */
  function meetingPoint(expected: number, waitMs: number) {
    let arrived = 0;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    return async () => {
      arrived += 1;
      if (arrived >= expected) {
        open();
        return;
      }
      await Promise.race([
        gate,
        new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
      ]);
    };
  }

  test("two simultaneous confirmations cannot both take the last slot", async () => {
    /*
      Nine already booked, and two customers confirming at once. Counting and
      writing are two steps, so without the per-day lock both would count nine
      and both would write a tenth — eleven appointments in a day capped at
      ten. The lock makes the second one count after the first has landed.
    */
    setKvClientForTesting(new FakeKv());
    fillDay(9);
    bookingReadBarrier = meetingPoint(2, 250);

    const [first, second] = await Promise.all([
      POST(bookingRequest({ idempotencyKey: "attempt-a" })),
      POST(bookingRequest({ idempotencyKey: "attempt-b" })),
    ]);
    const statuses = [first.status, second.status].sort();

    assert.deepEqual(statuses, [200, 409], "both attempts were allowed through");
    assert.equal(
      calls.filter((call) => call === "google:create-event").length,
      1,
      "two events were written for the same last slot",
    );
    assert.equal(
      existingBookings.length,
      10,
      "the day ended up with more than the ten it allows",
    );
  });

  test("the loser is told why, and it is a reason they can act on", async () => {
    setKvClientForTesting(new FakeKv());
    fillDay(9);
    bookingReadBarrier = meetingPoint(2, 250);

    const responses = await Promise.all([
      POST(bookingRequest({ idempotencyKey: "attempt-c" })),
      POST(bookingRequest({ idempotencyKey: "attempt-d" })),
    ]);
    const refused = responses.find((response) => response.status === 409);
    assert.ok(refused);

    const body = await refused.json();
    assert.ok(["day_full", "day_busy"].includes(body.error), body.error);
    assert.match(body.message, /day|try again/i);
  });

  test("the day is released again, so the next booking is not blocked", async () => {
    setKvClientForTesting(new FakeKv());
    existingBookings = [];

    assert.equal((await POST(bookingRequest({ idempotencyKey: "release-one" }))).status, 200);
    // If the lock leaked, this would be refused as day_busy rather than booked.
    assert.equal((await POST(bookingRequest({ idempotencyKey: "release-two" }))).status, 200);
  });

  test("a refused booking still releases the day", async () => {
    setKvClientForTesting(new FakeKv());
    fillDay(10);

    assert.equal((await POST(bookingRequest({ idempotencyKey: "refused-x" }))).status, 409);

    existingBookings = [];
    assert.equal((await POST(bookingRequest({ idempotencyKey: "refused-y" }))).status, 200);
  });

  test("without a reservation store the booking still goes through", async () => {
    // Degraded, not broken: the Google count is still the authority, and
    // failing real bookings because Redis is down would be the worse outcome.
    setKvClientForTesting(null);
    fillDay(9);

    assert.equal((await POST(bookingRequest())).status, 200);
  });
});

/**
 * The V2 record, from the booking route's side.
 *
 * The rule: recording a job is the last thing that happens and the least
 * important. The appointment already exists in the calendar and the customer
 * has already been emailed, so nothing here may change what the customer sees.
 */
describe("persisting the booking to the V2 database", () => {
  test("a successful booking records exactly one job", async () => {
    const response = await POST(bookingRequest());
    assert.equal(response.status, 200);

    assert.equal(
      calls.filter((call) => call === "db:persist-job").length,
      1,
      "the job was not recorded exactly once",
    );
    assert.equal(persistedKeys.size, 1);
  });

  test("it happens only after the calendar event exists", async () => {
    // The ordering the whole design rests on: the appointment is real before
    // anything else is attempted.
    await POST(bookingRequest());

    assert.ok(
      calls.indexOf("db:persist-job") > calls.indexOf("google:create-event"),
      "the job was recorded before the calendar event existed",
    );
  });

  test("it happens after both emails, so bookkeeping never delays a customer", async () => {
    await POST(bookingRequest());

    assert.ok(calls.indexOf("db:persist-job") > calls.indexOf("email:send"));
    assert.ok(calls.indexOf("db:persist-job") > calls.indexOf("email:notify"));
  });

  test("a booking that never reached the calendar records nothing", async () => {
    calendarBehaviour = "fails";

    const response = await POST(bookingRequest());
    assert.equal(response.status, 502);
    assert.equal(calls.includes("db:persist-job"), false);
  });

  test("a rejected booking records nothing", async () => {
    // Validation failed, so there is no appointment and nothing to record.
    const response = await POST(bookingRequest({ postcode: "not a postcode" }));
    assert.notEqual(response.status, 200);
    assert.equal(calls.includes("db:persist-job"), false);
  });

  test("the reference recorded is the one the customer was given", async () => {
    const response = await POST(bookingRequest());
    const body = (await response.json()) as { booking: { reference: string } };

    assert.equal(persistCalls.length, 1);
    assert.equal(persistCalls[0].reference, body.booking.reference);
  });

  test("it is handed the server's own price and product, not the browser's", async () => {
    // The request below claims four appliances; the price must be the server's
    // arithmetic on the server's registry, never a figure from the payload.
    await POST(bookingRequest({ applianceCount: 4, productId: "cp12" }));

    assert.equal(persistCalls[0].productId, "cp12");
    assert.equal(persistCalls[0].priceTotal, 60);
    assert.equal(persistCalls[0].applianceCount, 4);
    assert.equal(persistCalls[0].extraAppliances, 1);
  });

  test("it is handed the appointment the calendar actually holds", async () => {
    await POST(bookingRequest());
    const event = calendarEvent();

    assert.deepEqual(persistCalls[0].appointmentStart, event.start);
    assert.deepEqual(persistCalls[0].appointmentEnd, event.end);
  });

  test("a database outage does not fail a confirmed booking", async () => {
    /*
      The guarantee. The appointment exists and the customer has been emailed;
      a failure to write our own record must be invisible to them.
    */
    persistBehaviour = "unavailable";

    const response = await POST(bookingRequest());
    const body = (await response.json()) as {
      ok: boolean;
      booking: { reference: string; emailSent: boolean };
    };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.booking.reference);
    assert.equal(body.booking.emailSent, true);
  });

  test("no database configured does not fail a booking either", async () => {
    persistBehaviour = "not_configured";

    const response = await POST(bookingRequest());
    assert.equal(response.status, 200);
  });

  test("the response says nothing about whether the record was written", async () => {
    // It is not the customer's problem, and a warning about our own
    // bookkeeping would only worry them.
    persistBehaviour = "unavailable";

    const response = await POST(bookingRequest());
    const body = (await response.json()) as { booking: Record<string, unknown> };

    for (const key of Object.keys(body.booking)) {
      assert.equal(
        /job|persist|database|record/i.test(key),
        false,
        `the response leaks bookkeeping state in "${key}"`,
      );
    }
  });

  test("a retried submission does not record a second job", async () => {
    /*
      Same idempotency key, twice. V1 refuses the second outright — the
      completed-booking marker makes it a 409 before anything runs — so the
      recording step is never even reached. Idempotency here is therefore
      belt and braces, and `lib/jobs/persist-booking.test.ts` proves the
      braces hold on their own.
    */
    const first = await POST(bookingRequest());
    assert.equal(first.status, 200);
    assert.equal(persistedKeys.size, 1);

    completedMarker = "event-abc123";
    const second = await POST(bookingRequest());

    assert.equal(second.status, 409, "V1 no longer refuses a duplicate");
    assert.equal(persistedKeys.size, 1, "a second job was recorded");
  });

  test("a duplicate caught by the calendar records nothing either", async () => {
    // The marker is gone — say Redis was unavailable — so the deterministic
    // event id is what catches it. Still no second job.
    const first = await POST(bookingRequest());
    assert.equal(first.status, 200);

    calendarBehaviour = "duplicate";
    const second = await POST(bookingRequest());

    assert.equal(second.status, 409);
    assert.equal(persistedKeys.size, 1, "a second job was recorded");
  });
});
