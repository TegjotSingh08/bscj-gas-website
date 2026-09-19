import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  createCredentialToken,
  credentialTokenMatches,
  CREDENTIAL_LIFETIME_HOURS,
  CredentialSecretMissingError,
  hashCredentialToken,
  isCredentialPurpose,
  isWellFormedCredentialToken,
  redactToken,
} from "./credential-token";
import { hashToken as hashSchedulingToken } from "@/lib/scheduling/token";

/**
 * Account credentials, as cryptography.
 *
 * Pure, so every rule here is provable without a database, a request or a
 * clock. The rules that matter are the ones that make an invitation different
 * from a tenant's scheduling link.
 */

const SECRET = "test-auth-secret-for-account-credentials";

let previousAuth: string | undefined;
let previousScheduling: string | undefined;

before(() => {
  previousAuth = process.env.AUTH_SECRET;
  previousScheduling = process.env.SCHEDULING_TOKEN_SECRET;
  process.env.AUTH_SECRET = SECRET;
  // Deliberately the *same* value, to prove the domain separation is doing the
  // work rather than the secrets happening to differ.
  process.env.SCHEDULING_TOKEN_SECRET = SECRET;
});

after(() => {
  if (previousAuth === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = previousAuth;
  if (previousScheduling === undefined) delete process.env.SCHEDULING_TOKEN_SECRET;
  else process.env.SCHEDULING_TOKEN_SECRET = previousScheduling;
});

describe("minting a credential", () => {
  test("the token is 32 bytes of hex and the hash is not the token", () => {
    const minted = createCredentialToken("invitation");
    assert.match(minted.token, /^[0-9a-f]{64}$/);
    assert.ok(!minted.tokenHash.includes(minted.token));
    assert.match(minted.tokenHash, /^hmac\$[0-9a-f]{64}$/);
  });

  test("two mints never collide", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(createCredentialToken("invitation").token);
    }
    assert.equal(seen.size, 200);
  });

  test("an invitation lasts longer than a reset, and both are finite", () => {
    // A reset is asked for by somebody sitting at the form; an invitation may
    // wait for a person who is away. A link that outlives its purpose is a
    // spare key.
    assert.ok(
      CREDENTIAL_LIFETIME_HOURS.invitation >
        CREDENTIAL_LIFETIME_HOURS.password_reset,
    );
    assert.ok(CREDENTIAL_LIFETIME_HOURS.password_reset > 0);
  });

  test("the expiry follows the purpose and the clock it was given", () => {
    const now = new Date("2026-09-19T10:00:00.000Z");
    const reset = createCredentialToken("password_reset", now);
    assert.equal(
      reset.expiresAt.getTime() - now.getTime(),
      CREDENTIAL_LIFETIME_HOURS.password_reset * 60 * 60 * 1000,
    );
  });
});

describe("the purpose is part of the credential, not a label beside it", () => {
  test("one token hashes to two unrelated values", () => {
    const token = createCredentialToken("invitation").token;
    assert.notEqual(
      hashCredentialToken(token, "invitation"),
      hashCredentialToken(token, "password_reset"),
    );
  });

  test("a reset token does not verify as an invitation", () => {
    // This is what makes "wrong purpose" fail in the cryptography rather than
    // in a WHERE clause somebody could one day forget to write.
    const minted = createCredentialToken("password_reset");
    assert.equal(
      credentialTokenMatches(minted.token, "password_reset", minted.tokenHash),
      true,
    );
    assert.equal(
      credentialTokenMatches(minted.token, "invitation", minted.tokenHash),
      false,
    );
  });
});

describe("account credentials are not scheduling tokens", () => {
  test("the same token hashes differently under each scheme", () => {
    // Both secrets are set to the same value above, so this can only pass if
    // the labels separate them. A leaked scheduling row must not be usable to
    // recognise an account credential, or the reverse.
    const token = createCredentialToken("invitation").token;
    assert.notEqual(
      hashCredentialToken(token, "invitation"),
      hashSchedulingToken(token),
    );
  });
});

describe("verification", () => {
  test("a wrong token is refused", () => {
    const minted = createCredentialToken("invitation");
    const other = createCredentialToken("invitation");
    assert.equal(
      credentialTokenMatches(other.token, "invitation", minted.tokenHash),
      false,
    );
  });

  test("a malformed or unknown stored hash is refused, never thrown", () => {
    const minted = createCredentialToken("invitation");
    for (const stored of ["", "nonsense", "sha256$abc", "$$$", "hmac$"]) {
      assert.equal(
        credentialTokenMatches(minted.token, "invitation", stored),
        false,
      );
    }
  });

  test("plain SHA-256 is not accepted", () => {
    /*
      The scheduling module accepts an unpeppered `sha256$…` because refusing
      to create a job over an optional secret would be the worse failure. There
      is no equivalent argument here, so the fallback does not exist and a hash
      naming it is refused outright.
    */
    const minted = createCredentialToken("invitation");
    const asSha256 = minted.tokenHash.replace("hmac$", "sha256$");
    assert.equal(
      credentialTokenMatches(minted.token, "invitation", asSha256),
      false,
    );
  });
});

describe("failing closed without a secret", () => {
  test("nothing can be minted", () => {
    const saved = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      assert.throws(
        () => createCredentialToken("invitation"),
        CredentialSecretMissingError,
      );
    } finally {
      process.env.AUTH_SECRET = saved;
    }
  });

  test("verification refuses rather than throwing", () => {
    // A caller in a request path must get `false`, not an exception that
    // becomes a 500 and tells somebody the deployment is misconfigured.
    const minted = createCredentialToken("invitation");
    const saved = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      assert.equal(
        credentialTokenMatches(minted.token, "invitation", minted.tokenHash),
        false,
      );
    } finally {
      process.env.AUTH_SECRET = saved;
    }
  });
});

describe("shape checks and redaction", () => {
  test("only 64 hex characters could have come from us", () => {
    assert.equal(isWellFormedCredentialToken("a".repeat(64)), true);
    assert.equal(isWellFormedCredentialToken("A".repeat(64)), false);
    assert.equal(isWellFormedCredentialToken("a".repeat(63)), false);
    assert.equal(isWellFormedCredentialToken("a".repeat(65)), false);
    assert.equal(isWellFormedCredentialToken(null), false);
    assert.equal(isWellFormedCredentialToken(12345), false);
  });

  test("only the two purposes are purposes", () => {
    assert.equal(isCredentialPurpose("invitation"), true);
    assert.equal(isCredentialPurpose("password_reset"), true);
    assert.equal(isCredentialPurpose("invite"), false);
    assert.equal(isCredentialPurpose(""), false);
    assert.equal(isCredentialPurpose(undefined), false);
  });

  test("redaction reveals nothing at all, not even a prefix", () => {
    // Eight characters of a 64-character token is still a head start, and no
    // operational question is answered by it that the credential's row cannot
    // answer instead.
    const minted = createCredentialToken("invitation");
    const redacted = redactToken();
    assert.equal(redacted, "<token>");
    assert.ok(!minted.token.includes(redacted));
  });
});
