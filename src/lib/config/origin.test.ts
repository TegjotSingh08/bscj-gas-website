import { test, describe, beforeEach, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

import {
  AppOriginError,
  appOriginStatus,
  deployment,
  linkTo,
  resolveAppOrigin,
  validateOrigin,
} from "./origin";
import { business } from "@/lib/business";

/**
 * Source with comments removed.
 *
 * The rule below is about what the code *does*, not about the prose
 * explaining why — the doc comment names the very headers it forbids reading,
 * in order to explain why they must not be read.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Where a link points.
 *
 * The failure this guards against is quiet and expensive: an invitation minted
 * on staging that points at production sends somebody to a site where their
 * account does not exist and their token hashes to nothing. It looks forged to
 * them and broken to us, and nothing in the logs says so.
 */

const VARS = ["BSCJ_APP_ORIGIN", "VERCEL_ENV", "VERCEL_URL", "NODE_ENV", "PORT"];
let saved: Record<string, string | undefined> = {};

/**
 * Writes an environment variable in a test.
 *
 * Through an index signature because Next types `NODE_ENV` as read-only, and
 * these tests need to set it: distinguishing a preview from production is the
 * whole point, and a preview builds with `NODE_ENV=production`.
 */
function setEnv(key: string, value: string): void {
  (process.env as Record<string, string | undefined>)[key] = value;
}

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const key of VARS) delete process.env[key];
});

