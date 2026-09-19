import "server-only";

import { and, asc, count, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { agentOrganisations, appUsers, jobs } from "@/lib/db/schema";
import { normaliseEmail } from "@/lib/auth/app-user";
import { revokeCredentials } from "@/lib/auth/credentials";
import type { OrganisationInput, OwnerInput } from "./validation";

/**
 * Agency accounts, from BSCJ's side.
 *
 * Everything here is **administrator-only** and says so in its name. There is
 * deliberately no scoped variant: an agency does not manage its own account in
 * V2, and a function that could be called with either audience's authority is
 * one somebody eventually calls with the wrong one.
 *
 * The caller's authority is checked by `requireAdmin()` before any of this is
 * reached. These functions do not re-check it, because a guard buried in a
 * query is a guard nobody can see — the check belongs at the top of the action.
 */

/** Anything that is not a UUID is not an id; Postgres would throw on it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OrganisationRow = {
  id: string;
  name: string;
  email: string;
  plan: string;
  isActive: boolean;
  userCount: number;
  createdAt: Date;
};

export async function listOrganisationsForAdmin(): Promise<
  OrganisationRow[] | null
> {
  const db = getDb();
  if (!db) return null;

  return db
    .select({
      id: agentOrganisations.id,
      name: agentOrganisations.name,
      email: agentOrganisations.email,
      plan: agentOrganisations.plan,
      isActive: agentOrganisations.isActive,
      userCount: count(appUsers.id),
      createdAt: agentOrganisations.createdAt,
    })
    .from(agentOrganisations)
    .leftJoin(appUsers, eq(appUsers.agentOrganisationId, agentOrganisations.id))
    .groupBy(agentOrganisations.id)
    .orderBy(asc(agentOrganisations.name));
}

export async function getOrganisationForAdmin(id: string) {
  const db = getDb();
  if (!db || !UUID.test(id)) return null;

  const [organisation] = await db
    .select()
    .from(agentOrganisations)
    .where(eq(agentOrganisations.id, id))
    .limit(1);

  if (!organisation) return null;

  /*
    The password hash is never selected. Not because this page would render it,
    but because a hash that is never loaded cannot be leaked by a later change
    to what this page renders.
  */
  const users = await db
    .select({
      id: appUsers.id,
      name: appUsers.name,
      email: appUsers.email,
      role: appUsers.role,
      isActive: appUsers.isActive,
      lastLoginAt: appUsers.lastLoginAt,
      /*
        Null means the invitation has not been accepted. This is the whole
        onboarding state the screen needs, and it is a timestamp rather than
        the hash — the hash is still never selected, so a later change to what
        this page renders cannot leak one.
      */
      passwordSetAt: appUsers.passwordSetAt,
    })
    .from(appUsers)
    .where(eq(appUsers.agentOrganisationId, id))
    .orderBy(asc(appUsers.createdAt));

  const [jobCount] = await db
    .select({ n: count() })
    .from(jobs)
    .where(eq(jobs.agentOrganisationId, id));

  return { organisation, users, jobCount: jobCount?.n ?? 0 };
}

export type CreateResult =
  | { status: "created"; id: string }
  | { status: "duplicate" }
  | { status: "not_configured" }
  | { status: "failed" };

export async function createOrganisation(
  input: OrganisationInput,
): Promise<CreateResult> {
  const db = getDb();
  if (!db) return { status: "not_configured" };

  try {
    const [row] = await db
      .insert(agentOrganisations)
      .values({
        name: input.name,
        legalName: input.legalName,
        companyNumber: input.companyNumber,
        email: input.email,
        phone: input.phone,
        billingLine1: input.billingLine1,
        billingLine2: input.billingLine2,
        billingTown: input.billingTown,
        billingPostcode: input.billingPostcode,
        notes: input.notes,
        /*
          Both defaults are deliberate and both are in the schema:
          `plan` is `free_legacy` because platform access is free for BSCJ
          compliance customers, and `remedial_authority_pence` is 0 because a
          new account authorises nothing without asking.
        */
      })
      .returning({ id: agentOrganisations.id });

    return { status: "created", id: row.id };
  } catch {
    return { status: "failed" };
  }
}

