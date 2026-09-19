/**
 * Is this request really from our own page?
 *
 * The tenant's session is a cookie, and a cookie is attached by the browser
 * whoever caused the request. `SameSite=Lax` already refuses to send it on a
 * cross-site POST, so this is a second lock rather than the first — but it is
 * the lock that is actually *written down*. Relying on a cookie attribute
 * alone means the protection disappears silently the day somebody changes the
 * attribute, and nothing in the handler would look any different.
 *
 * Deliberately narrow: same-origin or nothing. There is no cross-origin caller
 * for a tenant confirmation, so there is no allow-list to keep correct and no
 * wildcard to get wrong.
 *
 * Server Actions get an equivalent check from Next itself. A Route Handler
 * gets nothing by default, which is why this exists.
 */

export type OriginCheck =
  | { ok: true }
  /** Never says which part failed. A probe learns nothing from the reply. */
  | { ok: false };

/**
 * The host this request was actually addressed to.
 *
 * `x-forwarded-host` first, because behind a proxy the `Host` header is the
 * internal one and comparing an origin against it would refuse every real
 * request. Both are caller-supplied; neither is trusted for anything except
 * being compared with the origin, which is the only use that does not need
 * them to be true — a forged pair that agrees with itself proves nothing and
 * gains nothing, because the cookie still has to be valid.
 */
function addressedHost(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-host");
  if (forwarded) return forwarded.split(",")[0]!.trim().toLowerCase();

  const host = request.headers.get("host");
  return host ? host.trim().toLowerCase() : null;
}

export function checkSameOrigin(request: Request): OriginCheck {
  const origin = request.headers.get("origin");

  /*
    A browser sends `Origin` on every POST, same-origin included. Its absence
    means the caller is not a browser doing what our page does, so it is
    refused rather than waved through — the opposite default would make the
    check trivially avoidable by omitting one header.
  */
  if (!origin) return { ok: false };

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    // `Origin: null` — a sandboxed frame or an opaque origin. Not our page.
    return { ok: false };
  }

  const host = addressedHost(request);
  if (!host) return { ok: false };

  return originHost === host ? { ok: true } : { ok: false };
}
