import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { appUsers } from "@/lib/db/schema";
import { isAgentRole, type AppRole } from "./roles";
import { verifyPassword } from "./password";

/**
 * Looking up and checking a user.
 *
 * Kept apart from the Auth.js wiring so the rule that matters — what counts as
 * a valid sign-in — is a plain function that can be read and tested without a
 * framework around it.
 *
 * One table and one function for BSCJ staff and agency users alike. A second
 * login path would be a second place to get password comparison, timing,
 * deactivation and normalisation subtly wrong.
 */

export type UserIdentity = {
  id: string;
  email: string;
  name: string;
  role: AppRole;
  /** Null for BSCJ staff. */
  agentOrganisationId: string | null;
};

/** Normalised the same way everywhere, so case never decides who you are. */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Verifies credentials.
 *
 * Returns null for every kind of failure — unknown address, wrong password,
 * deactivated account, no database — and deliberately does the same amount of
 * work either way. Telling a caller that an address exists but the password is
 * wrong is how a login becomes a list of who to attack.
 *
 * An agency user whose organisation row is missing is refused. That is a data
 * fault rather than a credential failure, but signing them in would produce a
 * session with no scope, and every possible interpretation of that is worse
 * than refusing.
 */
export async function authenticateUser(
  email: string,
  password: string,
): Promise<UserIdentity | null> {
  const db = getDb();
  if (!db) return null;

  const [user] = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.email, normaliseEmail(email)))
    .limit(1);

  /*
    No early return on a missing user. Skipping the hash would make an unknown
    address answer in a millisecond and a known one in a few hundred, which is
    a user-enumeration oracle anyone can measure. Verifying against a dummy
    hash costs the same as the real thing.
  */
  const hash = user?.passwordHash ?? DUMMY_HASH;
  const correct = await verifyPassword(password, hash);

  if (!user || !correct || !user.isActive) return null;
  if (isAgentRole(user.role) && !user.agentOrganisationId) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    agentOrganisationId: user.agentOrganisationId,
  };
}

/**
 * A real scrypt hash of a value nobody knows, at the same cost as a live one,
 * so verifying against it takes the same time as verifying a real password.
 */
const DUMMY_HASH =
  "scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$" +
  "Y2Fubm90LW1hdGNoLWFueXRoaW5nLWJlY2F1c2UtdGhpcy1pcy1ub3QtYS1kZXJpdmVkLWtleQ";

/**
 * The current, authoritative record for a signed-in user.
 *
 * **This is what every request reads, rather than trusting the session.** A
 * token is signed but stale: it cannot know that an account was deactivated,
 * that a role changed or that a user moved between organisations since it was
 * issued eight hours ago. Re-reading is one indexed primary-key lookup, which
 * is a small price for a permission change that takes effect immediately.
 *
 * Returns null for a user who no longer exists or is no longer active, which
 * every caller treats as "not signed in".
 */
export async function currentIdentity(id: string): Promise<UserIdentity | null> {
  const db = getDb();
  if (!db) return null;

  const [user] = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.id, id))
    .limit(1);

  if (!user || !user.isActive) return null;
  if (isAgentRole(user.role) && !user.agentOrganisationId) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    agentOrganisationId: user.agentOrganisationId,
  };
}

/** Records a successful sign-in. Best effort: never blocks the login. */
export async function recordLogin(id: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .update(appUsers)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(appUsers.id, id));
  } catch {
    // A missed timestamp is not a reason to refuse someone entry.
  }
}
