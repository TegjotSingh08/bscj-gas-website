import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  connect,
  reset,
  start,
  stop,
  type Connection,
} from "../support/disposable-postgres";
import { setDbForTesting } from "../../src/lib/db/client";
import { seed, type Fixture } from "../support/fixtures";
import {
  BASE_URL,
  isolatedEnvironment,
  startServer,
  stopServer,
} from "../support/browser-server";
import { follow, get, signIn, type HttpSession } from "../support/http-session";
import { hashPassword } from "../../src/lib/auth/password";
import { isDisposableTarget } from "../../src/lib/db/disposable";

/**
 * The access boundaries, exercised as the people who are refused by them.
 *
 * **What this file used to do, and why it was not enough.** One test called
 * `assertCan("agent_owner", "certificate:issue")` and was named "requireAdmin
 * refuses an agent session". It tested neither `requireAdmin` nor a session:
 * it tested a lookup table. Another read every admin `page.tsx` off disk and
 * checked the source contained `requireAdmin()`. That is a useful check —
 * a new page that forgets the guard is caught by it — but it is a check on
 * *source text*, and describing it as a verified boundary was wrong.
 *
 * Both are kept below, named for what they actually are. The boundaries
 * themselves are now established the only way they can be: a real server, a
 * real sign-in with a real password, and real requests made as each person.
 *
 * Every account and record is fictional, the database is thrown away with the
 * run, and nothing external is reachable.
 */

const PASSWORD = "fixture-password-not-a-secret";

let conn: Connection;
let fixture: Fixture;
let admin: HttpSession;
let agent: HttpSession;
let rival: HttpSession;

before(async () => {
  await start();
  conn = await connect();
  setDbForTesting(conn.db as never);
  await reset(conn);
  fixture = await seed(conn);

  // The application's own hashing, so the ordinary login path is what runs.
  const hash = await hashPassword(PASSWORD);
  await conn.client.query(
    "update app_user set password_hash = $1, password_set_at = now()",
    [hash],
  );

  await startServer();
  admin = await signIn("admin@fixture.example.invalid", PASSWORD);
  agent = await signIn("agent@fixture.example.invalid", PASSWORD);
  rival = await signIn("rival@fixture.example.invalid", PASSWORD);
});

after(async () => {
  await stopServer();
  setDbForTesting(null);
  await stop();
});

/** How many times an administrator has run the reconciliation sweep. */
async function sweepsRecorded(): Promise<number> {
  const { rows } = await conn.client.query<{ n: string }>(
    "select count(*)::text as n from audit_event where kind = 'ops.reconciliation_run'",
  );
  return Number(rows[0].n);
}

/** The sweep, as an HTTP caller with this session would ask for it. */
async function runSweep(session: HttpSession) {
  const response = await fetch(`${BASE_URL}/api/admin/reconcile`, {
    method: "POST",
    headers: { cookie: session.cookie(), origin: BASE_URL },
    redirect: "manual",
  });
  return { status: response.status, body: await response.text() };
}

describe("the sessions are real, and they are the fixtures'", () => {
  test("each one signed in through the ordinary credentials endpoint", async () => {
    /*
      This is also the isolation proof. These accounts exist only in the
      throwaway database; a server that had picked up a real `DATABASE_URL`
      from an environment file could not have signed any of them in.
    */
    assert.deepEqual(await admin.whoami(), {
      role: "admin",
      email: "admin@fixture.example.invalid",
    });
    assert.deepEqual(await agent.whoami(), {
      role: "agent_owner",
      email: "agent@fixture.example.invalid",
    });
    assert.deepEqual(await rival.whoami(), {
      role: "agent_owner",
      email: "rival@fixture.example.invalid",
    });
  });
});

describe("an agency user cannot reach an admin page", () => {
  const adminPages = [
    "/admin",
    "/admin/reconcile",
    "/admin/due",
    "/admin/jobs",
  ];

  for (const path of adminPages) {
    test(`${path} refuses them, and an administrator is served it`, async () => {
      const refused = await get(agent, path);
      assert.ok(
        refused.status >= 300 && refused.status < 400,
        `${path} answered ${refused.status} to an agency user`,
      );
      assert.equal(
        refused.location,
        "/admin/login",
        "and the destination is the staff sign-in page, named explicitly",
      );

      const served = await get(admin, path);
      assert.equal(served.status, 200, `${path} is served to an administrator`);
      assert.ok(served.body.length > 1000, "and it is the real page");
    });
  }

  test("the job page too, which carries the mutations", async () => {
    const path = `/admin/jobs/${fixture.jobId}`;
    const refused = await get(agent, path);
    assert.equal(refused.status, 307);
    assert.equal(refused.location, "/admin/login");

    const served = await get(admin, path);
    assert.equal(served.status, 200);
    assert.match(served.body, new RegExp(fixture.jobReference));
  });
});

