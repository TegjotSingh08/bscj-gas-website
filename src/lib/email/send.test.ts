import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { isEmailConfigured, sendBookingConfirmation } from "./send";
import { renderBookingConfirmationEmail } from "./booking-confirmation";

const EMAIL = renderBookingConfirmationEmail({
  reference: "BSCJ-A1B2C3",
  customerName: "Jane Smith",
  dateLabel: "Monday, 24 August 2026",
  startLabel: "17:00",
  endLabel: "17:45",
  subjectDateLabel: "Monday 24 August",
  addressLines: ["197 Sweetman Street", "Wolverhampton", "WV6 0AR"],
  applianceCount: 1,
  priceTotal: 45,
});

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalWarn = console.warn;

/** Captures what the transport actually sent, without a network call. */
let lastRequest: { url: string; init: RequestInit } | null = null;
let warnings: string[] = [];

function stubFetch(handler: (init: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
    lastRequest = { url: String(url), init };
    return handler(init);
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  lastRequest = null;
  warnings = [];
  console.warn = (message: string) => warnings.push(String(message));
  process.env.RESEND_API_KEY = "re_test_secret_key_value";
  process.env.BOOKING_EMAIL_FROM = "BSCJ Gas & Heating <bookings@example.com>";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  process.env = { ...originalEnv };
});

const send = () =>
  sendBookingConfirmation({
    to: "jane@example.com",
    email: EMAIL,
    reference: "BSCJ-A1B2C3",
  });

describe("configuration", () => {
  test("reports configured when both variables are present", () => {
    assert.equal(isEmailConfigured(), true);
  });

  test("reports not configured without an api key", () => {
    delete process.env.RESEND_API_KEY;
    assert.equal(isEmailConfigured(), false);
  });

  test("sending without configuration is a no-op, not an error", async () => {
    delete process.env.RESEND_API_KEY;
    let called = false;
    stubFetch(() => {
      called = true;
      return json({ id: "x" });
    });

    const result = await send();
    assert.equal(result.status, "not_configured");
    assert.equal(called, false, "must not call the provider without a key");
  });
});

describe("a successful send", () => {
  test("returns sent with the provider id", async () => {
    stubFetch(() => json({ id: "resend-123" }));
    const result = await send();
    assert.deepEqual(result, { status: "sent", id: "resend-123" });
  });

  test("posts both an html and a plain text body", async () => {
    stubFetch(() => json({ id: "resend-123" }));
    await send();

    const body = JSON.parse(String(lastRequest?.init.body));
    assert.ok(body.html.includes("<html"));
    assert.ok(body.text.includes("YOU'RE BOOKED"));
    assert.equal(body.subject, EMAIL.subject);
    assert.deepEqual(body.to, ["jane@example.com"]);
  });

  test("sends a reply-to that reaches a real inbox", async () => {
    stubFetch(() => json({ id: "resend-123" }));
    await send();
    const body = JSON.parse(String(lastRequest?.init.body));
    assert.ok(body.reply_to.includes("@"));
  });

  test("carries an idempotency key derived from the booking reference", async () => {
    stubFetch(() => json({ id: "resend-123" }));
    await send();

    const headers = lastRequest?.init.headers as Record<string, string>;
    assert.equal(headers["Idempotency-Key"], "booking-confirmation-BSCJ-A1B2C3");
  });

  test("the idempotency key is not the customer's email address", async () => {
    stubFetch(() => json({ id: "resend-123" }));
    await send();
    const headers = lastRequest?.init.headers as Record<string, string>;
    assert.ok(!headers["Idempotency-Key"].includes("jane@example.com"));
  });

  test("two sends for the same booking reuse the same idempotency key", async () => {
    stubFetch(() => json({ id: "resend-123" }));
    await send();
    const first = (lastRequest?.init.headers as Record<string, string>)[
      "Idempotency-Key"
    ];
    await send();
    const second = (lastRequest?.init.headers as Record<string, string>)[
      "Idempotency-Key"
    ];
    assert.equal(first, second);
  });
});

describe("failures never throw", () => {
  const cases: [string, () => void, string][] = [
    ["the provider rejects the request", () => stubFetch(() => json({ message: "bad" }, 422)), "rejected"],
    ["the api key is wrong", () => stubFetch(() => json({}, 401)), "unauthorised"],
    ["access is forbidden", () => stubFetch(() => json({}, 403)), "unauthorised"],
    ["the account is rate limited", () => stubFetch(() => json({}, 429)), "rate_limited"],
    ["the provider errors", () => stubFetch(() => json({}, 500)), "rejected"],
    [
      "the response is malformed",
      () =>
        stubFetch(
          () => new Response("not json at all", { status: 200 }),
        ),
      "malformed_response",
    ],
    [
      "the network is down",
      () =>
        stubFetch(() => {
          throw new TypeError("fetch failed");
        }),
      "network",
    ],
  ];

  for (const [description, arrange, expectedReason] of cases) {
    test(`${description} → failed(${expectedReason}), no throw`, async () => {
      arrange();
      const result = await send();
      assert.equal(result.status, "failed");
      if (result.status === "failed") {
        assert.equal(result.reason, expectedReason);
      }
    });
  }

  test("a provider timeout is reported as a timeout", async () => {
    stubFetch((init) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });

    const result = await send();
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.reason, "timeout");
  });
});

describe("secrets never escape", () => {
  test("the api key is not in the returned value", async () => {
    stubFetch(() => json({ id: "resend-123" }));
    const result = await send();
    assert.ok(!JSON.stringify(result).includes("re_test_secret_key_value"));
  });

  test("the api key is never logged on failure", async () => {
    stubFetch(() => json({ message: "invalid api key re_test_secret_key_value" }, 401));
    await send();

    assert.ok(warnings.length > 0, "a failure should be logged");
    for (const line of warnings) {
      assert.ok(
        !line.includes("re_test_secret_key_value"),
        `api key leaked into a log line: ${line}`,
      );
    }
  });

  test("the provider's own error text is never logged", async () => {
    stubFetch(() =>
      json({ message: "domain not verified for tegjot@example.com" }, 422),
    );
    await send();
    for (const line of warnings) {
      assert.ok(!line.includes("domain not verified"));
      assert.ok(!line.includes("tegjot@example.com"));
    }
  });

  test("logs record only a failure category and the reference", async () => {
    stubFetch(() => json({}, 500));
    await send();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[booking-email\] send failed \(rejected\) for reference BSCJ-A1B2C3/);
  });

  test("nothing is logged on success", async () => {
    stubFetch(() => json({ id: "resend-123" }));
    await send();
    assert.equal(warnings.length, 0);
  });

  test("the key travels only in the Authorization header", async () => {
    stubFetch(() => json({ id: "resend-123" }));
    await send();

    const headers = lastRequest?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer re_test_secret_key_value");
    assert.ok(!String(lastRequest?.init.body).includes("re_test_secret_key_value"));
    assert.ok(!String(lastRequest?.url).includes("re_test_secret_key_value"));
  });
});
