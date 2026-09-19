/**
 * Where the account-setup flow lives, and what the browser carries through it.
 *
 * Separate from the server modules because a client component needs these too
 * and cannot import a `server-only` file. Nothing here is a secret — a path is
 * public by construction — and nothing here is an authorisation.
 */

/**
 * The cookie that carries a credential from the link to the form.
 *
 * **The token is never in a rendered URL.** It arrives once, in the path of a
 * Route Handler, which reads it and immediately redirects to a clean address
 * with the value in an httpOnly cookie instead. A URL ends up in browser
 * history, in a `Referer` header sent to whatever the page loads, in a shared
 * screenshot and in somebody's proxy log; a cookie scoped to `/account` ends
 * up in none of those and expires on its own.
 *
 * This is the same reasoning that moved the tenant scheduling flow off a
 * token-in-the-URL, and the same shape of fix.
 */
export const ACCOUNT_COOKIE = "bscj-account-setup";

/** The path the cookie is scoped to. Nothing outside it ever sees the value. */
export const ACCOUNT_COOKIE_PATH = "/account";

/** Where the form lives. Inside the cookie path, or the browser would not send it. */
export const SET_PASSWORD_PATH = "/account/set-password";

/** Where somebody lands when the link is no good. Says nothing about why. */
export const PROBLEM_PATH = "/account/link-problem";

/** Where somebody lands once the password is set. */
export const DONE_PATH = "/account/done";

/** The public "email me a reset link" form. */
export const FORGOT_PATH = "/account/forgot";

/**
 * How long the cookie lasts.
 *
 * Long enough to read the page, find a password manager and type something
 * twice; short enough that a shared machine does not leave a working setup
 * link behind. The credential's own expiry still applies and is usually the
 * shorter of the two for a reset.
 */
export const ACCOUNT_COOKIE_MAX_AGE_SECONDS = 30 * 60;
