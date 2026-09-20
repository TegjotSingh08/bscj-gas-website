import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  assertConfirmedEndpoint,
  endpointKey,
  identify,
  parseConnection,
  resolveTarget,
  TargetError,
} from "./db-target";

/**
 * Which database a command is about to touch.
 *
 * Isolated: every case is a string. No database is contacted, and no account —
 * least of all the real administrator — is read or written.
 */

const POOLED = "postgresql://u:p@ep-pilot-abc-pooler.eu-west-2.aws.neon.tech/neondb";
const DIRECT = "postgresql://u:p@ep-pilot-abc.eu-west-2.aws.neon.tech/neondb";
const OTHER = "postgresql://u:p@ep-dev-xyz.eu-west-2.aws.neon.tech/neondb";

describe("validating a connection string", () => {
  test("a well-formed one parses", () => {
    assert.deepEqual(parseConnection(DIRECT, "x"), {
      hostname: "ep-pilot-abc.eu-west-2.aws.neon.tech",
      database: "neondb",
    });
  });

  test("anything that is not a Postgres URL naming a database is refused", () => {
    // Each of these becomes a driver error halfway through a migration if it
    // is allowed through here.
    for (const bad of [
      "",
      "   ",
      "not-a-url",
      "https://example.com/neondb",
      "postgresql://ep-host.example.com",
      "postgresql://ep-host.example.com/",
      "mysql://u:p@host/db",
    ]) {
      assert.throws(() => parseConnection(bad, "DATABASE_URL"), TargetError, bad);
    }
  });

  test("the identity carries no credential", () => {
    const shown = identify(DIRECT);
    assert.equal(shown, "ep-pilot-abc.eu-west-2.aws.neon.tech/neondb");
    assert.equal(shown.includes("u:p"), false);
    assert.equal(shown.includes("postgresql"), false);
  });
});

describe("normalising only the recognised pooler suffix", () => {
  test("pooled and direct of one database are the same target", () => {
    assert.equal(endpointKey(POOLED), endpointKey(DIRECT));
  });

  test("different endpoints stay different", () => {
    assert.notEqual(endpointKey(DIRECT), endpointKey(OTHER));
  });

  test("only the first label is normalised, and only a trailing suffix", () => {
    /*
      A blanket `replace("-pooler", "")` would equate hosts that are not the
      same machine. The suffix is stripped from the endpoint label only, and
      only where it actually ends that label.
    */
    const inDomain = "postgresql://u:p@ep-a.pooler-zone.example.com/db";
    assert.equal(
      endpointKey(inDomain),
      "ep-a.pooler-zone.example.com/db",
      "a domain label containing the word must be untouched",
    );

    const midLabel = "postgresql://u:p@ep-pooler-one.example.com/db";
    assert.equal(
      endpointKey(midLabel),
      "ep-pooler-one.example.com/db",
      "the word mid-label must be untouched",
    );
  });

  test("the database name is part of the target", () => {
    // Same endpoint, different database, is not the same place.
    assert.notEqual(
      endpointKey(DIRECT),
      endpointKey(DIRECT.replace("/neondb", "/otherdb")),
    );
  });
});

