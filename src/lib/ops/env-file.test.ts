import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildPilotEnv,
  EnvFileError,
  parseEnvFile,
  pilotEnvPath,
  pilotRequested,
  PILOT_REQUIRED,
} from "./env-file";

/**
 * Loading pilot credentials, and refusing to guess.
 *
 * Isolated fixtures throughout: every case is a string passed in. No file is
 * read, no environment is mutated, nothing is connected to.
 */

const PILOT = [
  "DATABASE_URL=postgresql://u:p@ep-pilot-abc-pooler.eu-west-2.aws.neon.tech/neondb",
  "DATABASE_URL_UNPOOLED=postgresql://u:p@ep-pilot-abc.eu-west-2.aws.neon.tech/neondb",
  "BSCJ_PILOT_ENDPOINT=ep-pilot-abc.eu-west-2.aws.neon.tech",
].join("\n");

describe("parsing a real env file", () => {
  test("the ordinary shapes", () => {
    const found = parseEnvFile(
      [
        "# a comment",
        "",
        "PLAIN=value",
        "export EXPORTED=value",
        'DOUBLE="quoted value"',
        "SINGLE='quoted value'",
        "SPACED = spaced out ",
      ].join("\n"),
    );
    assert.equal(found.get("PLAIN"), "value");
    assert.equal(found.get("EXPORTED"), "value");
    assert.equal(found.get("DOUBLE"), "quoted value");
    assert.equal(found.get("SINGLE"), "quoted value");
    assert.equal(found.get("SPACED"), "spaced out");
  });

  test("a connection string survives its own punctuation", () => {
    /*
      The reason this exists rather than `source`-ing the file in a shell: a
      Neon URL carries `?`, `&`, `=` and often `#`, every one of which a shell
      would act on. Here they are just characters.
    */
    const url =
      "postgresql://user:p%40ss!w0rd@ep-a.example.com/db?sslmode=require&options=endpoint%3Dep-a";
    const found = parseEnvFile(`DATABASE_URL="${url}"`);
    assert.equal(found.get("DATABASE_URL"), url);
  });

  test("a hash inside quotes is part of the value", () => {
    const found = parseEnvFile('DATABASE_URL="postgresql://u:p#1@h/db"');
    assert.equal(found.get("DATABASE_URL"), "postgresql://u:p#1@h/db");
  });

  test("a hash after an unquoted value starts a comment", () => {
    const found = parseEnvFile("NAME=value # trailing note");
    assert.equal(found.get("NAME"), "value");
  });

  test("escapes are honoured inside double quotes only", () => {
    assert.equal(parseEnvFile('A="one\\ntwo"').get("A"), "one\ntwo");
    assert.equal(parseEnvFile("A='one\\ntwo'").get("A"), "one\\ntwo");
  });

  test("malformed lines are reported, not skipped", () => {
    // A silently skipped line becomes a missing variable, and a missing
    // variable used to become a fallback to the wrong database.
    for (const bad of ["JUST_A_NAME", "=novalue", "BAD NAME=value", 'A="unclosed']) {
      assert.throws(() => parseEnvFile(bad, "fixture"), EnvFileError, bad);
    }
  });

  test("a malformed line never echoes its value", () => {
    try {
      parseEnvFile("DATABASE_URL", "fixture");
      assert.fail("should have thrown");
    } catch (error) {
      assert.match((error as Error).message, /fixture line 1/);
    }

    try {
      parseEnvFile('DATABASE_URL="postgresql://u:secret@h/db" trailing', "fixture");
      assert.fail("should have thrown");
    } catch (error) {
      assert.equal((error as Error).message.includes("secret"), false);
    }
  });

  test("the reported line number is the file's own", () => {
    try {
      parseEnvFile("# note\n\nGOOD=1\nBROKEN", "fixture");
      assert.fail("should have thrown");
    } catch (error) {
      assert.match((error as Error).message, /line 4/);
    }
  });
});

