import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  issueSchedulingSession,
  readSchedulingSession,
  schedulingCookieOptions,
  SCHEDULING_COOKIE_PATH,
  SESSION_MAX_AGE_SECONDS,
} from "./session";
import { calendarEventIdForJob } from "./confirm";
import { LOOKUP_LIMITS } from "./access";
import { canTransition } from "@/lib/jobs/lifecycle";

/**
 * Tenant scheduling.
 *
 * The session and the calendar-event id are pure and tested directly. The
 * database- and Redis-shaped guarantees — hold ownership, availability
 * revalidation, cross-job isolation, retry behaviour — are proved against the
 * live development stack and recorded in `docs/V2_CURRENT_STATE.md`.
 */

const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";

/** The signing key the session needs. Never a real secret. */
function withSecret<T>(run: () => T, secret = "a-test-signing-secret"): T {
  const previous = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = secret;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previous;
  }
}

describe("the tenant session names exactly one job", () => {
  test("a session round-trips to the job it was issued for", () => {
    withSecret(() => {
      const issued = issueSchedulingSession(JOB_A);
      const read = readSchedulingSession(issued.value);
      assert.equal(read?.jobId, JOB_A);
    });
  });

  test("editing the job id breaks the signature", () => {
    /*
      The cross-job case, and the reason the session is signed rather than a
      plain cookie. Swapping the id is the obvious attack and it fails closed.
    */
    withSecret(() => {
      const issued = issueSchedulingSession(JOB_A);
      const [, expiry, signature] = issued.value.split(".");
      const forged = `${JOB_B}.${expiry}.${signature}`;

      assert.equal(readSchedulingSession(forged), null);
    });
  });

  test("extending the expiry breaks the signature", () => {
    withSecret(() => {
      const issued = issueSchedulingSession(JOB_A);
      const [jobId, , signature] = issued.value.split(".");
      const later = Date.now() + 1_000_000_000;

      assert.equal(readSchedulingSession(`${jobId}.${later}.${signature}`), null);
    });
  });

  test("a session signed with another key is refused", () => {
    const issued = withSecret(() => issueSchedulingSession(JOB_A), "secret-one");
    assert.equal(
      withSecret(() => readSchedulingSession(issued.value), "secret-two"),
      null,
    );
  });

  test("an expired session is refused", () => {
    withSecret(() => {
      const now = new Date("2026-09-18T10:00:00.000Z");
      const issued = issueSchedulingSession(JOB_A, now);
      const later = new Date(
        now.getTime() + (SESSION_MAX_AGE_SECONDS + 1) * 1000,
      );
      assert.ok(readSchedulingSession(issued.value, now));
      assert.equal(readSchedulingSession(issued.value, later), null);
    });
  });

  test("malformed values are refused rather than parsed", () => {
    withSecret(() => {
      for (const value of [
        undefined,
        "",
        JOB_A,
        `${JOB_A}.123`,
        `${JOB_A}.123.sig.extra`,
        "....",
      ]) {
        assert.equal(readSchedulingSession(value), null, String(value));
      }
    });
  });

  test("with no signing secret, nothing is issued and nothing verifies", () => {
    // Fail closed. An unsigned session is not a weaker session; it is none.
    const previous = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      assert.throws(() => issueSchedulingSession(JOB_A));
      assert.equal(readSchedulingSession("anything.123.sig"), null);
    } finally {
      if (previous !== undefined) process.env.AUTH_SECRET = previous;
    }
  });

  test("the cookie is scoped to the scheduling path and hidden from scripts", () => {
    /*
      Path scoping is what stops the browser ever presenting this to the
      portal, the admin area or the consumer API — so nothing downstream can
      mistake it for an agency session.
    */
    const options = schedulingCookieOptions(new Date());
    assert.equal(options.path, SCHEDULING_COOKIE_PATH);
    assert.equal(options.path, "/schedule");
    assert.equal(options.httpOnly, true);
    assert.equal(options.sameSite, "lax");
  });

  test("it carries no token material", () => {
    // The scheduling token is spent at the door. What replaces it would be
    // useless to anyone who later obtained it without the signing key.
    withSecret(() => {
      const issued = issueSchedulingSession(JOB_A);
      assert.equal(/[0-9a-f]{64}/.test(issued.value), false);
    });
  });
});

