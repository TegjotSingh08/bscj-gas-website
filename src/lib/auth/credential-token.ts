import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Account credentials: the token in an invitation link, and the one in a
 * password reset.
 *
 * Shaped after `lib/scheduling/token.ts` — 32 bytes of CSPRNG output, only the
 * hash stored, the stored form self-describing so the algorithm can be rotated
 * without invalidating links already sent — and deliberately **not the same
 * module**, for three reasons:
 *
 * - **A tenant's scheduling token is reusable on purpose.** They may open the
 *   link, close it, and come back. A credential that sets a password must be
 *   the opposite: spent exactly once. Sharing a module invites sharing the
 *   store, and then one `used_at` column carries two opposite rules.
 * - **Separate key material.** The pepper here is derived from `AUTH_SECRET`
 *   under its own label, so a scheduling token and an account credential
 *   cannot hash to one another even if both stores were confused.
 * - **The purpose is inside the hash.** An invitation and a reset are
 *   different credentials, not one credential with a flag. A reset token
 *   presented at the invitation door hashes to something that is not on file,
 *   so the separation holds even if a `WHERE` clause is one day forgotten.
 *
 * **Fails closed.** Without `AUTH_SECRET` nothing can be minted or verified.
 * The scheduling module has a plain-SHA-256 fallback because refusing to
 * create a *job* over an optional secret would be the worse failure; there is
 * no equivalent argument for refusing to issue an invitation, and `AUTH_SECRET`
 * is required for the application to sign a session at all.
 *
 * Pure except for reading the environment. No database, no framework.
 */

/** 32 bytes of CSPRNG output. The only form a person ever sees. */
const TOKEN_BYTES = 32;

/** Domain separation, so this key is neither Auth.js's nor scheduling's. */
const LABEL = "bscj:account-credential:v1";

export const CREDENTIAL_PURPOSES = ["invitation", "password_reset"] as const;
export type CredentialPurpose = (typeof CREDENTIAL_PURPOSES)[number];

export function isCredentialPurpose(value: unknown): value is CredentialPurpose {
  return (
    typeof value === "string" &&
    (CREDENTIAL_PURPOSES as readonly string[]).includes(value)
  );
}

/**
 * How long each kind of credential lives.
 *
 * An invitation gets a fortnight: BSCJ opens an account after a phone call,
 * and the person who has to act on it may be away. A reset gets an hour —
 * somebody asked for it just now and is sitting at the form, and a reset link
 * that lingers in an inbox for a week is a spare key.
 */
export const CREDENTIAL_LIFETIME_HOURS: Record<CredentialPurpose, number> = {
  invitation: 14 * 24,
  password_reset: 1,
};

export class CredentialSecretMissingError extends Error {
  constructor() {
    super("AUTH_SECRET is not set, so account credentials cannot be issued.");
    this.name = "CredentialSecretMissingError";
  }
}

function key(): string {
  const secret = process.env.AUTH_SECRET;
  // Fail closed. An unpeppered credential is not a weaker credential; it is a
  // different scheme, silently, and nobody would notice which one was running.
  if (!secret) throw new CredentialSecretMissingError();
  return `${LABEL}:${secret}`;
}

/**
 * The stored form: `hmac$<hex digest>` over `<purpose>:<token>`.
 *
 * The purpose is inside the digest rather than beside it, so the same random
 * 32 bytes produce two unrelated hashes depending on what they are for.
 */
export function hashCredentialToken(
  token: string,
  purpose: CredentialPurpose,
): string {
  const digest = createHmac("sha256", key())
    .update(`${purpose}:${token}`)
    .digest("hex");
  return `hmac$${digest}`;
}

/**
 * Whether a token matches a stored hash, in constant time.
 *
 * Re-hashes with the algorithm the stored value names, so introducing a second
 * one later does not break links already sent. Returns false — never throws —
 * for a malformed hash, an unknown algorithm or a missing secret, because the
 * caller has nothing useful to do with the difference and a prober would.
 */
export function credentialTokenMatches(
  token: string,
  purpose: CredentialPurpose,
  storedHash: string,
): boolean {
  try {
    const [algorithm] = storedHash.split("$");
    if (algorithm !== "hmac") return false;

    const candidate = hashCredentialToken(token, purpose);
    const left = Buffer.from(candidate, "utf8");
    const right = Buffer.from(storedHash, "utf8");
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/** Whether a value could have come from us. Cheap, before any store lookup. */
export function isWellFormedCredentialToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export type MintedCredential = {
  /** Give this to exactly one caller. Never stored, never logged. */
  token: string;
  /** Store this. */
  tokenHash: string;
  purpose: CredentialPurpose;
  expiresAt: Date;
};

/**
 * Mints a credential.
 *
 * The plain value is returned once and is expected to travel straight into an
 * email. Nothing in this module writes it anywhere, and nothing anywhere logs
 * it — see `redactToken` for the only form that may appear in a message.
 */
export function createCredentialToken(
  purpose: CredentialPurpose,
  now = new Date(),
): MintedCredential {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const expiresAt = new Date(
    now.getTime() + CREDENTIAL_LIFETIME_HOURS[purpose] * 60 * 60 * 1000,
  );
  return {
    token,
    tokenHash: hashCredentialToken(token, purpose),
    expiresAt,
    purpose,
  };
}

/**
 * What may appear in a log line about a token: that there was one.
 *
 * Not a prefix, not a suffix, not a truncation. A 64-character hex string with
 * eight characters shown is still a meaningful head start, and there is no
 * question an operator answers with "it began with 3f" that they cannot
 * answer from the credential's row instead.
 */
export function redactToken(): string {
  return "<token>";
}
