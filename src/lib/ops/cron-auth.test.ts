import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { checkCronSecret, isCronConfigured } from "./cron-auth";

/**
 * The scheduler's way in.
 *
 * It is the only credential in this application that is not a session, so it
 * gets the narrowest possible definition: off unless deliberately configured,
 * compared in constant time, and granting exactly one thing.
 */

const GOOD = "a-scheduler-secret-of-sufficient-length";

function request(authorization?: string): Request {
  return new Request("https://bscj.example/api/cron/outbox", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  delete process.env.CRON_SECRET;
});

describe("it is off until it is configured", () => {
  test("no secret means the door does not exist", () => {
    /*
      The important direction. An unset credential must never read as "allow
      anyone" — it means this route has no scheduler path at all.
    */
    assert.equal(isCronConfigured(), false);
    assert.deepEqual(checkCronSecret(request(`Bearer ${GOOD}`)), { ok: false });
  });

  test("an empty secret is not a secret", () => {
    process.env.CRON_SECRET = "";
    assert.equal(isCronConfigured(), false);
    assert.deepEqual(checkCronSecret(request("Bearer ")), { ok: false });
  });

  test("a short secret is refused rather than warned about", () => {
    // A guessable credential on an endpoint that sends email is not a
    // configuration to accept with a note in the logs.
    process.env.CRON_SECRET = "too-short";
    assert.equal(isCronConfigured(), false);
    assert.deepEqual(checkCronSecret(request("Bearer too-short")), {
      ok: false,
    });
  });
});

describe("what it accepts", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = GOOD;
  });

  test("the right bearer token", () => {
    assert.deepEqual(checkCronSecret(request(`Bearer ${GOOD}`)), { ok: true });
  });

  test("a wrong token of the same length", () => {
    const wrong = "b".repeat(GOOD.length);
    assert.deepEqual(checkCronSecret(request(`Bearer ${wrong}`)), { ok: false });
  });

  test("a token that is a prefix of the real one", () => {
    assert.deepEqual(
      checkCronSecret(request(`Bearer ${GOOD.slice(0, -1)}`)),
      { ok: false },
    );
  });

  test("no header at all", () => {
    assert.deepEqual(checkCronSecret(request()), { ok: false });
  });

  test("the secret without the scheme", () => {
    assert.deepEqual(checkCronSecret(request(GOOD)), { ok: false });
  });

  test("another scheme carrying the right value", () => {
    assert.deepEqual(checkCronSecret(request(`Basic ${GOOD}`)), { ok: false });
  });

  test("the scheme is case-sensitive, as Vercel sends it", () => {
    assert.deepEqual(checkCronSecret(request(`bearer ${GOOD}`)), { ok: false });
  });
});