describe("every redirect chain ends somewhere", () => {
  /**
   * **The defect this was written for.** `/admin/login` redirected *any*
   * session to `/admin`, and `/admin` sends everybody who is not an
   * administrator back to `/admin/login`. The two bounced off each other
   * until the browser gave up with ERR_TOO_MANY_REDIRECTS.
   *
   * For an agency user that turned "you are in the wrong place" into a dead
   * end. For an **engineer** it was worse: the staff form sends a successful
   * sign-in to `/admin`, so an engineer who typed the right password was
   * thrown straight into the loop and could not reach their own screens at
   * all.
   *
   * Asserting the first hop would not have caught it — the first hop was
   * correct in every case. These follow the whole chain.
   */
  const journeys: [string, () => HttpSession, string][] = [
    ["an agency user asking for an admin page", () => agent, "/admin/reconcile"],
    ["an agency user at the staff sign-in page", () => agent, "/admin/login"],
    ["an agency user asking for the engineer's day", () => agent, "/engineer"],
    ["an engineer asking for an admin page", () => engineer(), "/admin/reconcile"],
    ["an engineer at the staff sign-in page", () => engineer(), "/admin/login"],
    ["an administrator at the staff sign-in page", () => admin, "/admin/login"],
  ];

  let engineerSession: HttpSession | null = null;
  const engineer = () => {
    assert.ok(engineerSession, "the engineer signed in");
    return engineerSession;
  };

  before(async () => {
    engineerSession = await signIn("engineer@fixture.example.invalid", PASSWORD);
  });

  for (const [description, session, path] of journeys) {
    test(`${description} arrives somewhere`, async () => {
      const { hops, finalStatus, finalPath } = await follow(session(), path);
      assert.notEqual(
        finalStatus,
        null,
        `still redirecting after ${hops.length} hops: ${hops
          .map((hop) => `${hop.status} -> ${hop.location}`)
          .join(", ")}`,
      );
      assert.equal(finalStatus, 200, `landed on ${finalPath}`);
    });
  }

  test("and an engineer lands on their own day, not a staff page they cannot have", async () => {
    const { finalPath, finalStatus } = await follow(engineer(), "/admin/login");
    assert.equal(finalStatus, 200);
    assert.equal(finalPath, "/engineer");
  });

  test("an agency user is told why the staff page is not theirs", async () => {
    const page = await get(agent, "/admin/login");
    assert.equal(page.status, 200);
    assert.match(page.body, /signed in as an agency user/i);
    assert.match(page.body, /\/portal/);
  });
});

describe("an agency user cannot perform an admin mutation", () => {
  test("the sweep refuses them, and writes nothing", async () => {
    /*
      A real administrative mutation over real HTTP: it writes an audit row
      every time it runs, so "nothing happened" is checkable rather than
      assumed. The same request is then made by an administrator, which is
      what makes the refusal meaningful — otherwise a broken endpoint would
      pass this test by refusing everybody.
    */
    const before = await sweepsRecorded();

    const refused = await runSweep(agent);
    assert.equal(refused.status, 401);
    assert.match(refused.body, /unauthenticated/);
    assert.equal(
      await sweepsRecorded(),
      before,
      "the attempt left no trace, because it did not run",
    );

    const allowed = await runSweep(admin);
    assert.equal(allowed.status, 200);
    assert.match(allowed.body, /"ok":true/);
    assert.equal(
      await sweepsRecorded(),
      before + 1,
      "and an administrator's identical request did run",
    );
  });

  test("an admin server action refuses them before it runs", async () => {
    /*
      A Server Action is a public HTTP endpoint with a generated name. This
      posts to one on the admin job page with a real agency session and
      asserts the guard redirects rather than the action executing — and
      that the job is untouched either way.
    */
    const actionId = adminActionId("assignEngineerAction");
    const body = new FormData();
    body.set("0", JSON.stringify(["$undefined", "$K1"]));
    body.set("1_jobId", fixture.jobId);
    body.set("1_engineerId", fixture.engineerUserId);

    const response = await fetch(`${BASE_URL}/admin/jobs/${fixture.jobId}`, {
      method: "POST",
      headers: {
        cookie: agent.cookie(),
        origin: BASE_URL,
        "Next-Action": actionId,
      },
      body,
      redirect: "manual",
    });
    await response.text();

    assert.match(
      response.headers.get("x-action-redirect") ?? "",
      /^\/admin\/login/,
      "the guard sent them to the staff sign-in page instead of acting",
    );

    const { rows } = await conn.client.query<{ engineer: string | null }>(
      "select assigned_engineer_id as engineer from job where id = $1",
      [fixture.jobId],
    );
    assert.equal(rows[0].engineer, null, "and no engineer was assigned");
  });
});

