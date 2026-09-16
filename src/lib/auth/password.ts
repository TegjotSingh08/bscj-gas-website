import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Admin password hashing.
 *
 * scrypt from Node's own crypto, rather than a dependency. Argon2id would be
 * the marginally stronger choice, but every JavaScript implementation of it is
 * either a native module — which is a build liability on a serverless host —
 * or slow enough to be tuned down until it is no longer stronger. scrypt is
 * memory-hard, ships with the runtime, and is what the rest of this codebase
 * would reach for: `holds.ts` and `daily-limit.ts` already use `node:crypto`
 * for exactly this reason.
 *
 * Parameters follow the current OWASP guidance for scrypt (N=2^17, r=8, p=1),
 * which costs roughly 128 MB and a fraction of a second per verification. That
 * is deliberate: this runs on a login form for a handful of people, so it can
 * afford to be slow, and being slow is the point.
 *
 * The stored format carries its own parameters, so raising them later does not
 * invalidate existing hashes — an old hash keeps verifying with the cost it
 * was made at, and can be re-hashed on next login.
 */

/**
 * `promisify` picks the overload without options, so the cost parameters would
 * be silently dropped. Wrapped by hand instead, keeping them in the signature.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

const COST = 2 ** 17;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** scrypt needs headroom above 128 * N * r bytes, or it refuses outright. */
const MAX_MEMORY = 256 * COST * BLOCK_SIZE;

const FORMAT = "scrypt";

/** Rejects what a hash function should never be asked to stretch. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Use no more than ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: MAX_MEMORY,
  });
}

/** "scrypt$N$r$p$salt$hash", all base64url. Self-describing on purpose. */
export async function hashPassword(password: string): Promise<string> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt);

  return [
    FORMAT,
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/**
 * Verifies a password against a stored hash.
 *
 * Never throws and never distinguishes *why* it failed: a malformed hash, an
 * unknown format and a wrong password all return false, because the caller has
 * nothing useful to do with the difference and an attacker would.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    const [format, cost, blockSize, parallelism, salt, expected] =
      stored.split("$");
    if (format !== FORMAT) return false;

    const saltBytes = Buffer.from(salt, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (saltBytes.length === 0 || expectedBytes.length === 0) return false;

    const actual = await scryptAsync(
      password.normalize("NFKC"),
      saltBytes,
      expectedBytes.length,
      {
        N: Number(cost),
        r: Number(blockSize),
        p: Number(parallelism),
        maxmem: MAX_MEMORY,
      },
    );

    if (actual.length !== expectedBytes.length) return false;
    return timingSafeEqual(actual, expectedBytes);
  } catch {
    return false;
  }
}