describe("the calendar event id", () => {
  test("it is deterministic, so a retry collides instead of duplicating", () => {
    const slot = "2026-12-01T10:00:00.000Z";
    assert.equal(
      calendarEventIdForJob(JOB_A, slot),
      calendarEventIdForJob(JOB_A, slot),
    );
  });

  test("a different job or a different time is a different event", () => {
    const slot = "2026-12-01T10:00:00.000Z";
    const other = "2026-12-01T11:00:00.000Z";
    assert.notEqual(
      calendarEventIdForJob(JOB_A, slot),
      calendarEventIdForJob(JOB_B, slot),
    );
    assert.notEqual(
      calendarEventIdForJob(JOB_A, slot),
      calendarEventIdForJob(JOB_A, other),
    );
  });

  test("two spellings of the same instant give one id", () => {
    // Or a retry sending a differently-formatted timestamp would create a
    // second event for the same appointment.
    assert.equal(
      calendarEventIdForJob(JOB_A, "2026-12-01T10:00:00.000Z"),
      calendarEventIdForJob(JOB_A, "2026-12-01T10:00:00Z"),
    );
  });

  test("it satisfies Google's id rules", () => {
    const id = calendarEventIdForJob(JOB_A, "2026-12-01T10:00:00.000Z");
    assert.match(id, /^bscj[a-v0-9]+$/);
    assert.ok(id.length <= 60);
  });
});

describe("the lifecycle move a tenant makes", () => {
  test("outreach to scheduled is a permitted transition", () => {
    assert.equal(canTransition("tenant_outreach", "scheduled"), true);
    assert.equal(canTransition("awaiting_tenant", "scheduled"), true);
  });

  test("a tenant cannot complete or cancel by scheduling", () => {
    assert.equal(canTransition("tenant_outreach", "completed"), false);
    assert.equal(canTransition("scheduled", "completed"), false);
  });

  test("a finished job cannot be rescheduled", () => {
    for (const from of ["completed", "cancelled"] as const) {
      assert.equal(canTransition(from, "scheduled"), false, from);
    }
  });
});

describe("enumeration is designed against", () => {
  const access = readFileSync(
    path.resolve(process.cwd(), "src/lib/scheduling/access.ts"),
    "utf8",
  );
  const actions = readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/(schedule)/schedule/actions.ts",
    ),
    "utf8",
  );

  test("manual entry is limited per caller and per reference", () => {
    /*
      Per-IP alone misses many machines sweeping one reference; per-reference
      alone misses one machine sweeping many. Both are needed.
    */
    assert.ok(LOOKUP_LIMITS.perClient.limit > 0);
    assert.ok(LOOKUP_LIMITS.perReference.limit > 0);
    assert.ok(
      LOOKUP_LIMITS.perReference.limit <= LOOKUP_LIMITS.perClient.limit,
      "a single reference may be guessed more often than a client may try",
    );
    assert.match(access, /schedule-lookup:/);
    assert.match(access, /schedule-reference:/);
  });

  test("the reference and the postcode are matched in one query", () => {
    // Looking the reference up first would answer measurably faster for a
    // reference that does not exist.
    assert.match(access, /eq\(jobs\.reference, reference\)/);
    assert.match(access, /eq\(properties\.postcode, postcode\)/);
  });

  test("rate limiting is indistinguishable from a wrong answer", () => {
    // Saying "too many attempts" confirms the attempts were worth making.
    assert.match(actions, /if \(result\.status !== "ok"\) return \{ failed: true \}/);
  });

  test("there is exactly one failure message", () => {
    const form = readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/(schedule)/schedule/LookupForm.tsx",
      ),
      "utf8",
    );
    const messages = [...form.matchAll(/We could not find an appointment/g)];
    assert.equal(messages.length, 1, "more than one failure message exists");
  });
});