describe("resolving which connection a command uses", () => {
  test("the direct endpoint is preferred, matching drizzle-kit", () => {
    const target = resolveTarget({
      DATABASE_URL: POOLED,
      DATABASE_URL_UNPOOLED: DIRECT,
    });
    assert.equal(target.source, "DATABASE_URL_UNPOOLED");
    assert.equal(target.url, DIRECT);
  });

  test("either one alone is fine", () => {
    assert.equal(resolveTarget({ DATABASE_URL: POOLED }).source, "DATABASE_URL");
    assert.equal(
      resolveTarget({ DATABASE_URL_UNPOOLED: DIRECT }).source,
      "DATABASE_URL_UNPOOLED",
    );
  });

  test("neither is an error", () => {
    assert.throws(() => resolveTarget({}), TargetError);
    assert.throws(() => resolveTarget({ DATABASE_URL: "  " }), TargetError);
  });

  test("CONFLICTING targets STOP rather than warn", () => {
    /*
      The behaviour this replaced only warned and carried on, which meant the
      operator had to catch one line of output mid-run. Migrations would have
      gone to one database and the application read the other.
    */
    assert.throws(
      () => resolveTarget({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: OTHER }),
      (error: unknown) =>
        error instanceof TargetError &&
        /different databases/i.test(error.message),
    );
  });

  test("a conflict message names both, without credentials", () => {
    try {
      resolveTarget({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: OTHER });
      assert.fail("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      assert.match(message, /ep-pilot-abc/);
      assert.match(message, /ep-dev-xyz/);
      assert.equal(message.includes("u:p"), false);
    }
  });

  test("a malformed partner is refused even though the other is fine", () => {
    assert.throws(
      () => resolveTarget({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: "nonsense" }),
      TargetError,
    );
  });
});

describe("matching URLs do not establish which database this is", () => {
  const target = resolveTarget({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT });

  test("a confirmed endpoint is required before writing", () => {
    // Two copies of the same wrong connection string agree perfectly, so the
    // pair proves nothing on its own.
    assert.throws(() => assertConfirmedEndpoint(target, undefined), TargetError);
    assert.throws(() => assertConfirmedEndpoint(target, "   "), TargetError);
  });

  test("a matching endpoint passes, in the forms a person would paste", () => {
    for (const confirmed of [
      "ep-pilot-abc.eu-west-2.aws.neon.tech",
      "ep-pilot-abc-pooler.eu-west-2.aws.neon.tech",
      "ep-pilot-abc.eu-west-2.aws.neon.tech/neondb",
      "ep-pilot-abc-pooler.eu-west-2.aws.neon.tech/neondb",
      "https://ep-pilot-abc.eu-west-2.aws.neon.tech",
      "  ep-pilot-abc.eu-west-2.aws.neon.tech/  ",
    ]) {
      assert.doesNotThrow(() => assertConfirmedEndpoint(target, confirmed), confirmed);
    }
  });

  test("REGRESSION: the same endpoint id on a different domain is refused", () => {
    /*
      Reproduced and previously accepted. The check fell back to comparing only
      the leading label, so an endpoint id that matched was enough and the
      domain — which says which provider and region the database is in — was
      ignored. Matching on the easy half made the check a formality.
    */
    for (const wrongDomain of [
      "ep-pilot-abc.example.invalid",
      "ep-pilot-abc.us-east-1.aws.neon.tech",
      "ep-pilot-abc.eu-west-2.aws.neon.tech.evil.invalid",
      "ep-pilot-abc",
    ]) {
      assert.throws(
        () => assertConfirmedEndpoint(target, wrongDomain),
        TargetError,
        wrongDomain,
      );
    }
  });

  test("REGRESSION: a different database on the right host is refused", () => {
    /*
      Also reproduced and previously accepted. One Neon endpoint serves many
      databases, so `…/otherdb` is a different database reached through the
      same host — the same class of mistake as a different host, and invisible
      when only the host is compared.
    */
    assert.throws(
      () => assertConfirmedEndpoint(target, "ep-pilot-abc.eu-west-2.aws.neon.tech/otherdb"),
      TargetError,
    );
    assert.throws(
      () =>
        assertConfirmedEndpoint(
          target,
          "ep-pilot-abc-pooler.eu-west-2.aws.neon.tech/otherdb",
        ),
      TargetError,
    );
  });

  test("a bare host stays supported, and says nothing about the database", () => {
    // Documented behaviour: confirming the endpoint alone is a weaker but
    // honest statement. Supplying the database makes it stronger.
    assert.doesNotThrow(() =>
      assertConfirmedEndpoint(target, "ep-pilot-abc.eu-west-2.aws.neon.tech"),
    );
  });

  test("pooled and direct confirmations are equivalent, both ways round", () => {
    // One database reached two ways. A correct setup relies on this, so the
    // stricter hostname rule must not break it.
    const pooledTarget = resolveTarget({ DATABASE_URL: POOLED });
    const directTarget = resolveTarget({ DATABASE_URL_UNPOOLED: DIRECT });

    for (const subject of [pooledTarget, directTarget]) {
      for (const confirmed of [
        "ep-pilot-abc.eu-west-2.aws.neon.tech",
        "ep-pilot-abc-pooler.eu-west-2.aws.neon.tech",
        "ep-pilot-abc.eu-west-2.aws.neon.tech/neondb",
      ]) {
        assert.doesNotThrow(
          () => assertConfirmedEndpoint(subject, confirmed),
          `${subject.source} vs ${confirmed}`,
        );
      }
    }
  });

  test("a confirmation naming no host is refused", () => {
    for (const bad of ["/neondb", "https://", "   /  "]) {
      assert.throws(() => assertConfirmedEndpoint(target, bad), TargetError, bad);
    }
  });

  test("a different endpoint is refused, and nothing is written", () => {
    assert.throws(
      () => assertConfirmedEndpoint(target, "ep-dev-xyz.eu-west-2.aws.neon.tech"),
      (error: unknown) =>
        error instanceof TargetError &&
        /does not match the confirmed pilot endpoint/i.test(error.message) &&
        /Nothing has been written/i.test(error.message),
    );
  });

  test("the refusal shows both sides without a credential", () => {
    try {
      assertConfirmedEndpoint(target, "ep-dev-xyz.eu-west-2.aws.neon.tech");
      assert.fail("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      assert.match(message, /ep-pilot-abc/);
      assert.match(message, /ep-dev-xyz/);
      assert.equal(message.includes("u:p"), false);
    }
  });
});
