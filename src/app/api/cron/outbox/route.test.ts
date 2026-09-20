import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The scheduler's door.
 *
 * The defect these exist to prevent was found by reading Vercel's own docs
 * rather than by a failing test, and it would not have surfaced until the
 * pilot: **Vercel Cron invokes a job with a GET**, this route was POST-only,
 * so every scheduled run would have answered 405 and the queue would never
 * have drained. Nothing in the application reports that. Every invitation,
 * reset, tenant link, certificate and invoice would have sat `pending`.
 *
 * Driving the handler needs a database and a mail transport, so what is
 * asserted here is the shape of the contract — which is exactly where the
 * defect lived.
 */

const ROUTE = path.resolve(process.cwd(), "src/app/api/cron/outbox/route.ts");
const source = readFileSync(ROUTE, "utf8");

/** Source with comments removed, so prose about a rule cannot satisfy it. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const body = code(source);

describe("the method Vercel Cron actually sends", () => {
  test("GET is handled", () => {
    // Vercel Cron makes an HTTP GET to the production deployment URL.
    assert.match(body, /export async function GET\s*\(/);
  });

  test("POST is still handled, for the administrator's manual drain", () => {
    assert.match(body, /export async function POST\s*\(/);
  });
});

describe("a mutating GET is safe only because of the credential", () => {
  test("GET checks the cron secret", () => {
    const get = body.slice(body.indexOf("export async function GET"));
    const upToPost = get.slice(0, get.indexOf("export async function POST"));
    assert.match(upToPost, /checkCronSecret/);
  });

  test("GET has no session or same-origin fallback", () => {
    /*
      The whole answer to "a GET that mutates gets followed by every prefetcher
      and link checker". A fallback here would reintroduce it: a browser that
      is already signed in as an administrator would drain the queue by
      prefetching the URL.
    */
    const get = body.slice(body.indexOf("export async function GET"));
    const upToPost = get.slice(0, get.indexOf("export async function POST"));
    assert.equal(upToPost.includes("requireAdminOrThrow"), false);
    assert.equal(upToPost.includes("checkSameOrigin"), false);
  });

  test("GET refuses before it drains", () => {
    const get = body.slice(body.indexOf("export async function GET"));
    const upToPost = get.slice(0, get.indexOf("export async function POST"));
    assert.ok(
      upToPost.indexOf("checkCronSecret") < upToPost.indexOf("drain("),
      "the secret must be checked before anything is sent",
    );
  });
});

describe("headers are never treated as credentials", () => {
  test("the user agent and schedule header are not used to authenticate", () => {
    // Vercel sends `vercel-cron/1.0` and `x-vercel-cron-schedule`. Both are
    // request headers, so anyone can send them; only the secret proves
    // anything.
    assert.equal(body.toLowerCase().includes("vercel-cron"), false);
    assert.equal(body.toLowerCase().includes("user-agent"), false);
  });
});

describe("the response says nothing it should not", () => {
  test("it returns counts, not content", () => {
    // An invitation's link exists in the message body and nowhere else. A
    // response that echoed a recipient or a token would put it in a log.
    assert.match(body, /report/);
    for (const leak of ["token", "recipient", "email:", "link"]) {
      assert.equal(body.includes(leak), false, leak);
    }
  });
});

describe("the declared schedule", () => {
  const vercel = JSON.parse(
    readFileSync(path.resolve(process.cwd(), "vercel.json"), "utf8"),
  ) as { crons?: { path: string; schedule: string }[] };

  test("it points at this route", () => {
    const cron = vercel.crons?.find((c) => c.path === "/api/cron/outbox");
    assert.ok(cron, "vercel.json must declare the outbox drain");
  });

  test("the expression is one Vercel accepts", () => {
    // Five space-separated fields, no alternative names like MON or JAN,
    // which Vercel does not support.
    const cron = vercel.crons?.find((c) => c.path === "/api/cron/outbox");
    assert.match(cron!.schedule, /^(\S+\s+){4}\S+$/);
    assert.equal(/[A-Za-z]/.test(cron!.schedule), false);
  });

  test("day-of-month and day-of-week are not both set", () => {
    // Vercel refuses a expression that configures both; one must be `*`.
    const cron = vercel.crons?.find((c) => c.path === "/api/cron/outbox");
    const [, , dom, , dow] = cron!.schedule.split(/\s+/);
    assert.ok(dom === "*" || dow === "*");
  });
});

describe("the scheduler is outside the middleware matcher", () => {
  test("nothing redirects a cron request", () => {
    /*
      Cron jobs do not follow redirects — a 3xx ends the invocation. The
      middleware matcher deliberately omits `/api/cron`, so a scheduled call
      reaches the handler rather than being bounced to a login page that the
      scheduler would treat as a completed run.
    */
    const middleware = code(
      readFileSync(path.resolve(process.cwd(), "src/middleware.ts"), "utf8"),
    );
    // Comments stripped first: the file explains at length *why* `/api/cron`
    // is absent, and that prose must not be read as the matcher containing it.
    const matcher = middleware.slice(middleware.indexOf("matcher"));
    assert.ok(matcher.length > 0, "the middleware must declare a matcher");
    assert.equal(matcher.includes("/api/cron"), false);
  });
});
