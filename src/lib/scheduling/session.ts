import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { SCHEDULING_COOKIE_PATH } from "./paths";
import { normaliseJobReference } from "@/lib/jobs/reference";

/**
 * The tenant's scheduling session.
 *
 * A tenant has no account, so there is nothing for Auth.js to hold. After a
 * token or a reference-and-postcode check succeeds, the server issues this: a
 * signed value naming **one job** and nothing else.
 *
 * Three properties matter, and each is a deliberate choice:
 *
 * - **It names one job.** There is no tenant identity to escalate and no list
 *   to page through. Changing the job id in the cookie breaks the signature.
 * - **It is path-scoped to `/schedule`.** The browser never presents it to the
 *   portal, the admin area or the consumer API, so it cannot be mistaken for
 *   an agency session by anything downstream. Every endpoint that reads it
 *   must therefore *live under that path* — see `SCHEDULING_CONFIRM_PATH` and
 *   `isWithinSchedulingCookiePath`, which exist because a confirmation
 *   endpoint at `/api/schedule/confirm` was never sent the cookie at all and
 *   so refused every real tenant.
 * - **It carries no token material.** The scheduling token is spent at the
 *   door; the cookie that replaces it would be useless to an attacker who
 *   obtained a later request's headers without also having the signing key.
 *
 * Signed with a key derived from `AUTH_SECRET` under its own label, so this
 * cookie and an Auth.js session cannot be substituted for one another even
 * though both ultimately trust the same secret.
 */

export {
  SCHEDULING_COOKIE,
  SCHEDULING_COOKIE_PATH,
  SCHEDULING_CONFIRM_PATH,
  SCHEDULING_PREFILL_COOKIE,
  isWithinSchedulingCookiePath,
} from "./paths";

/** Long enough to choose a time without rushing; short enough to matter. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60;

/** Domain separation, so this key is not the Auth.js key. */
const LABEL = "bscj:scheduling-session:v1";

export class SchedulingSecretMissingError extends Error {
  constructor() {
    super("AUTH_SECRET is not set, so a scheduling session cannot be signed.");
    this.name = "SchedulingSecretMissingError";
  }
}

function signingKey(): string {
  const secret = process.env.AUTH_SECRET;
  // Fail closed. An unsigned session is not a weaker session, it is no session.
  if (!secret) throw new SchedulingSecretMissingError();
  return `${LABEL}:${secret}`;
}

export type SchedulingSession = { jobId: string; expiresAt: number };

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

/** `<jobId>.<expiry>.<signature>`. Opaque to the browser, readable by us. */
export function issueSchedulingSession(
  jobId: string,
  now = new Date(),
): { value: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000);
  const payload = `${jobId}.${expiresAt.getTime()}`;
  return { value: `${payload}.${sign(payload)}`, expiresAt };
}

/**
 * Reads a session, or returns null.
 *
 * Null for every kind of failure — malformed, wrong signature, expired — so a
 * caller cannot tell them apart and neither can anyone probing.
 */
export function readSchedulingSession(
  value: string | undefined,
  now = new Date(),
): SchedulingSession | null {
  if (!value) return null;

  const parts = value.split(".");
  if (parts.length !== 3) return null;

  const [jobId, expiry, signature] = parts;
  const payload = `${jobId}.${expiry}`;

  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    // No secret configured. Refusing is the only safe answer.
    return null;
  }

  const left = Buffer.from(signature, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return null;
  if (!timingSafeEqual(left, right)) return null;

  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return null;

  return { jobId, expiresAt };
}

/** The attributes the cookie is set with. One place, so none is forgotten. */
export function schedulingCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Secure in production; a local http dev server would drop it otherwise.
    secure: process.env.NODE_ENV === "production",
    path: SCHEDULING_COOKIE_PATH,
    expires: expiresAt,
  };
}

// ---------------------------------------------------------------------------
// The invitation prefill
// ---------------------------------------------------------------------------

/**
 * Long enough to finish typing a postcode, short enough to be worthless later.
 *
 * A prefill is a convenience, not a credential, so it does not need the hour a
 * real session gets.
 */
export const PREFILL_MAX_AGE_SECONDS = 30 * 60;

/** Its own label, so a prefill can never be read as a session. */
const PREFILL_LABEL = "bscj:scheduling-prefill:v1";

function prefillKey(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new SchedulingSecretMissingError();
  return `${PREFILL_LABEL}:${secret}`;
}

/**
 * `<reference>.<expiry>.<signature>`.
 *
 * What an invitation link hands to the entry form. It opens nothing: the form
 * still asks for the postcode, and `accessByReference` still decides.
 */
export function issueSchedulingPrefill(
  reference: string,
  now = new Date(),
): { value: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + PREFILL_MAX_AGE_SECONDS * 1000);
  const payload = `${reference}.${expiresAt.getTime()}`;
  const signature = createHmac("sha256", prefillKey())
    .update(payload)
    .digest("base64url");
  return { value: `${payload}.${signature}`, expiresAt };
}

/** The reference, or null. Null for every kind of failure, as ever. */
export function readSchedulingPrefill(
  value: string | undefined,
  now = new Date(),
): string | null {
  if (!value) return null;

  const parts = value.split(".");
  if (parts.length !== 3) return null;

  const [reference, expiry, signature] = parts;
  const payload = `${reference}.${expiry}`;

  let expected: string;
  try {
    expected = createHmac("sha256", prefillKey())
      .update(payload)
      .digest("base64url");
  } catch {
    return null;
  }

  const left = Buffer.from(signature, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return null;
  if (!timingSafeEqual(left, right)) return null;

  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return null;

  // Shape-checked on the way out too: a signed value is still only as good as
  // what was signed, and nothing but a well-formed reference belongs in a form.
  return normaliseJobReference(reference);
}

/** The attributes the prefill cookie is set with. */
export function schedulingPrefillCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: SCHEDULING_COOKIE_PATH,
    expires: expiresAt,
  };
}
