import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  verifyPassword,
} from "./password";

/**
 * Admin password storage.
 *
 * Deliberately few hashes: each one costs about a quarter of a second by
 * design, and that cost is the security property. The tests are chosen to
 * cover the properties that matter rather than to exercise it repeatedly.
 */
const PASSWORD = "correct horse battery staple";

describe("password hashing", () => {
  test("a hash carries its own parameters, so they can be raised later", async () => {
    // An old hash keeps verifying at the cost it was made at.
    const hash = await hashPassword(PASSWORD);
    const [format, cost, blockSize, parallelism, salt, key] = hash.split("$");

    assert.equal(format, "scrypt");
    assert.equal(Number(cost), 2 ** 17);
    assert.equal(Number(blockSize), 8);
    assert.equal(Number(parallelism), 1);
    assert.ok(salt.length > 0);
    assert.ok(key.length > 0);
  });

  test("the same password hashes differently every time", async () => {
    // Per-user salt: two administrators choosing the same password must not
    // be visible as such in the table.
    const [first, second] = await Promise.all([
      hashPassword(PASSWORD),
      hashPassword(PASSWORD),
    ]);
    assert.notEqual(first, second);
  });

  test("the right password verifies and a wrong one does not", async () => {
    const hash = await hashPassword(PASSWORD);

    assert.equal(await verifyPassword(PASSWORD, hash), true);
    assert.equal(await verifyPassword(`${PASSWORD} `, hash), false);
    assert.equal(await verifyPassword(PASSWORD.toUpperCase(), hash), false);
    assert.equal(await verifyPassword("", hash), false);
  });

  test("verification never throws, whatever it is handed", async () => {
    // A malformed row must fail closed, not crash the login route.
    for (const stored of [
      "",
      "not-a-hash",
      "scrypt$",
      "scrypt$a$b$c$d$e",
      "bcrypt$131072$8$1$AAAA$BBBB",
      "$$$$$",
    ]) {
      assert.equal(await verifyPassword(PASSWORD, stored), false, stored);
    }
  });

  test("an unknown algorithm is refused rather than guessed at", async () => {
    const hash = await hashPassword(PASSWORD);
    const foreign = hash.replace(/^scrypt/, "argon2id");
    assert.equal(await verifyPassword(PASSWORD, foreign), false);
  });
});

describe("what may be used as a password", () => {
  test("short passwords are refused before they are hashed", () => {
    assert.ok(passwordProblem("x".repeat(MIN_PASSWORD_LENGTH - 1)));
    assert.equal(passwordProblem("x".repeat(MIN_PASSWORD_LENGTH)), null);
  });

  test("absurdly long ones are refused too", () => {
    // A hash function should not be a way to spend the server's memory.
    assert.equal(passwordProblem("x".repeat(MAX_PASSWORD_LENGTH)), null);
    assert.ok(passwordProblem("x".repeat(MAX_PASSWORD_LENGTH + 1)));
  });

  test("hashing refuses what validation refuses", async () => {
    await assert.rejects(() => hashPassword("short"));
  });

  test("the minimum is a real minimum", () => {
    assert.ok(MIN_PASSWORD_LENGTH >= 12);
  });
});
