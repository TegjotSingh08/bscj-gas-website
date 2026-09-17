import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Tenant scheduling tokens.
 *
 * A token is the thing in the link a tenant is sent. It is generated here,
 * handed to the caller **once**, and only its hash is ever stored — the same
 * discipline the 30-minute slot holds already use. A leaked database row must
 * not become a working link.
 *
 * The stored form is **self-describing**, like the password hashes: it carries
 * the algorithm that produced it, so a pepper can be introduced or rotated
 * later without invalidating tokens already in tenants' inboxes.
 *
 * Two algorithms:
 *
 * - `hmac` — HMAC-SHA-256 under `SCHEDULING_TOKEN_SECRET`. Used whenever the
 *   secret is configured, and what production should run.
 * - `sha256` — plain SHA-256, used when it is not.
 *
 * The fallback is deliberate rather than a lapse. A pepper is load-bearing for
 * a *low-entropy* secret, where an attacker with the database could brute-force
 * the input; these tokens are 32 bytes of CSPRNG output, so the hash is already
 * irreversible and the pepper is defence in depth. Refusing to create a job
 * because an optional secret is unset would be the worse failure. Verification
 * tries the algorithm the row names, so both kinds keep working.
 *
 * Pure except for reading the environment. No database, no framework.
 */

/** 32 bytes of CSPRNG output. The only form the tenant ever sees. */
const TOKEN_BYTES = 32;

/** How long an invitation stays usable. Tuned when outreach lands in V2.3. */
export const TOKEN_LIFETIME_DAYS = 90;

export type SchedulingToken = {
  /** Give this to the tenant. Never stored, never logged. */
  token: string;
  /** Store this. */
  tokenHash: string;
  expiresAt: Date;
};

function pepper(): string | null {
  const secret = process.env.SCHEDULING_TOKEN_SECRET;
  return secret && secret.length > 0 ? secret : null;
}

/** The stored form: `<algorithm>$<hex digest>`. */
export function hashToken(token: string): string {
  const secret = pepper();
  return secret
    ? `hmac$${createHmac("sha256", secret).update(token).digest("hex")}`
    : `sha256$${createHash("sha256").update(token).digest("hex")}`;
}

/**
 * Verifies a token against a stored hash.
 *
 * Re-hashes with **the algorithm the stored value names**, not with whatever
 * is configured now — that is what lets a pepper be introduced without
 * breaking links already sent. Compared in constant time, so a hash cannot be
 * probed byte by byte.
 */
export function tokenMatches(token: string, storedHash: string): boolean {
  const [algorithm] = storedHash.split("$");
  const secret = pepper();

  let candidate: string;
  if (algorithm === "hmac") {
    if (!secret) return false;
    candidate = `hmac$${createHmac("sha256", secret).update(token).digest("hex")}`;
  } else if (algorithm === "sha256") {
    candidate = `sha256$${createHash("sha256").update(token).digest("hex")}`;
  } else {
    return false;
  }

  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(storedHash, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Whether a value could have come from us. Cheap, before any store lookup. */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Mints a token.
 *
 * The plain value is returned to exactly one caller and is expected to travel
 * straight into an invitation. Nothing in this module writes it anywhere.
 */
export function createSchedulingToken(now = new Date()): SchedulingToken {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const expiresAt = new Date(
    now.getTime() + TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
  );
  return { token, tokenHash: hashToken(token), expiresAt };
}