describe("pilot mode is sealed", () => {
  test("a complete file is accepted", () => {
    const { mode, vars } = buildPilotEnv({
      text: PILOT,
      path: ".env.pilot",
      required: PILOT_REQUIRED,
    });
    assert.equal(mode, "pilot");
    assert.equal(vars.BSCJ_PILOT_ENDPOINT, "ep-pilot-abc.eu-west-2.aws.neon.tech");
  });

  test("an incomplete file stops, naming every missing variable", () => {
    try {
      buildPilotEnv({
        text: "DATABASE_URL=postgresql://u:p@ep-a.example.com/db",
        path: ".env.pilot",
        required: PILOT_REQUIRED,
      });
      assert.fail("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      assert.match(message, /DATABASE_URL_UNPOOLED/);
      assert.match(message, /BSCJ_PILOT_ENDPOINT/);
    }
  });

  test("an empty value counts as missing", () => {
    // Otherwise `DATABASE_URL_UNPOOLED=` reads as "supplied" and the
    // preference silently falls back to the pooled one.
    assert.throws(
      () =>
        buildPilotEnv({
          text: PILOT.replace(
            "BSCJ_PILOT_ENDPOINT=ep-pilot-abc.eu-west-2.aws.neon.tech",
            "BSCJ_PILOT_ENDPOINT=   ",
          ),
          path: ".env.pilot",
          required: PILOT_REQUIRED,
        }),
      EnvFileError,
    );
  });

  test("requirements are checked against the FILE, never the process", () => {
    /*
      The property that makes a pilot a pilot. A development `DATABASE_URL`
      exported in the calling shell must not satisfy a pilot requirement — that
      is how a pilot command half-works against the wrong database.
    */
    const saved = process.env.DATABASE_URL_UNPOOLED;
    process.env.DATABASE_URL_UNPOOLED =
      "postgresql://u:p@ep-development.example.com/devdb";
    try {
      assert.throws(
        () =>
          buildPilotEnv({
            text: "DATABASE_URL=postgresql://u:p@ep-a.example.com/db\nBSCJ_PILOT_ENDPOINT=ep-a.example.com",
            path: ".env.pilot",
            required: PILOT_REQUIRED,
          }),
        (error: unknown) =>
          error instanceof EnvFileError &&
          /DATABASE_URL_UNPOOLED/.test(error.message),
      );
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL_UNPOOLED;
      else process.env.DATABASE_URL_UNPOOLED = saved;
    }
  });

  test("the message says fallback will not happen", () => {
    try {
      buildPilotEnv({ text: "", path: ".env.pilot", required: PILOT_REQUIRED });
      assert.fail("should have thrown");
    } catch (error) {
      assert.match((error as Error).message, /does not fall back/i);
    }
  });

  test("building never mutates the process environment", () => {
    const before = process.env.BSCJ_PILOT_ENDPOINT;
    buildPilotEnv({ text: PILOT, path: ".env.pilot", required: PILOT_REQUIRED });
    assert.equal(process.env.BSCJ_PILOT_ENDPOINT, before);
  });
});

describe("entering pilot mode is opt-in by name", () => {
  test("only an exact BSCJ_PILOT=1", () => {
    assert.equal(pilotRequested({ BSCJ_PILOT: "1" }), true);
    for (const value of [undefined, "", "0", "true", "yes", "on"]) {
      assert.equal(pilotRequested({ BSCJ_PILOT: value }), false, String(value));
    }
  });

  test("the file path is defaulted, overridable and never guessed", () => {
    assert.equal(pilotEnvPath({}), ".env.pilot");
    assert.equal(pilotEnvPath({ BSCJ_PILOT_ENV_FILE: "  " }), ".env.pilot");
    assert.equal(pilotEnvPath({ BSCJ_PILOT_ENV_FILE: "other.env" }), "other.env");
  });
});
