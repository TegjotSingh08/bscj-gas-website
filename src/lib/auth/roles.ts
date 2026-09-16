/**
 * Who may do what.
 *
 * A capability table rather than checks scattered through handlers, for one
 * reason: a permission model you cannot read in one place is one nobody can
 * audit. Everything below is pure, so the whole matrix is testable without a
 * request, a session or a database.
 *
 * This answers "may this *kind* of user do this *kind* of thing". It does not
 * answer "does this row belong to them" — that is `scope.ts`, and both checks
 * are required. A capability without a scope check would let one agency read
 * another's portfolio using an entirely legitimate permission.
 */

export const APP_ROLES = [
  "admin",
  "engineer",
  "agent_owner",
  "agent_member",
] as const;

export type AppRole = (typeof APP_ROLES)[number];

/** The roles that belong to an agency rather than to BSCJ. */
export const AGENT_ROLES: readonly AppRole[] = ["agent_owner", "agent_member"];

/** The roles that belong to BSCJ. */
export const STAFF_ROLES: readonly AppRole[] = ["admin", "engineer"];

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

export function isAgentRole(role: AppRole): boolean {
  return AGENT_ROLES.includes(role);
}

export function isStaffRole(role: AppRole): boolean {
  return STAFF_ROLES.includes(role);
}

/**
 * The things a user can be permitted to do.
 *
 * Named for the action rather than the screen, so moving a button does not
 * change the permission model.
 */
export const CAPABILITIES = [
  "portfolio:read",
  "portfolio:write",
  "job:create",
  "job:read",
  "job:assign",
  /** Record results, remedials and completion on an assigned job. */
  "job:work",
  "pricing:read",
  "pricing:write",
  "invoice:read",
  "invoice:write",
  "certificate:read",
  "certificate:issue",
  "certificate:correct",
  "message:read",
  "message:write",
  "user:manage",
  "settings:write",
  "audit:read",
  "impersonate",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The matrix.
 *
 * Three things worth noticing, because each was a decision:
 *
 * - **An engineer never sees money.** No `pricing:read`, no `invoice:read`.
 *   They do not need it to do the work, and a restricted interface that
 *   happens to carry an agent's negotiated rate is not restricted.
 * - **An agent can read invoices but never write them.** Issuing is BSCJ's,
 *   and an issued invoice is immutable regardless.
 * - **`agent_owner` and `agent_member` differ only in `user:manage`.** Both
 *   run the portfolio; one can add a colleague. Splitting them further would
 *   invent a hierarchy no agency has asked for.
 */
const MATRIX: Readonly<Record<AppRole, readonly Capability[]>> = {
  admin: [...CAPABILITIES],

  engineer: [
    "job:read",
    "job:work",
    "certificate:read",
    "certificate:issue",
    "message:read",
    "message:write",
  ],

  agent_owner: [
    "portfolio:read",
    "portfolio:write",
    "job:create",
    "job:read",
    "pricing:read",
    "invoice:read",
    "certificate:read",
    "message:read",
    "message:write",
    "user:manage",
  ],

  agent_member: [
    "portfolio:read",
    "portfolio:write",
    "job:create",
    "job:read",
    "pricing:read",
    "invoice:read",
    "certificate:read",
    "message:read",
    "message:write",
  ],
};

/** Whether a role carries a capability at all. */
export function can(role: AppRole, capability: Capability): boolean {
  return MATRIX[role].includes(capability);
}

/** Everything a role may do. Sorted, so it is stable to read and to assert. */
export function capabilitiesFor(role: AppRole): readonly Capability[] {
  return [...MATRIX[role]].sort();
}

export class NotPermittedError extends Error {
  readonly role: AppRole;
  readonly capability: Capability;

  constructor(role: AppRole, capability: Capability) {
    // Deliberately says what was refused, not what exists. This message
    // reaches a log, never a browser.
    super(`${role} may not ${capability}.`);
    this.name = "NotPermittedError";
    this.role = role;
    this.capability = capability;
  }
}

/**
 * Asserts a capability.
 *
 * Every guarded action calls this rather than testing the role directly, so
 * adding a role is an edit to the matrix instead of a search for every
 * `role === "admin"` in the codebase.
 */
export function assertCan(role: AppRole, capability: Capability): void {
  if (!can(role, capability)) throw new NotPermittedError(role, capability);
}