/**
 * The generated name of one server action on the admin job page.
 *
 * Read from the build's own manifest rather than hardcoded, because the id is
 * a content hash and changes whenever the module does. A missing entry fails
 * the test loudly rather than silently testing nothing.
 */
function adminActionId(exportName: string): string {
  const root = path.resolve(
    process.env.BSCJ_BROWSER_CWD ?? process.cwd(),
    ".next/dev/static/chunks",
  );
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(".js")) continue;
    const source = readFileSync(path.join(root, entry), "utf8");
    const match = source.match(
      new RegExp(
        `\\{"(60[0-9a-f]{40})":\\{"name":"${exportName}"\\}\\}`,
      ),
    );
    if (match) return match[1];
  }
  throw new Error(`No action id found for ${exportName}`);
}

describe("one agency cannot reach another's records", () => {
  test("a property is served to its owner and not found by the other", async () => {
    const path = `/portal/portfolio/${fixture.propertyId}`;

    const owner = await get(agent, path);
    assert.equal(owner.status, 200);

    const other = await get(rival, path);
    assert.equal(other.status, 404, "not found, rather than refused by name");
  });

  test("and so is a job", async () => {
    const path = `/portal/jobs/${fixture.jobId}`;
    assert.equal((await get(agent, path)).status, 200);
    assert.equal((await get(rival, path)).status, 404);
  });

  test("the query behind them scopes by organisation, not by id alone", async () => {
    const { getProperty } = await import("../../src/lib/portfolio/queries");

    assert.ok(await getProperty(fixture.organisationId, fixture.propertyId));
    assert.equal(
      await getProperty(fixture.otherOrganisationId, fixture.propertyId),
      null,
    );
  });

  test("and a job cannot be raised against it from the other agency", async () => {
    const { createAgentJob } = await import(
      "../../src/lib/jobs/create-agent-job"
    );

    const result = await createAgentJob(
      fixture.otherOrganisationId,
      {
        propertyId: fixture.propertyId,
        productId: "cp12",
        applianceCount: 1,
        requestedAsap: true,
        completeByDate: null,
        notes: null,
        submissionKey: "boundary",
      },
      fixture.otherAgentUserId,
    );

    assert.notEqual(result.status, "created");
  });
});

describe("the capability table, which is not the same as a guard", () => {
  test("it withholds administrative capabilities from every other role", async () => {
    /*
      Named for what it is. `assertCan` is the lookup the guards consult; this
      checks the lookup. What the guards *do* with it is established above, by
      making the requests.
    */
    const { assertCan } = await import("../../src/lib/auth/roles");

    assert.throws(() => assertCan("agent_owner", "certificate:issue"));
    assert.throws(() => assertCan("agent_member", "invoice:write"));
    assert.throws(() => assertCan("engineer", "portfolio:write"));

    assert.doesNotThrow(() => assertCan("admin", "certificate:issue"));
    assert.doesNotThrow(() => assertCan("admin", "invoice:write"));
  });

  test("every admin page's source asks for the guard, so a new one cannot forget", async () => {
    /*
      A source-level check, and described as one. It cannot tell you the
      guard works — the requests above do that — but it does catch the page
      somebody adds next month without one, which no amount of testing
      today's pages would.
    */
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === "page.tsx") pages.push(full);
      }
    };
    walk(path.resolve(process.cwd(), "src/app/admin"));

    assert.ok(pages.length > 0);
    for (const page of pages) {
      if (page.includes(`${path.sep}login${path.sep}`)) continue;
      assert.match(readFileSync(page, "utf8"), /requireAdmin\(\)/, page);
    }
  });
});

