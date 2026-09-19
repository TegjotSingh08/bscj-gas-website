/**
 * Which rows a user may see.
 *
 * `roles.ts` answers "may this kind of user do this kind of thing". This
 * answers "is this particular row theirs". Both are required, and the second
 * is the one that keeps two letting agencies apart.
 *
 * **The organisation is never taken from a session token.** A JWT is signed,
 * not authoritative about a value the application can change: deactivating an
 * account or moving a user between organisations must take effect at once, and
 * a token issued eight hours ago would not know. So `session.ts` re-reads the
 * user row on every request and builds the scope from *that*, and this module
 * only ever sees the result.
 *
 * Pure, except for the Drizzle condition helper at the end.
 */

import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { isAgentRole, type AppRole } from "./roles";

/**
 * What a caller is allowed to reach.
 *
 * Three shapes, because there are genuinely three answers:
 *
 * - **`all`** — BSCJ admin. Every row, including consumer work that belongs to
 *   no organisation.
 * - **`organisation`** — an agency user. Exactly one organisation's rows.
 * - **`assigned`** — an engineer. Not an organisation at all: the jobs
 *   allocated to them, wherever those come from. Modelling an engineer as an
 *   organisation-less admin would give them everyone's data.
 */
export type AccessScope =
  | { kind: "all" }
  | { kind: "organisation"; organisationId: string }
  | { kind: "assigned"; userId: string };

/** Enough about a signed-in user to decide what they can reach. */
export type ScopedUser = {
  id: string;
  role: AppRole;
  /** As read from the database this request, never from a token. */
  agentOrganisationId: string | null;
};

export class MissingOrganisationError extends Error {
  constructor(userId: string) {
    super(`Agency user ${userId} has no organisation.`);
    this.name = "MissingOrganisationError";
  }
}

/**
 * Builds the scope for a user.
 *
 * An agency user with no organisation is a data fault, not a user with wide
 * access: throwing is the only safe reading, because the alternatives are
 * "sees nothing" (a silent outage) or "sees everything" (a breach).
 */
export function scopeFor(user: ScopedUser): AccessScope {
  if (user.role === "admin") return { kind: "all" };
  if (user.role === "engineer") return { kind: "assigned", userId: user.id };

  if (isAgentRole(user.role)) {
    if (!user.agentOrganisationId) throw new MissingOrganisationError(user.id);
    return { kind: "organisation", organisationId: user.agentOrganisationId };
  }

  throw new MissingOrganisationError(user.id);
}

/**
 * Whether a scope reaches a particular organisation's rows.
 *
 * `null` is consumer work — a booking taken on the public site, belonging to
 * no agency. Only an admin may see it. An agency asking for "the row with no
 * organisation" must be refused, or the null case becomes a shared pool.
 */
export function canAccessOrganisation(
  scope: AccessScope,
  organisationId: string | null,
): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "organisation":
      return organisationId !== null && organisationId === scope.organisationId;
    case "assigned":
      // An engineer's access is decided by assignment, never by organisation.
      return false;
  }
}

export class OutOfScopeError extends Error {
  constructor() {
    // Says nothing about whether the row exists. A message that distinguishes
    // "not yours" from "not there" turns an id into a probe.
    super("Not found.");
    this.name = "OutOfScopeError";
  }
}

/** Asserts that a row belongs to the caller, before it is read or written. */
export function assertOrganisationAccess(
  scope: AccessScope,
  organisationId: string | null,
): void {
  if (!canAccessOrganisation(scope, organisationId)) throw new OutOfScopeError();
}

/**
 * Whether an engineer may touch a job.
 *
 * Assignment is the whole permission. An engineer who is not on a job has no
 * more access to it than a stranger, which is what keeps the restricted
 * interface restricted.
 */
export function canAccessAssignedJob(
  scope: AccessScope,
  job: { assignedEngineerId: string | null; agentOrganisationId: string | null },
): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "assigned") {
    return job.assignedEngineerId === scope.userId;
  }
  return canAccessOrganisation(scope, job.agentOrganisationId);
}

/**
 * Filters a query by the caller's scope.
 *
 * Every organisation-scoped read goes through this, rather than each handler
 * remembering a `WHERE`. A handler that forgets is the failure this design is
 * built to make hard, so the helper is the only sanctioned way to build the
 * condition — and it takes the column, so a table without an organisation
 * column cannot be queried through it by accident.
 *
 * Returns `undefined` for an admin, which Drizzle treats as no condition.
 */
export function organisationCondition(
  column: PgColumn,
  scope: AccessScope,
  extra?: SQL | undefined,
): SQL | undefined {
  switch (scope.kind) {
    case "all":
      return extra;
    case "organisation":
      return extra
        ? and(eq(column, scope.organisationId), extra)
        : eq(column, scope.organisationId);
    case "assigned":
      /*
        An engineer has no organisation. Matching nothing is deliberate:
        engineer queries filter on the assignment column instead, and silently
        widening this to "all" would be the worst possible failure. An explicit
        false is used rather than a contradictory comparison, which Postgres
        would refuse at query time on a uuid column.
      */
      return sql`false`;
  }
}

/**
 * Filters a query by *assignment* rather than by organisation.
 *
 * The mirror image of `organisationCondition`, and it exists for the same
 * reason: the engineer surfaces need a filter, and a handler that wrote its
 * own is the failure the whole design is built to make hard.
 *
 * - **`assigned`** — the engineer's own jobs, which is their entire access.
 * - **`all`** — no filter. An administrator can work the engineer screens,
 *   and giving them nothing there would only push them into a second,
 *   unscoped query written by hand.
 * - **`organisation`** — nothing. An agency has no business on a surface
 *   whose whole purpose is BSCJ's own work, and widening this to their
 *   organisation would hand them an engineer's view of it.
 */
export function assignmentCondition(
  column: PgColumn,
  scope: AccessScope,
  extra?: SQL | undefined,
): SQL | undefined {
  switch (scope.kind) {
    case "all":
      return extra;
    case "assigned":
      return extra ? and(eq(column, scope.userId), extra) : eq(column, scope.userId);
    case "organisation":
      // Explicit false rather than a contradictory comparison, which Postgres
      // would refuse at query time on a uuid column.
      return sql`false`;
  }
}
