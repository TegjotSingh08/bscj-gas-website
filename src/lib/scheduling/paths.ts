/**
 * Where the tenant's session lives, and what is inside that fence.
 *
 * Separate from `session.ts` because the browser needs these too: the picker
 * has to post to the confirmation endpoint, and a client component cannot
 * import a `server-only` module. Nothing here is a secret — a path is public
 * by construction — and nothing here is an authorisation. The signing, the
 * verification and the key all stay in `session.ts`.
 */

export const SCHEDULING_COOKIE = "bscj-schedule";

/**
 * The reference an invitation link brought with it.
 *
 * Deliberately **not** a session. It carries one thing — a job reference — and
 * a reference identifies without authorising: it is six readable characters
 * designed to be quoted down the phone. Holding one lets the entry form fill
 * itself in; it does not open a job, and the postcode is still required.
 *
 * Signed anyway, so a tenant cannot type somebody else's reference into their
 * own cookie and have the form treat it as arriving from a real invitation —
 * not that it would help them, since the postcode check is what decides.
 */
export const SCHEDULING_PREFILL_COOKIE = "bscj-schedule-ref";

/** The path the cookie is scoped to. Nothing outside it ever sees the value. */
export const SCHEDULING_COOKIE_PATH = "/schedule";

/**
 * Where the tenant's browser posts a confirmation.
 *
 * Under the cookie path, and that is the whole point. The path scope is a
 * containment decision — it keeps the value away from the portal, the admin
 * area and the consumer API — but containment only works if what needs the
 * cookie sits inside the fence. The endpoint used to be at
 * `/api/schedule/confirm`, which does not match `/schedule`, so the browser
 * never sent the cookie and every genuine tenant confirmation was refused.
 *
 * It is *not* an authorisation check: the handler still verifies the signature
 * and the origin, because a path is something a request states rather than
 * something it proves.
 */
export const SCHEDULING_CONFIRM_PATH = "/schedule/api/confirm";

/**
 * Whether the browser would attach the scheduling cookie to this path.
 *
 * RFC 6265 §5.1.4 exactly: equal, or a prefix ending at a `/` boundary. So
 * `/schedule/api/confirm` matches and `/schedule-other` does not. Written out
 * rather than assumed so a test can hold an endpoint to it — the defect this
 * replaces was invisible to every unit test in the suite and obvious to the
 * first browser that tried.
 */
export function isWithinSchedulingCookiePath(pathname: string): boolean {
  if (pathname === SCHEDULING_COOKIE_PATH) return true;
  return pathname.startsWith(`${SCHEDULING_COOKIE_PATH}/`);
}
