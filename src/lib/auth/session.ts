import "server-only";

import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { currentIdentity, type UserIdentity } from "./app-user";
import { assertCan, isAgentRole, type Capability } from "./roles";
import { scopeFor, type AccessScope } from "./scope";

/**
 * The real authorisation check.
 *
 * `middleware.ts` only looks for a cookie; this verifies the session itself,
 * and every private page, server action and route handler must call one of
 * these. Doing the work here rather than in middleware is deliberate — the
 * verified check belongs next to the data it protects, so a new page cannot
 * accidentally be public by being missed from a matcher.
 *
 * **The role and the organisation come from the database, not from the
 * token.** The session identifies *who* is calling; what they are allowed to
 * be is re-read every request. That is what makes deactivating an account, or
 * moving a user between organisations, take effect immediately rather than
 * whenever their eight-hour token happens to expire.
 */

export type Session = {
  user: UserIdentity;
  /** Built from the freshly-read user, never from the token. */
  scope: AccessScope;
};

/**
 * The signed-in user, or null.
 *
 * Two things have to hold, and the second is what a JWT session otherwise
 * cannot express:
 *
 * 1. The user still exists and is still allowed in — re-read every request,
 *    so a suspension takes effect immediately.
 * 2. **The token was issued since the account's last session reset.** Sessions
 *    are stateless, so there is no row to delete when a password changes;
 *    instead every token carries the `session_version` it was signed under,
 *    and a version behind the column is refused here. That is the smallest
 *    mechanism that makes "resetting my password signs out the person reading
 *    my email" true, and it costs nothing — the row is already being read.
 *
 * A token from before the field existed reads as 0, which matches the column
 * default, so deploying this does not sign everybody out.
 */
export async function currentSession(): Promise<Session | null> {
  const token = await auth();
  const id = token?.user?.id;
  if (!id) return null;

  const user = await currentIdentity(id);
  if (!user) return null;

  const issuedUnder = token.user?.sessionVersion ?? 0;
  /*
    Any mismatch, not just a token that is behind. A token claiming a version
    *ahead* of the column is not a newer session — nothing issues one — so it
    is a forged or replayed value and is refused by the same comparison rather
    than trusted for being larger.
  */
  if (issuedUnder !== user.sessionVersion) return null;

  return { user, scope: scopeFor(user) };
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not signed in.");
    this.name = "NotAuthenticatedError";
  }
}

export class WrongAudienceError extends Error {
  constructor() {
    // Never says which surface the caller does belong to. A signed-in agency
    // user probing /admin should learn nothing from the reply.
    super("Not found.");
    this.name = "WrongAudienceError";
  }
}

/**
 * Where to send someone who is not signed in.
 *
 * Two doors to one lock. BSCJ staff and agency users are the same `app_user`
 * rows checked by the same credential path, but an agency arriving at a page
 * headed "BSCJ Admin" would reasonably think they were in the wrong place —
 * so each audience gets its own branded sign-in and its own return path.
 */
const ADMIN_SIGN_IN = "/admin/login";
const PORTAL_SIGN_IN = "/portal/login";

// ---------------------------------------------------------------------------
// Page guards — redirect, because a browser asked
// ---------------------------------------------------------------------------

/** The signed-in administrator, or the login page. */
export async function requireAdmin(): Promise<Session> {
  const session = await currentSession();
  if (!session) redirect(ADMIN_SIGN_IN);
  if (session.user.role !== "admin") redirect(ADMIN_SIGN_IN);
  return session;
}

/** The signed-in engineer or administrator, or the login page. */
export async function requireEngineer(): Promise<Session> {
  const session = await currentSession();
  if (!session) redirect(ADMIN_SIGN_IN);
  // An administrator can work an engineer's screens; the reverse is not true.
  if (session.user.role !== "engineer" && session.user.role !== "admin") {
    redirect(ADMIN_SIGN_IN);
  }
  return session;
}

/**
 * The signed-in agency user, or the login page.
 *
 * Returns the organisation id as a separate field so a caller cannot forget
 * that it is nullable on the user record — here, it is not.
 */
export async function requireAgent(): Promise<
  Session & { organisationId: string; organisationName: string }
> {
  const session = await currentSession();
  if (!session) redirect(PORTAL_SIGN_IN);
  /*
    An administrator arriving at the portal is sent to the portal sign-in
    rather than shown an agency's data. There is no "view as" yet, and
    inventing one by letting staff through a scope check they do not satisfy
    would be the wrong way to build it — see V2.8.
  */
  if (!isAgentRole(session.user.role)) redirect(PORTAL_SIGN_IN);

  const organisationId = session.user.agentOrganisationId;
  /*
    `currentIdentity` has already refused an agency user with no organisation,
    and one whose organisation is deactivated. This is the type-level
    restatement of that, not a second check.
  */
  if (!organisationId) redirect(PORTAL_SIGN_IN);

  return {
    ...session,
    organisationId,
    organisationName: session.user.organisationName ?? "",
  };
}

// ---------------------------------------------------------------------------
// Action and route-handler guards — throw, because a redirect is the wrong
// shape of answer for a fetch
// ---------------------------------------------------------------------------

export async function requireSessionOrThrow(): Promise<Session> {
  const session = await currentSession();
  if (!session) throw new NotAuthenticatedError();
  return session;
}

export async function requireAdminOrThrow(): Promise<Session> {
  const session = await requireSessionOrThrow();
  if (session.user.role !== "admin") throw new WrongAudienceError();
  return session;
}

export async function requireAgentOrThrow(): Promise<
  Session & { organisationId: string }
> {
  const session = await requireSessionOrThrow();
  if (!isAgentRole(session.user.role)) throw new WrongAudienceError();

  const organisationId = session.user.agentOrganisationId;
  if (!organisationId) throw new WrongAudienceError();

  return { ...session, organisationId };
}

export async function requireEngineerOrThrow(): Promise<Session> {
  const session = await requireSessionOrThrow();
  if (session.user.role !== "engineer" && session.user.role !== "admin") {
    throw new WrongAudienceError();
  }
  return session;
}

/**
 * Asserts a capability on an existing session.
 *
 * The audience guards above answer "are you the right kind of user for this
 * surface". This answers "may you take this action", and both are needed: an
 * `agent_member` legitimately reaches the portal and still may not add a
 * colleague.
 */
export function requireCapability(
  session: Session,
  capability: Capability,
): void {
  assertCan(session.user.role, capability);
}
