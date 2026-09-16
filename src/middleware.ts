import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * The gate on every private surface.
 *
 * Deliberately narrow. The matcher below covers the staff and agency areas and
 * nothing else, so no public page — and no customer booking — passes through
 * any of this. `/book`, the API routes the booking flow calls and every
 * marketing page are untouched. That is the single most important property of
 * this file: a mistake here must not be able to take the public site down.
 *
 * `/schedule` is deliberately absent. Tenant access is not a session cookie
 * this can look for — it is a token or a reference-and-postcode check, with
 * its own path-scoped cookie — so guarding it here would do nothing except
 * imply it was guarded.
 *
 * The check is a cheap presence test on the session cookie, not a verification
 * of it. Middleware runs on the edge, where the scrypt and database work a
 * real check needs is not available; its job is to keep unauthenticated
 * browsers off private pages and send them somewhere sensible.
 * **Authorisation is enforced again inside every private page and action**,
 * against a verified session, with the role and organisation re-read from the
 * database — see `lib/auth/session.ts`. A forged cookie gets past this line
 * and no further.
 */

/** Auth.js names the cookie differently once the connection is secure. */
const SESSION_COOKIES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];

/** Pages that must stay reachable, or there is no way in. */
const PUBLIC_PRIVATE_PATHS = ["/admin/login"];

function hasSessionCookie(request: NextRequest): boolean {
  return SESSION_COOKIES.some((name) => request.cookies.has(name));
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_PRIVATE_PATHS.includes(pathname)) {
    return NextResponse.next();
  }

  if (hasSessionCookie(request)) {
    return NextResponse.next();
  }

  /*
    An API route gets a status code; a page gets the login form. Redirecting a
    fetch would hand the caller an HTML login page with a 200 on it, which is
    the kind of thing that gets parsed as success.
  */
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const login = new URL("/admin/login", request.url);
  // Where they were heading, so signing in does not dump them on the dashboard.
  // Path and query only — never an absolute URL, which would make this an open
  // redirect.
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

/**
 * Every private prefix, and nothing else.
 *
 * The portal and engineer entries are here before those surfaces exist. A
 * matcher that is updated when a route group is created is a matcher somebody
 * eventually forgets; one that already covers the prefix means the first page
 * added under it is gated from its first commit.
 */
export const config = {
  matcher: [
    "/admin/:path*",
    "/api/admin/:path*",
    "/portal/:path*",
    "/api/portal/:path*",
    "/engineer/:path*",
    "/api/engineer/:path*",
  ],
};
