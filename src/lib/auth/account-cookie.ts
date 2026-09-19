import "server-only";

import { ACCOUNT_COOKIE_MAX_AGE_SECONDS, ACCOUNT_COOKIE_PATH } from "./account-paths";
import {
  isCredentialPurpose,
  isWellFormedCredentialToken,
  type CredentialPurpose,
} from "./credential-token";

/**
 * Reading and writing the setup cookie.
 *
 * The value is `<purpose>.<token>` — the raw credential, and what it is for.
 *
 * **Why the raw token rather than a signed handle:** the credential is still
 * verified against the stored hash at redemption, so the database remains the
 * arbiter and a cookie somebody forges matches nothing. A signed handle naming
 * a credential id would make the cookie *itself* the credential, with the
 * database reduced to a lookup — strictly weaker, for no gain.
 *
 * It is httpOnly, secure in production, `SameSite=Lax` and scoped to
 * `/account`, so it is never presented to the portal, the admin area, the
 * consumer API or anything else, and no script on the page can read it.
 *
 * The purpose travels with the token because the hash is purpose-bound: a
 * value carrying the wrong one hashes to something that is not on file, which
 * is the point.
 */

export type AccountCookie = {
  purpose: CredentialPurpose;
  token: string;
};

export function encodeAccountCookie(
  purpose: CredentialPurpose,
  token: string,
): string {
  return `${purpose}.${token}`;
}

/** The credential, or null. Null for every kind of malformed value. */
export function decodeAccountCookie(
  value: string | undefined,
): AccountCookie | null {
  if (!value) return null;

  const separator = value.indexOf(".");
  if (separator < 0) return null;

  const purpose = value.slice(0, separator);
  const token = value.slice(separator + 1);

  // Shape-checked on the way out as well as in. A cookie is something the
  // browser states, never something it proves.
  if (!isCredentialPurpose(purpose)) return null;
  if (!isWellFormedCredentialToken(token)) return null;

  return { purpose, token };
}

/** The attributes the cookie is set with. One place, so none is forgotten. */
export function accountCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Secure in production; a local http dev server would drop it otherwise.
    secure: process.env.NODE_ENV === "production",
    path: ACCOUNT_COOKIE_PATH,
    maxAge: ACCOUNT_COOKIE_MAX_AGE_SECONDS,
  };
}

/** The attributes that clear it. `maxAge: 0` and the same path, or it lingers. */
export function clearedAccountCookieOptions() {
  return { ...accountCookieOptions(), maxAge: 0 };
}
