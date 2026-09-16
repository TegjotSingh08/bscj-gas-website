import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  generateJobReference,
  isJobReference,
  normaliseJobReference,
  REFERENCE_PREFIX,
  REFERENCE_SPACE,
} from "./reference";

/**
 * A reference is an identifier a customer reads down the phone. It is not a
 * credential, and the tests below are as much about that as about uniqueness.
 */
describe("job references", () => {
  test("they keep the format already printed on V1 confirmations", () => {
    // A second format would mean two things to recognise on the phone.
    const reference = generateJobReference();
    assert.match(reference, /^BSCJ-[0-9A-Z]{6}$/);
    assert.equal(REFERENCE_PREFIX, "BSCJ-");
  });

  test("they avoid the characters that get misheard or misread", () => {
    // No I, L, O or U: not confusable with 1 or 0, and no accidental words.
    const body = Array.from({ length: 300 }, () =>
      generateJobReference().slice(REFERENCE_PREFIX.length),
    ).join("");
    for (const banned of ["I", "L", "O", "U"]) {
      assert.equal(body.includes(banned), false, `${banned} appeared`);
    }
  });

  test("collisions are rare enough that the database index is a formality", () => {
    /*
      Not "never repeats" — that is a promise a six-character reference cannot
      keep, and asserting it made this test itself flaky. Across 20,000 draws
      from 32^6 the birthday bound expects about 0.19 duplicates, so a run that
      produced one was the design working, not failing.

      The guarantee lives in the `job_reference_key` unique index: the database
      refuses a duplicate and the caller draws again. What this checks is that
      the retry stays a formality rather than a workload — and, more usefully,
      that the generator is really drawing from the whole space. A biased one
      would collide orders of magnitude more often and would fail here loudly.
    */
    const SAMPLE = 20_000;
    const seen = new Set<string>();
    for (let index = 0; index < SAMPLE; index += 1) {
      seen.add(generateJobReference());
    }

    const duplicates = SAMPLE - seen.size;
    // Expected ≈ 0.19. Five is far enough out that a real bias fails here and
    // ordinary luck does not.
    assert.ok(
      duplicates <= 5,
      `${duplicates} duplicates in ${SAMPLE}: the space is smaller than it looks`,
    );
  });

  test("the retry contract is documented where the caller will look", () => {
    // Because the generator does not promise uniqueness, the thing that does
    // has to be findable from here.
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/jobs/reference.ts"),
      "utf8",
    );
    assert.match(source, /job_reference_key/);
    assert.match(source, /retries/);
  });

  test("the space is large enough for that to be unremarkable", () => {
    assert.equal(REFERENCE_SPACE, 32 ** 6);
    assert.ok(REFERENCE_SPACE > 1_000_000_000);
  });

  test("they are not sequential, so they reveal no business volume", () => {
    /*
      The point of randomness here: consecutive references must not let anyone
      infer how much work BSCJ is taking. Successive values should move in both
      directions rather than climb.
    */
    const references = Array.from({ length: 200 }, generateJobReference);
    let ascending = 0;
    for (let index = 1; index < references.length; index += 1) {
      if (references[index] > references[index - 1]) ascending += 1;
    }
    // A counter would give 199. Anything near half is noise, as it should be.
    assert.ok(
      ascending > 60 && ascending < 140,
      `suspiciously ordered: ${ascending}/199 ascending`,
    );
  });

  test("every character of the alphabet gets used", () => {
    // A biased generator would shrink the real space well below 32^6.
    const body = Array.from({ length: 2000 }, () =>
      generateJobReference().slice(REFERENCE_PREFIX.length),
    ).join("");
    const used = new Set(body);
    assert.equal(used.size, 32, `only ${used.size} characters ever appeared`);
  });

  test("the shape check accepts ours and rejects the rest", () => {
    assert.equal(isJobReference(generateJobReference()), true);
    for (const value of [
      "BSCJ-12345",
      "BSCJ-1234567",
      "bscj-ABC123",
      "ABC123",
      "BSCJ-ABCIII",
      "BSCJ-",
      "",
    ]) {
      assert.equal(isJobReference(value), false, value);
    }
  });

  test("what someone types or reads out is tidied before it is looked up", () => {
    const reference = generateJobReference();
    const body = reference.slice(REFERENCE_PREFIX.length);

    for (const typed of [
      reference,
      reference.toLowerCase(),
      ` ${reference} `,
      body,
      body.toLowerCase(),
      `BSCJ ${body}`,
      `bscj-${body.toLowerCase()}`,
    ]) {
      assert.equal(normaliseJobReference(typed), reference, typed);
    }
  });

  test("nonsense normalises to nothing, so no search runs on it", () => {
    for (const value of ["", "hello", "BSCJ", "12345", "BSCJ-!!!!!!"]) {
      assert.equal(normaliseJobReference(value), null, value);
    }
  });
});
