import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  connect,
  reset,
  start,
  stop,
  type Connection,
} from "../support/disposable-postgres";
import { setDbForTesting } from "../../src/lib/db/client";
import { seed, type Fixture } from "../support/fixtures";
import { isolatedEnvironment } from "../support/browser-server";
import { isDisposableTarget } from "../../src/lib/db/disposable";

/**
 * The boundaries the browser pane could not be driven across, closed here.
 *
 * Signing in as an agent and then asking for an admin page produces a redirect,
 * and the browser tool reports a redirect as a failed navigation — so that one
 * check could not be *clicked*. It is asserted against the real database
 * instead, which is stronger than the click would have been: the guard itself
 * is exercised with a real agent session.
 *
 * Everything else in this file is about the harness keeping its promises.
 */

let conn: Connection;
let fixture: Fixture;

before(async () => {
  await start();
  conn = await connect();
  setDbForTesting(conn.db as never);
});

after(async () => {
  setDbForTesting(null);
  await stop();
});

beforeEach(async () => {
  await reset(conn);
  fixture = await seed(conn);
});

describe("the admin guard refuses an agent", () => {
  test("requireAdmin refuses an agent session, and says nothing about why", async () => {
    const { assertCan } = await import("../../src/lib/auth/roles");

    /*
      The capability an admin page needs. An agent holds `portfolio:write` and
      `job:create`; it does not hold this, and `assertCan` throws rather than
      returning a value a caller could forget to check.
    */
    assert.throws(() => assertCan("agent_owner", "certificate:issue"));
    assert.throws(() => assertCan("agent_member", "invoice:write"));
    assert.throws(() => assertCan("engineer", "portfolio:write"));

    // And an administrator holds them.
    assert.doesNotThrow(() => assertCan("admin", "certificate:issue"));
    assert.doesNotThrow(() => assertCan("admin", "invoice:write"));
  });

  test("every admin page asks for itself, so a missed matcher cannot expose one", async () => {
    /*
      The middleware matcher is a list somebody has to remember to update. This
      is the check that does not depend on remembering — and it is why the
      redirect the browser saw is the expected behaviour rather than a fault.
    */
    const { readdirSync, statSync } = await import("node:fs");
    const path = await import("node:path");

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
      const contents = readFileSync(page, "utf8");
      if (page.includes(`${path.sep}login${path.sep}`)) continue;
      assert.match(contents, /requireAdmin\(\)/, page);
    }
  });
});

describe("one agency cannot read another's portfolio", () => {
  test("a property is not found under the wrong organisation", async () => {
    const { getProperty } = await import("../../src/lib/portfolio/queries");

    const mine = await getProperty(fixture.organisationId, fixture.propertyId);
    assert.ok(mine, "the owning agency finds it");

    const theirs = await getProperty(
      fixture.otherOrganisationId,
      fixture.propertyId,
    );
    assert.equal(theirs, null, "the other agency finds nothing");
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

describe("the browser harness keeps its promises", () => {
  test("it fixes every key the application documents", () => {
    /*
      Next gives an already-present environment variable precedence over a
      `.env` file, so a key the harness sets cannot be supplied by one. A key it
      *misses* could be — which is what this catches when somebody adds a
      setting and forgets the harness.
    */
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