describe("what the tenant surface will not accept or reveal", () => {
  const confirmRoute = readFileSync(
    path.resolve(process.cwd(), "src/app/api/schedule/confirm/route.ts"),
    "utf8",
  );
  const confirm = readFileSync(
    path.resolve(process.cwd(), "src/lib/scheduling/confirm.ts"),
    "utf8",
  );
  const access = readFileSync(
    path.resolve(process.cwd(), "src/lib/scheduling/access.ts"),
    "utf8",
  );

  test("the confirm endpoint takes the job from the session, never the body", () => {
    assert.match(confirmRoute, /readSchedulingSession/);
    assert.match(confirmRoute, /jobId: session\.jobId/);
    assert.equal(/body\.jobId/.test(confirmRoute), false);
    assert.equal(/body\.organisation/i.test(confirmRoute), false);
  });

  test("it refuses a caller with no session, whatever the UI renders", () => {
    // The route is reachable directly; page-level checks protect nothing.
    assert.match(confirmRoute, /status: 401/);
  });

  test("no price, organisation or status can be submitted", () => {
    for (const forbidden of ["price", "Price", "organisation", "lifecycle"]) {
      assert.equal(
        confirmRoute.includes(`body.${forbidden}`),
        false,
        `the route reads ${forbidden} from the body`,
      );
    }
  });

  test("the tenant's view carries no price and no landlord", () => {
    /*
      Comments are stripped first: the note next to this type lists exactly
      what is kept off it, and that note must not trip the check that none of
      those things is on it.
    */
    const view = access
      .slice(
        access.indexOf("export type TenantJobView"),
        access.indexOf("function toView"),
      )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/.*$/gm, " ");
    for (const forbidden of ["price", "Price", "landlord", "pence", "customer"]) {
      assert.equal(
        view.includes(forbidden),
        false,
        `the tenant view exposes ${forbidden}`,
      );
    }
  });

  test("availability is revalidated at confirmation, not trusted from the hold", () => {
    assert.match(confirm, /isSlotStillAvailable\(/);
    assert.match(confirm, /isDayFullyBooked\(/);
    assert.match(confirm, /checkHold\(/);
    assert.match(confirm, /acquireDailyBookingLock\(/);
  });

  test("the status change is guarded by the status it expects to find", () => {
    // Two confirmations racing past the checks both reach the update; the
    // second matches no row rather than overwriting the first.
    assert.match(confirm, /assertTransition\(/);
    assert.match(confirm, /eq\(\s*jobs\.lifecycleStatus/);
  });

  test("scheduling never touches an invoice", () => {
    for (const source of [confirm, confirmRoute]) {
      assert.equal(/invoice/i.test(source), false);
      assert.equal(source.includes("allocateInvoiceNumber"), false);
    }
  });

  test("the calendar write happens after the commit and cannot fail it", () => {
    // Postgres cannot make a Google call atomic. Intent is committed; the
    // outcome is recorded separately and retried.
    assert.match(confirm, /calendarSyncState: "pending"/);
    assert.match(confirm, /calendarSyncState: "failed"/);
    assert.match(confirm, /calendarSyncState: "synced"/);
    assert.match(confirmRoute, /syncJobToCalendar/);
  });

  test("a duplicate calendar write is treated as success", () => {
    assert.match(confirm, /DuplicateBookingError/);
  });
});

describe("the scheduling surface is isolated from the rest of the site", () => {
  test("middleware does not gate it, and does not pretend to", () => {
    /*
      Tenant access is a token and a signed cookie, not an Auth.js session.
      Adding `/schedule` to the matcher would gate it on a cookie it never
      has — and imply it was protected by something that is not protecting it.
    */
    const middleware = readFileSync(
      path.resolve(process.cwd(), "src/middleware.ts"),
      "utf8",
    );
    const matcher = middleware.match(/matcher:[\s\S]*?\[([^\]]*)\]/)?.[1] ?? "";
    assert.equal(matcher.includes("/schedule"), false);
  });

  test("the layout offers no way into the rest of the site", () => {
    const layout = readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/(schedule)/schedule/layout.tsx",
      ),
      "utf8",
    );
    assert.equal(layout.includes("/book"), false);
    assert.equal(layout.includes("/portal"), false);
    assert.equal(layout.includes("Header"), false);
  });

  test("the tenant flow reuses the existing scheduler rather than forking it", () => {
    const scheduler = readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/(schedule)/schedule/appointment/TenantScheduler.tsx",
      ),
      "utf8",
    );
    for (const reused of [
      "@/components/booking/DatePicker",
      "@/components/booking/TimePicker",
      "@/components/booking/ReservationBar",
      "/api/availability",
      "/api/hold",
    ]) {
      assert.ok(scheduler.includes(reused), `${reused} was not reused`);
    }
  });
});
