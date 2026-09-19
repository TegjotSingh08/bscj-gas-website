import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { checkSameOrigin } from "./origin";
import {
  isWithinSchedulingCookiePath,
  SCHEDULING_CONFIRM_PATH,
  SCHEDULING_COOKIE_PATH,
} from "./paths";

/**
 * The two things that were only true by accident.
 *
 * The confirmation endpoint was protected against cross-site posting solely by
 * `SameSite=Lax`, and reachable by the tenant's own browser solely by
 * coincidence of URL — which it was not, in fact, so every real confirmation
 * failed. Both are now properties with names, and both are checked here.
 */

function request(headers: Record<string, string>): Request {
  return new Request("http://bscj.example/schedule/api/confirm", {
    method: "POST",
    headers,
  });
}

describe("the confirmation endpoint is inside the cookie's path", () => {
  test("the browser would attach the cookie to it", () => {
    /*
      The regression test for the defect this phase exists to repair. An
      endpoint at `/api/schedule/confirm` does not begin with `/schedule`, so
      the browser never sent the session and the handler answered 401 to every
      genuine tenant — while every unit test passed, because none of them made
      an HTTP request.
    */
    assert.ok(
      isWithinSchedulingCookiePath(SCHEDULING_CONFIRM_PATH),
      `${SCHEDULING_CONFIRM_PATH} is outside ${SCHEDULING_COOKIE_PATH}, so the browser will never send the session to it`,
    );
  });

  test("the path rule is RFC 6265's, not a prefix match", () => {
    assert.equal(isWithinSchedulingCookiePath("/schedule"), true);
    assert.equal(isWithinSchedulingCookiePath("/schedule/appointment"), true);
    assert.equal(isWithinSchedulingCookiePath("/schedule/api/confirm"), true);

    // The trap a naive `startsWith` falls into.
    assert.equal(isWithinSchedulingCookiePath("/schedule-other"), false);
    assert.equal(isWithinSchedulingCookiePath("/api/schedule/confirm"), false);
    assert.equal(isWithinSchedulingCookiePath("/portal"), false);
  });
});

describe("only our own page may post a confirmation", () => {
  test("a same-origin post is allowed", () => {
    assert.deepEqual(
      checkSameOrigin(
        request({ origin: "http://bscj.example", host: "bscj.example" }),
      ),
      { ok: true },
    );
  });

  test("a cross-site post is refused", () => {
    assert.deepEqual(
      checkSameOrigin(
        request({ origin: "https://evil.example", host: "bscj.example" }),
      ),
      { ok: false },
    );
  });

  test("a missing Origin is refused rather than waved through", () => {
    // A browser sends it on every POST. Accepting its absence would make the
    // check avoidable by omitting one header.
    assert.deepEqual(checkSameOrigin(request({ host: "bscj.example" })), {
      ok: false,
    });
  });

  test("an opaque origin is refused", () => {
    assert.deepEqual(
      checkSameOrigin(request({ origin: "null", host: "bscj.example" })),
      { ok: false },
    );
  });

  test("the proxy's forwarded host is what the origin is compared against", () => {
    // Behind a proxy the `Host` header is the internal one, and comparing an
    // origin against that would refuse every real request.
    assert.deepEqual(
      checkSameOrigin(
        request({
          origin: "https://bscj.example",
          host: "internal-3000.local",
          "x-forwarded-host": "bscj.example",
        }),
      ),
      { ok: true },
    );
  });

  test("a forwarded host list is read from the left", () => {
    assert.deepEqual(
      checkSameOrigin(
        request({
          origin: "https://bscj.example",
          "x-forwarded-host": "bscj.example, inner.local",
          host: "inner.local",
        }),
      ),
      { ok: true },
    );
  });

  test("the comparison ignores case", () => {
    assert.deepEqual(
      checkSameOrigin(
        request({ origin: "https://BSCJ.Example", host: "bscj.example" }),
      ),
      { ok: true },
    );
  });
});