describe("the connected certificate endpoints, over real HTTP", () => {
  /**
   * The three routes the engineer's generator calls.
   *
   * The decisions they rest on are exercised against the database in
   * `engineer-certificate.test.ts`; what these add is the wire: that an
   * unauthenticated caller gets a status rather than a login page, that an
   * engineer who is not on the job is refused by the route and not only by
   * the function behind it, and that a cross-site post carries nothing.
   */
  const jobUrl = (suffix: string) =>
    `${BASE_URL}/api/engineer/jobs/${fixture.jobId}/certificate${suffix}`;

  let engineerSession: HttpSession;
  let strangerSession: HttpSession;

  before(async () => {
    await conn.client.query(
      "update job set assigned_engineer_id = $1 where id = $2",
      [fixture.engineerUserId, fixture.jobId],
    );
    engineerSession = await signIn("engineer@fixture.example.invalid", PASSWORD);
    strangerSession = await signIn("engineer2@fixture.example.invalid", PASSWORD);
  });

  const put = (session: HttpSession | null, body: unknown, origin = BASE_URL) =>
    fetch(jobUrl("/draft"), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(session ? { cookie: session.cookie() } : {}),
        origin,
      },
      body: JSON.stringify(body),
      redirect: "manual",
    });

  test("an unauthenticated caller gets 401, not a login page with a 200 on it", async () => {
    const session = await fetch(jobUrl("/session"), { redirect: "manual" });
    assert.equal(session.status, 401);
    assert.match(await session.text(), /unauthenticated/);

    const draft = await put(null, { fields: {}, revision: 0 });
    assert.equal(draft.status, 401);
  });

  test("the engineer on the job is served the prefill and an empty draft", async () => {
    const response = await fetch(jobUrl("/session"), {
      headers: { cookie: engineerSession.cookie() },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");

    const body = (await response.json()) as {
      job: { reference: string; canSubmit: boolean };
      prefill: { fields: Record<string, string> };
      draft: { revision: number };
    };
    assert.equal(body.job.reference, fixture.jobReference);
    assert.equal(body.job.canSubmit, true);
    assert.equal(body.draft.revision, 0);

    /* Prefilled from the job — and nothing the engineer has to decide. */
    assert.equal(body.prefill.fields.jobPostcode, "WV1 1AA");
    assert.equal(body.prefill.fields.certNo, undefined, "no number is invented");
    assert.equal(body.prefill.fields.sigDate, undefined, "no date is invented");
    assert.equal(body.prefill.fields.coFitted, undefined, "no outcome is invented");
  });

  test("another engineer is refused by the route, with nothing that says why", async () => {
    const session = await fetch(jobUrl("/session"), {
      headers: { cookie: strangerSession.cookie() },
    });
    assert.equal(session.status, 404);

    const draft = await put(strangerSession, {
      fields: { certNo: "TEST-NOT-VALID-9999" },
      revision: 0,
    });
    assert.equal(draft.status, 404);

    const { rows } = await conn.client.query<{ n: string }>(
      "select count(*)::text as n from certificate_draft",
    );
    assert.equal(rows[0].n, "0", "and nothing was written");
  });

  test("an agency user cannot reach them at all", async () => {
    const response = await fetch(jobUrl("/session"), {
      headers: { cookie: agent.cookie() },
    });
    assert.equal(response.status, 401, "the engineer audience guard refuses them");
  });

  test("a cross-site post is refused before the session is even considered", async () => {
    const response = await put(
      engineerSession,
      { fields: {}, revision: 0 },
      "https://not-bscj.example.invalid",
    );
    assert.equal(response.status, 401);
  });

  test("a stale revision is a 409 that carries the current draft", async () => {
    const first = await put(engineerSession, {
      fields: { certNo: "TEST-NOT-VALID-0001" },
      revision: 0,
    });
    assert.equal(first.status, 200);

    const stale = await put(engineerSession, {
      fields: { certNo: "TEST-NOT-VALID-0002" },
      revision: 0,
    });
    assert.equal(stale.status, 409);
    const body = (await stale.json()) as {
      conflict: boolean;
      draft: { fields: Record<string, string>; revision: number };
    };
    assert.equal(body.conflict, true);
    assert.equal(body.draft.fields.certNo, "TEST-NOT-VALID-0001");
    assert.equal(body.draft.revision, 1);
  });

  test("a submission with no PDF on it is refused", async () => {
    const form = new FormData();
    form.set("submissionKey", "no-file");
    const response = await fetch(jobUrl("/submission"), {
      method: "POST",
      headers: { cookie: engineerSession.cookie(), origin: BASE_URL },
      body: form,
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /No certificate was attached/);
  });
});

describe("the browser harness keeps its promises", () => {
  test("it fixes every key the application documents", () => {
    const example = readFileSync(".env.example", "utf8");
    const documented = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(
      (match) => match[1],
    );
    const fixed = isolatedEnvironment();

    assert.ok(documented.length > 5, "the example file was read");
    for (const key of documented) {
      assert.ok(
        key in fixed,
        `${key} is in .env.example but the browser harness does not fix it, so .env.local could supply it`,
      );
    }
  });

  test("it points the application at the throwaway database and nowhere else", () => {
    const fixed = isolatedEnvironment();
    assert.equal(fixed.BSCJ_DISPOSABLE_DB, "1");
    assert.match(String(fixed.DATABASE_URL), /127\.0\.0\.1:55433/);
  });

  test("an inherited database name of any kind is removed, not overridden", () => {
    /*
      `DATABASE_URL_UNPOOLED` is only a comment in `.env.example`, so the
      coverage test above would not notice it. An ambient one would be a live
      connection string inside a harness whose whole claim is that it cannot
      reach one.
    */
    const saved = process.env.DATABASE_URL_UNPOOLED;
    process.env.DATABASE_URL_UNPOOLED = "postgresql://someone@example.com/live";
    try {
      assert.equal(isolatedEnvironment().DATABASE_URL_UNPOOLED, undefined);
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL_UNPOOLED;
      else process.env.DATABASE_URL_UNPOOLED = saved;
    }
  });

  test("it leaves every external service unreachable", () => {
    const fixed = isolatedEnvironment();
    for (const key of [
      "RESEND_API_KEY",
      "GOOGLE_PRIVATE_KEY",
      "GOOGLE_CALENDAR_ID",
      "UPSTASH_REDIS_REST_URL",
      "BLOB_READ_WRITE_TOKEN",
      "CRON_SECRET",
    ]) {
      assert.equal(fixed[key], "", `${key} must be empty, not inherited`);
    }
  });

  test("the agency page stays off in the harness too", () => {
    assert.equal(isolatedEnvironment().BSCJ_AGENCY_PAGE, "");
  });

  test("and the running server really is serving the agency page off", async () => {
    const response = await get(null, "/letting-agents");
    assert.equal(response.status, 404);
  });

  test("the document half of the application can actually be exercised", async () => {
    /*
      **The blocker this closes.** The local document store refuses under
      `NODE_ENV=production`, and a production build folds that check away at
      compile time — so under `next start` the release control is disabled
      whatever the environment says, and the certificate journey cannot be
      driven at all. The harness runs `next dev` for exactly this reason.

      If somebody puts `next start` back, the admin job page will print the
      store's requirement instead of the release control, and this fails.
    */
    const page = await get(admin, `/admin/jobs/${fixture.jobId}`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(
      page.body,
      /development-only and refuses to run in production/,
      "the local document store is refusing, so nothing can be uploaded or released",
    );
    assert.match(page.body, /Release this certificate/);
  });
});

describe("the disposable driver cannot be reached by a real deployment", () => {
  const withMarker = <T>(value: string | undefined, body: () => T): T => {
    const before = process.env.BSCJ_DISPOSABLE_DB;
    if (value === undefined) delete process.env.BSCJ_DISPOSABLE_DB;
    else process.env.BSCJ_DISPOSABLE_DB = value;
    try {
      return body();
    } finally {
      if (before === undefined) delete process.env.BSCJ_DISPOSABLE_DB;
      else process.env.BSCJ_DISPOSABLE_DB = before;
    }
  };

  test("without the marker, nothing is disposable — not even its own URL", () => {
    withMarker(undefined, () => {
      assert.equal(
        isDisposableTarget(
          "postgresql://bscj_disposable:x@127.0.0.1:55433/bscj_disposable_test",
        ),
        false,
      );
    });
  });

  test("with the marker, a real-looking target is still refused", () => {
    withMarker("1", () => {
      for (const url of [
        "postgresql://user:pw@ep-cool-name.eu-west-2.aws.neon.tech/main",
        "postgresql://bscj_disposable:x@db.example.com:55433/bscj_disposable_test",
        "postgresql://bscj_disposable:x@127.0.0.1:5432/bscj_disposable_test",
        "postgresql://bscj_disposable:x@127.0.0.1:55433/bscj_dev",
        "postgresql://someone_else:x@127.0.0.1:55433/bscj_disposable_test",
      ]) {
        assert.equal(isDisposableTarget(url), false, url);
      }
    });
  });

  test("both conditions together are what it takes", () => {
    withMarker("1", () => {
      assert.equal(
        isDisposableTarget(
          "postgresql://bscj_disposable:x@127.0.0.1:55433/bscj_disposable_test",
        ),
        true,
      );
    });
  });
});
