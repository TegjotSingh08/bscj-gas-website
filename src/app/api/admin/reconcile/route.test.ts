import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * The reconciliation endpoint's access protections.
 *
 * It writes to the operational record and to Google on BSCJ's behalf, so the
 * two questions are "who is calling" and "did our own page ask". Both are
 * answered here rather than left to `middleware.ts` — which only looks for the
 * presence of a cookie — or to a library's `SameSite` default.
 */

const ORIGIN = "https://bscj.example";

let session: { user: { id: string; email: string } } | null = {
  user: { id: "admin-1", email: "admin@example.invalid" },
};

class WrongAudienceError extends Error {}

mock.module("@/lib/auth/session", {
  namedExports: {
    requireAdminOrThrow: async () => {
      if (!session) throw new WrongAudienceError("not an administrator");
      return session;
    },
    WrongAudienceError,
  },
});

let ran = 0;
let sweepThrows = false;

mock.module("@/lib/ops/reconcile", {
  namedExports: {
    runReconciliation: async () => {
      ran += 1;
      if (sweepThrows) throw new Error("the sweep failed");
      return {
        calendarSync: {
          considered: 1,
          synced: 1,
          failed: 0,
          superseded: 0,
          skipped: 0,
        },
        calendarCleanup: {
          considered: 0,
          cleaned: 0,
          pending: 0,
          orphansRemoved: 0,
        },
        bookingRecovery: {
          listed: true,
          considered: 0,
          recovered: 0,
          eventMissing: 0,
          failed: 0,
        },
      };
    },
  },
});

let audits: { kind: string; detail: Record<string, unknown> }[] = [];

mock.module("@/lib/audit/record", {
  namedExports: {
    recordAudit: async (event: {
      kind: string;
      detail: Record<string, unknown>;
    }) => {
      audits.push(event);
    },
  },
});

const { POST } = await import("./route");

function request(headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/admin/reconcile`, {
    method: "POST",
    headers: { origin: ORIGIN, host: "bscj.example", ...headers },
  });
}

beforeEach(() => {
  session = { user: { id: "admin-1", email: "admin@example.invalid" } };
  ran = 0;
  sweepThrows = false;
  audits = [];
});

describe("who may run the sweep", () => {
  test("an administrator may", async () => {
    const response = await POST(request());
    assert.equal(response.status, 200);
    assert.equal(ran, 1);
  });

  test("anyone who is not an administrator may not", async () => {
    session = null;
    const response = await POST(request());

    assert.equal(response.status, 401);
    assert.equal(ran, 0, "the sweep ran for a caller it had refused");
  });

  test("a cross-site post is refused before the session is even read", async () => {
    /*
      Auth.js sets `SameSite=Lax`, so a cross-site POST would not carry the
      session anyway — but a protection that exists only as a library's cookie
      default disappears silently the day that default changes, and nothing in
      the handler would look any different.
    */
    const response = await POST(request({ origin: "https://evil.example" }));

    assert.equal(response.status, 401);
    assert.equal(ran, 0);
  });

  test("a post with no Origin at all is refused", async () => {
    const response = await POST(
      new Request(`${ORIGIN}/api/admin/reconcile`, {
        method: "POST",
        headers: { host: "bscj.example" },
      }),
    );

    assert.equal(response.status, 401);
    assert.equal(ran, 0);
  });

  test("a refusal says nothing about which check failed", async () => {
    session = null;
    const notAdmin = await (await POST(request())).json();

    session = { user: { id: "admin-1", email: "admin@example.invalid" } };
    const crossSite = await (
      await POST(request({ origin: "https://evil.example" }))
    ).json();

    assert.deepEqual(notAdmin, crossSite);
  });
});

describe("what the sweep leaves behind", () => {
  test("it is audited, with counts and nothing else", async () => {
    await POST(request());

    assert.equal(audits.length, 1);
    assert.equal(audits[0].kind, "ops.reconciliation_run");

    const detail = JSON.stringify(audits[0].detail);
    assert.equal(
      /BSCJ-|@|bscj[0-9a-f]{8}/.test(detail),
      false,
      "the audit line carried a reference, an address or a calendar id",
    );
  });

  test("a failed sweep is a 503, not a 500", async () => {
    sweepThrows = true;
    const response = await POST(request());
    assert.equal(response.status, 503);
  });

  test("a failed sweep records no audit line claiming it ran", async () => {
    sweepThrows = true;
    await POST(request());
    assert.deepEqual(audits, []);
  });
});
