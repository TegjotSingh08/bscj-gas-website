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

/** The signed-in user, or null. */
export async function currentSession(): Promise<Session | null> {
  const token = await auth();
  const id = token?.user?.id;
  if (!id) return null;

  const user = await currentIdentity(id);
  if (!user) return null;

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

/** Where each role belongs when it arrives somewhere it does not. */
function signInPath(): string {
  return "/admin/login";
}

// ---------------------------------------------------------------------------
// Page guards — redirect, because a browser asked
// ---------------------------------------------------------------------------

/** The signed-in administrator, or the login page. */
export async function requireAdmin(): Promise<Session> {
  const session = await currentSession();
  if (!session) redirect(signInPath());
  if (session.user.role !== "admin") redirect(signInPath());
  return session;
}

/** The signed-in engineer or administrator, or the login page. */
export async function requireEngineer(): Promise<Session> {
  const session = await currentSession();
  if (!session) redirect(signInPath());
  // An administrator can work an engineer's screens; the reverse is not true.
  if (session.user.role !== "engineer" && session.user.role !== "admin") {
    redirect(signInPath());
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
  Session & { organisationId: string }
> {
  const session = await currentSession();
  if (!session) redirect(signInPath());
  if (!isAgentRole(session.user.role)) redirect(signInPath());

  const organisationId = session.user.agentOrganisationId;
  // `scopeFor` has already refused an agency user without one; this is the
  // type-level restatement of that, not a second check.
  if (!organisationId) redirect(signInPath());

  return { ...session, organisationId };
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
