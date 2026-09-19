import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  decodeAccountCookie,
  encodeAccountCookie,
  accountCookieOptions,
  clearedAccountCookieOptions,
} from "./account-cookie";
import { ACCOUNT_COOKIE_PATH, SET_PASSWORD_PATH } from "./account-paths";
import { createCredentialToken } from "./credential-token";

/**
 * The cookie that carries a credential from the link to the form.
 *
 * What is being asserted is containment: the value is well-formed on the way
 * out as well as in, and the attributes keep it away from every other surface.
 */

const TOKEN = "a".repeat(64);

describe("encoding and decoding", () => {
  test("a round trip preserves the purpose and the token", () => {
    const decoded = decodeAccountCookie(
      encodeAccountCookie("password_reset", TOKEN),
    );
    assert.deepEqual(decoded, { purpose: "password_reset", token: TOKEN });
  });

  test("both purposes survive", () => {
    for (const purpose of ["invitation", "password_reset"] as const) {
      const decoded = decodeAccountCookie(encodeAccountCookie(purpose, TOKEN));
      assert.equal(decoded?.purpose, purpose);
    }
  });

  test("a real minted token round-trips", () => {
    const saved = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "test-secret";
    try {
      const minted = createCredentialToken("invitation");
      const decoded = decodeAccountCookie(
        encodeAccountCookie("invitation", minted.token),
      );
      assert.equal(decoded?.token, minted.token);
    } finally {
      if (saved === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = saved;
    }
  });
});

describe("a cookie is something the browser states, never something it proves", () => {
  test("every malformed value decodes to null", () => {
    const bad = [
      undefined,
      "",
      TOKEN, // no purpose
      `invitation.${"a".repeat(63)}`, // short token
      `invitation.${"a".repeat(65)}`, // long token
      `invitation.${"A".repeat(64)}`, // uppercase is not our alphabet
      `invite.${TOKEN}`, // not a purpose
      `.${TOKEN}`,
      "invitation.",
      `invitation.${TOKEN};path=/`,
      `<script>.${TOKEN}`,
    ];
    for (const value of bad) {
      assert.equal(decodeAccountCookie(value), null, String(value));
    }
  });

  test("a token containing a dot cannot smuggle a second purpose", () => {
    // Split on the *first* dot, so everything after it is the token and is
    // then shape-checked. A value like "invitation.password_reset.<token>"
    // must not decode at all rather than decoding as something surprising.
    assert.equal(
      decodeAccountCookie(`invitation.password_reset.${TOKEN}`),
      null,
    );
  });
});

describe("the attributes", () => {
  test("it is httpOnly, lax and scoped to the account path", () => {
    const options = accountCookieOptions();
    assert.equal(options.httpOnly, true);
    assert.equal(options.sameSite, "lax");
    assert.equal(options.path, ACCOUNT_COOKIE_PATH);
    assert.ok(options.maxAge > 0);
  });

  test("the form lives inside the cookie path, or the browser would not send it", () => {
    /*
      The exact defect the scheduling flow hit: a cookie scoped to `/schedule`
      and an endpoint at `/api/schedule/confirm`, which does not match, so the
      browser never attached it and every genuine tenant was refused. Asserted
      here rather than discovered there.
    */
    const form: string = SET_PASSWORD_PATH;
    const fence: string = ACCOUNT_COOKIE_PATH;
    assert.ok(form === fence || form.startsWith(`${fence}/`));
  });

  test("clearing keeps the path, or the old cookie would survive", () => {
    const cleared = clearedAccountCookieOptions();
    assert.equal(cleared.maxAge, 0);
    assert.equal(cleared.path, ACCOUNT_COOKIE_PATH);
    assert.equal(cleared.httpOnly, true);
  });
});
