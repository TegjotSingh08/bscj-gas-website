import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import { issueSchedulingSession, SCHEDULING_COOKIE } from "@/lib/scheduling/session";

/**
 * The confirmation endpoint, over HTTP.
 *
 * There was no test of this route at all, which is precisely how it shipped
 * refusing every genuine tenant: the domain function underneath it was proven
 * by calling it as a Node function, and a cookie-scoping defect is invisible
 * unless something makes a request.
 *
 * `cookies()` is stubbed rather than a real Next request store, so these are
 * handler-level tests. The end-to-end proof — that a real browser is *sent*
 * the cookie by this path — is the live run recorded in the handoff, and the
 * path rule itself is asserted in `lib/scheduling/origin.test.ts`.
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://bscj.example";

process.env.AUTH_SECRET = "a-test-signing-secret";

let cookieValue: string | undefined;

mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({
      get: (name: string) =>
        name === SCHEDULING_COOKIE && cookieValue
          ? { name, value: cookieValue }
          : undefined,
    }),
  },
});

let confirmResult: unknown = { status: "confirmed", start: new Date("2026-10-05T09:00:00.000Z"), end: new Date("2026-10-05T09:45:00.000Z"), mode: "initial" };
let confirmThrows = false;
let confirmedJobId: string | null = null;
let reconciled: string[] = [];

mock.module("@/lib/scheduling/confirm", {
  namedExports: {
    confirmTenantAppointment: async (input: { jobId: string }) => {
      confirmedJobId = input.jobId;
      if (confirmThrows) throw new Error("the domain raised");
      return confirmResult;
    },
    reconcileJobCalendar: async (jobId: string) => {
      reconciled.push(jobId);
      return { sync: "synced", cleanup: "nothing_to_do" };
    },
  },
});

let rateLimited = false;

mock.module("@/lib/booking/rate-limit", {
  namedExports: {
    rateLimit: async () => ({
      ok: !rateLimited,
      retryAfterSeconds: rateLimited ? 30 : 0,
    }),
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

function request(
  body: unknown,
  headers: Record<string, string> = { origin: ORIGIN, host: "bscj.example" },
): Request {
  return new Request(`${ORIGIN}/schedule/api/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID_BODY = {
  slotStart: "2026-10-05T09:00:00.000Z",
  holdToken: "a".repeat(64),
};

beforeEach(() => {
  cookieValue = issueSchedulingSession(JOB_ID).value;
  confirmThrows = false;
  confirmedJobId = null;
  reconciled = [];
  rateLimited = false;
  confirmResult = {
    status: "confirmed",
    start: new Date("2026-10-05T09:00:00.000Z"),
    end: new Date("2026-10-05T09:45:00.000Z"),
    mode: "initial",
  };
});

describe("who may confirm", () => {
  test("a valid session confirms, and the job comes from it", async () => {
    const response = await POST(request(VALID_BODY));

    assert.equal(response.status, 200);
    assert.equal(
      confirmedJobId,
      JOB_ID,
      "the job did not come from the signed session",
    );
  });

  test("no session is refused", async () => {
    cookieValue = undefined;
    const response = await POST(request(VALID_BODY));
    assert.equal(response.status, 401);
    assert.equal(confirmedJobId, null, "it acted before checking");
  });

  test("a tampered session is refused", async () => {
    const [, expiry, signature] = issueSchedulingSession(JOB_ID).value.split(".");
    cookieValue = `22222222-2222-4222-8222-222222222222.${expiry}.${signature}`;

    const response = await POST(request(VALID_BODY));
    assert.equal(response.status, 401);
    assert.equal(confirmedJobId, null, "a forged job id reached the domain");
  });

  test("an expired session is refused", async () => {
    cookieValue = issueSchedulingSession(
      JOB_ID,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    ).value;

    const response = await POST(request(VALID_BODY));
    assert.equal(response.status, 401);
  });

  test("a cross-site post is refused even with a valid session", async () => {
    const response = await POST(
      request(VALID_BODY, { origin: "https://evil.example", host: "bscj.example" }),
    );

    assert.equal(response.status, 401);
    assert.equal(confirmedJobId, null);
  });

  test("every refusal looks the same", async () => {
    cookieValue = undefined;
    const noSession = await (await POST(request(VALID_BODY))).json();

    cookieValue = issueSchedulingSession(JOB_ID).value;
    const crossSite = await (
      await POST(request(VALID_BODY, { origin: "https://evil.example", host: "bscj.example" }))
    ).json();

    assert.deepEqual(noSession, crossSite, "a probe can tell them apart");
  });
});

describe("what the body may carry", () => {
  test("there is no field for a job, a price or a status", async () => {
    await POST(
      request({
        ...VALID_BODY,
        jobId: "99999999-9999-4999-8999-999999999999",
        priceTotal: 1,
        lifecycleStatus: "completed",
      }),
    );

    assert.equal(
      confirmedJobId,
      JOB_ID,
      "a job id in the body overrode the session",
    );
  });

  test("unparseable JSON is a 400, not a 500", async () => {
    const response = await POST(request("{not json"));
    assert.equal(response.status, 400);
  });

  test("a missing slot is a 400", async () => {
    const response = await POST(request({ holdToken: "a".repeat(64) }));
    assert.equal(response.status, 400);
  });
});

describe("nothing the domain says becomes a 500", () => {
  test("a thrown error answers 503 with a message", async () => {
    /*
      The reschedule 500. `assertTransition` raised out of an unguarded call
      and the tenant saw a server error with no explanation. The lifecycle rule
      is fixed in the domain; this is the second line of defence.
    */
    confirmThrows = true;
    const response = await POST(request(VALID_BODY));

    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.ok(body.message, "a failure with no words for the tenant");
  });

  test("a conflict is 409 and says to reload, not to pick another time", async () => {
    confirmResult = { status: "conflict" };
    const response = await POST(request(VALID_BODY));

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "conflict");
    assert.match(body.message, /reload/i);
    assert.doesNotMatch(
      body.message,
      /taken/i,
      "a job that moved was described as a slot somebody else had taken",
    );
  });

  test("every refusal carries words the tenant can act on", async () => {
    for (const status of [
      "hold_expired",
      "slot_taken",
      "day_full",
      "not_schedulable",
      "not_found",
      "conflict",
      "unavailable",
    ]) {
      confirmResult = { status };
      const response = await POST(request(VALID_BODY));
      const body = await response.json();
      assert.ok(body.message, status);
      assert.equal(body.ok, false, status);
    }
  });

  test("not_found is 404 and unavailable is 503", async () => {
    confirmResult = { status: "not_found" };
    assert.equal((await POST(request(VALID_BODY))).status, 404);

    confirmResult = { status: "unavailable" };
    assert.equal((await POST(request(VALID_BODY))).status, 503);
  });

  test("rate limiting answers 429 with Retry-After", async () => {
    rateLimited = true;
    const response = await POST(request(VALID_BODY));

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "30");
  });
});

describe("the calendar is reconciled after the commit, never before", () => {
  test("a confirmation reconciles the job", async () => {
    await POST(request(VALID_BODY));
    assert.deepEqual(reconciled, [JOB_ID]);
  });

  test("a retry reconciles too, so a half-finished sequence is finished", async () => {
    confirmResult = {
      status: "already",
      start: new Date("2026-10-05T09:00:00.000Z"),
      end: new Date("2026-10-05T09:45:00.000Z"),
    };

    const response = await POST(request(VALID_BODY));
    assert.equal(response.status, 200);
    assert.deepEqual(reconciled, [JOB_ID]);
  });

  test("a refused confirmation never touches the calendar", async () => {
    confirmResult = { status: "slot_taken" };
    await POST(request(VALID_BODY));
    assert.deepEqual(reconciled, [], "it wrote to the diary for a failed booking");
  });
});