afterEach(() => {
  for (const key of VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("validating an origin", () => {
  test("a plain https origin is accepted and normalised", () => {
    assert.equal(validateOrigin("https://staging.example.com"), "https://staging.example.com");
    assert.equal(validateOrigin("  https://staging.example.com/  "), "https://staging.example.com");
    assert.equal(validateOrigin("https://staging.example.com:8443"), "https://staging.example.com:8443");
  });

  test("http is allowed only for localhost", () => {
    // A token in a link sent over http is a token on the wire, and anything
    // that is not localhost is on a wire.
    assert.equal(validateOrigin("http://localhost:3100"), "http://localhost:3100");
    assert.equal(validateOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
    assert.throws(() => validateOrigin("http://staging.example.com"), AppOriginError);
  });

  test("anything that is not purely an origin is refused", () => {
    // Each of these concatenates with a path and a credential into something
    // nobody intended.
    for (const bad of [
      "",
      "   ",
      "not-a-url",
      "//evil.example",
      "https://user:pw@example.com",
      "https://example.com/path",
      "https://example.com/?next=x",
      "https://example.com/#frag",
      "ftp://example.com",
      "javascript:alert(1)",
      "data:text/html,x",
    ]) {
      assert.throws(() => validateOrigin(bad), AppOriginError, bad);
    }
  });
});

describe("which deployment this is", () => {
  test("a preview is not production, even though its NODE_ENV is", () => {
    /*
      The distinction that matters. A Vercel preview builds with
      NODE_ENV=production, so reading NODE_ENV alone would have a preview
      sending production links — which is exactly the bug.
    */
    setEnv("NODE_ENV", "production");
    setEnv("VERCEL_ENV", "preview");
    assert.equal(deployment(), "preview");
  });

  test("production is production", () => {
    setEnv("VERCEL_ENV", "production");
    assert.equal(deployment(), "production");
  });

  test("with no platform variable it falls back to NODE_ENV", () => {
    setEnv("NODE_ENV", "production");
    assert.equal(deployment(), "production");
    setEnv("NODE_ENV", "development");
    assert.equal(deployment(), "development");
  });
});

describe("resolving the origin", () => {
  test("an explicit setting wins everywhere", () => {
    setEnv("VERCEL_ENV", "production");
    setEnv("BSCJ_APP_ORIGIN", "https://pilot.example.com");
    assert.deepEqual(resolveAppOrigin(), { ok: true, origin: "https://pilot.example.com" });
  });

  test("an invalid explicit setting is an error, never a fallback", () => {
    /*
      Falling back would quietly send pilot invitations to production. A
      refusal is recorded against the outbox row and retried; a silent
      fallback is a person clicking a link into the wrong system.
    */
    setEnv("VERCEL_ENV", "preview");
    setEnv("VERCEL_URL", "deploy-abc.vercel.app");
    setEnv("BSCJ_APP_ORIGIN", "http://not-localhost.example.com");
    const resolved = resolveAppOrigin();
    assert.equal(resolved.ok, false);
  });

  test("production needs no new variable", () => {
    // The canonical marketing origin genuinely is the app origin in
    // production, so a correct production deployment works unchanged.
    setEnv("VERCEL_ENV", "production");
    assert.deepEqual(resolveAppOrigin(), { ok: true, origin: business.url.replace(/\/$/, "") });
  });

  test("a preview addresses itself through the platform variable", () => {
    setEnv("VERCEL_ENV", "preview");
    setEnv("VERCEL_URL", "bscj-git-v2-abc.vercel.app");
    assert.deepEqual(resolveAppOrigin(), {
      ok: true,
      origin: "https://bscj-git-v2-abc.vercel.app",
    });
  });

  test("a preview with nothing to go on refuses rather than guessing", () => {
    setEnv("VERCEL_ENV", "preview");
    const resolved = resolveAppOrigin();
    assert.equal(resolved.ok, false);
  });

  test("development is localhost on the configured port", () => {
    setEnv("NODE_ENV", "development");
    setEnv("PORT", "3100");
    assert.deepEqual(resolveAppOrigin(), { ok: true, origin: "http://localhost:3100" });
  });
});

describe("a request can never choose where a link points", () => {
  test("nothing in this module reads a header", () => {
    /*
      `Host` and `X-Forwarded-Host` are attacker controlled. A request
      carrying `Host: evil.example` must not be able to mint an invitation
      pointing at evil.example — the token in it is a working credential.

      Asserted structurally because the property is "this code never reads a
      header", which no input can demonstrate the absence of.
    */
    const source = withoutComments(
      readFileSync(path.resolve(process.cwd(), "src/lib/config/origin.ts"), "utf8"),
    ).toLowerCase();
    for (const forbidden of [
      "headers(",
      "x-forwarded",
      "req.headers",
      "request.headers",
      '"host"',
    ]) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  });

  test("the outbox builds every credential link from this module", () => {
    // The regression guard: a future edit that reaches for business.url again
    // would send staging invitations to production.
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/notifications/outbox.ts"),
      "utf8",
    );
    assert.equal(source.includes("business.url"), false);
    assert.ok(source.includes("resolveAppOrigin"));
  });
});

describe("building a link", () => {
  test("it is rooted at this deployment", () => {
    setEnv("BSCJ_APP_ORIGIN", "https://pilot.example.com");
    assert.equal(linkTo("/account/invitation/abc"), "https://pilot.example.com/account/invitation/abc");
  });

  test("an unrooted path is refused rather than concatenated", () => {
    setEnv("BSCJ_APP_ORIGIN", "https://pilot.example.com");
    assert.throws(() => linkTo("account/invitation/abc"), AppOriginError);
  });

  test("it throws rather than returning a half-built link", () => {
    setEnv("VERCEL_ENV", "preview");
    assert.throws(() => linkTo("/x"), AppOriginError);
  });
});

describe("the readiness screen", () => {
  test("it reports the origin, which is not a secret", () => {
    setEnv("BSCJ_APP_ORIGIN", "https://pilot.example.com");
    const status = appOriginStatus();
    assert.equal(status.ready, true);
    assert.equal(status.origin, "https://pilot.example.com");
    assert.equal(status.requirement, null);
  });

  test("it names what is missing rather than failing", () => {
    setEnv("VERCEL_ENV", "preview");
    const status = appOriginStatus();
    assert.equal(status.ready, false);
    assert.equal(status.origin, null);
    assert.ok((status.requirement ?? "").length > 10);
  });
});
