import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { businessSettings } from "@/lib/db/schema";
import {
  DEFAULT_PROFILE,
  parseProfile,
  PROFILE_VERSION,
  type ImportProfile,
} from "./profile";

/**
 * Where an agency's import profile is kept.
 *
 * **In the existing settings table, keyed by organisation — no new table and
 * no migration.** `business_setting` is a key/value store with a text primary
 * key, which is the shape this needs. A profile is configuration: it has no
 * relations, nothing references it, and losing one costs a review rather than
 * any business record. A dedicated table would be infrastructure bought for
 * nothing.
 *
 * **The organisation is in the key**, so there is no shared row on which a
 * query could forget a `WHERE` — one agency's profile is unreachable from
 * another's. The id comes from the admin session or from `requireAgent()`,
 * never from an upload.
 */

/** `portfolio-import-profile:<organisationId>`. The id is the scope. */
export function profileKey(organisationId: string): string {
  return `portfolio-import-profile:${organisationId}`;
}

/** Anything that is not a UUID is not an id; Postgres would throw on it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StoredProfile = {
  profile: ImportProfile;
  /** False when nothing is configured and the cautious default is in use. */
  configured: boolean;
};

/**
 * This agency's profile, or the cautious default.
 *
 * Every failure — no database, no row, an unreadable value — yields the
 * default, which behaves exactly as the importer did before profiles existed:
 * template headings, no assumed tenant, no assumed landlord match. A profile
 * that cannot be read must never fail an upload, and must never quietly become
 * a *more permissive* reading than the one BSCJ configured.
 */
export async function readProfile(
  organisationId: string,
): Promise<StoredProfile> {
  const db = getDb();
  if (!db || !UUID.test(organisationId)) {
    return { profile: { ...DEFAULT_PROFILE }, configured: false };
  }

  try {
    const [row] = await db
      .select({ value: businessSettings.value })
      .from(businessSettings)
      .where(eq(businessSettings.key, profileKey(organisationId)))
      .limit(1);

    if (!row) return { profile: { ...DEFAULT_PROFILE }, configured: false };
    return { profile: parseProfile(row.value), configured: true };
  } catch {
    return { profile: { ...DEFAULT_PROFILE }, configured: false };
  }
}

export type SaveResult = { ok: true } | { ok: false; reason: string };

/**
 * Records a profile. Administrator-only; the caller checks that.
 *
 * Upsert, so two administrators saving at once produce one row and a
 * last-write-wins rather than a unique violation.
 *
 * **`updatedAt` moves on every save**, which is deliberate: a preview taken
 * before an edit carries the old digest and is refused at confirmation. A
 * profile change applies to *future* imports and rewrites nothing that already
 * exists.
 */
export async function writeProfile(input: {
  organisationId: string;
  profile: Omit<ImportProfile, "version" | "updatedAt">;
  actorUserId: string;
  now?: Date;
}): Promise<SaveResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "The database is not configured." };
  if (!UUID.test(input.organisationId)) {
    return { ok: false, reason: "That agency could not be found." };
  }

  const value: ImportProfile = {
    ...input.profile,
    version: PROFILE_VERSION,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };

  try {
    await db
      .insert(businessSettings)
      .values({
        key: profileKey(input.organisationId),
        value,
        updatedBy: input.actorUserId,
      })
      .onConflictDoUpdate({
        target: businessSettings.key,
        set: { value, updatedBy: input.actorUserId, updatedAt: new Date() },
      });
    return { ok: true };
  } catch {
    return { ok: false, reason: "That profile could not be saved." };
  }
}

/** Forgets the profile, so imports fall back to the template. */
export async function clearProfile(organisationId: string): Promise<boolean> {
  const db = getDb();
  if (!db || !UUID.test(organisationId)) return false;

  try {
    await db
      .delete(businessSettings)
      .where(eq(businessSettings.key, profileKey(organisationId)));
    return true;
  } catch {
    return false;
  }
}