/**
 * Adds the agency's first user, or another one later.
 *
 * **The account is created with no password.** `password_hash` is left null,
 * which is the honest record of "invited, not yet accepted", and the caller
 * then raises an invitation through the outbox — see `lib/auth/onboarding.ts`.
 * Nobody types a password on somebody else's behalf, so there is no password
 * to communicate and nothing to leak in the communicating.
 *
 * Creating the account and queueing the invitation are deliberately two steps.
 * An account that exists with no invitation is recoverable in one click; an
 * invitation for an account that failed to create is not recoverable at all.
 *
 * The email is unique across the whole `app_user` table, staff included, so a
 * clash is reported as a duplicate rather than surfacing a constraint error.
 * Which account already holds the address is deliberately not said: an
 * administrator can look, and the message should not become a way to test
 * whether an address has an account.
 */
export async function createOrganisationUser(
  organisationId: string,
  input: OwnerInput,
  role: "agent_owner" | "agent_member" = "agent_owner",
): Promise<CreateResult> {
  const db = getDb();
  if (!db) return { status: "not_configured" };
  if (!UUID.test(organisationId)) return { status: "failed" };

  const email = normaliseEmail(input.email);

  try {
    const [clash] = await db
      .select({ id: appUsers.id })
      .from(appUsers)
      .where(eq(appUsers.email, email))
      .limit(1);
    if (clash) return { status: "duplicate" };

    const [row] = await db
      .insert(appUsers)
      .values({
        agentOrganisationId: organisationId,
        email,
        name: input.name,
        /*
          Null, deliberately. There is no password yet and nobody is going to
          invent one: the invitation the caller queues next is what lets this
          person choose their own. `authenticateUser` refuses a null hash at
          exactly the cost of refusing a wrong one, so the state cannot be
          detected from the login form.
        */
        passwordHash: null,
        role,
      })
      .onConflictDoNothing({ target: appUsers.email })
      .returning({ id: appUsers.id });

    return row ? { status: "created", id: row.id } : { status: "duplicate" };
  } catch {
    return { status: "failed" };
  }
}

/**
 * Activates or suspends an agency.
 *
 * Suspending locks out every one of its users at once, because
 * `currentIdentity` refuses an agency user whose organisation is inactive —
 * and it does so on the next request, not when their token expires. There is
 * no delete: a deactivated agency keeps its jobs, certificates and invoices,
 * and a deleted one would take a property's compliance history with it.
 */
export async function setOrganisationActive(
  id: string,
  isActive: boolean,
): Promise<boolean> {
  const db = getDb();
  if (!db || !UUID.test(id)) return false;

  try {
    await db
      .update(agentOrganisations)
      .set({ isActive, updatedAt: new Date() })
      .where(eq(agentOrganisations.id, id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Activates or suspends one user, without touching the rest of the agency.
 *
 * **Suspending also stands down every outstanding credential.** An invitation
 * or a reset link already in an inbox would otherwise still be redeemable, and
 * "suspended" would mean "cannot sign in, unless they happen to be holding a
 * link we sent last week". Redemption re-checks the account anyway, so this is
 * belt and braces — but it is the belt that makes the rule readable.
 */
export async function setOrganisationUserActive(
  organisationId: string,
  userId: string,
  isActive: boolean,
): Promise<boolean> {
  const db = getDb();
  if (!db || !UUID.test(organisationId) || !UUID.test(userId)) return false;

  try {
    await db
      .update(appUsers)
      .set({ isActive, updatedAt: new Date() })
      // Scoped to the organisation as well as the id, so a mistyped user id
      // cannot deactivate somebody in another agency — or a member of staff.
      .where(
        and(
          eq(appUsers.id, userId),
          eq(appUsers.agentOrganisationId, organisationId),
        ),
      );

    if (!isActive) await revokeCredentials(userId);

    return true;
  } catch {
    return false;
  }
}

/** How many consumer jobs exist. Shown so "cross-organisation" is visible. */
export async function countConsumerJobs(): Promise<number | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select({ n: count() })
    .from(jobs)
    .where(isNull(jobs.agentOrganisationId));
  return row?.n ?? 0;
}
