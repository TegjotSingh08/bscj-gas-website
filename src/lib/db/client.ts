import "server-only";

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema";

/**
 * The database handle.
 *
 * Lazily created and cached, exactly like the Redis client: a missing
 * `DATABASE_URL` must not break a build or crash a page that never touches the
 * database. Callers that genuinely need it use `requireDb()` and get a clear
 * error; callers that can degrade use `getDb()` and check for null.
 *
 * The Neon HTTP driver is used rather than a TCP pool because every request
 * here runs in a short-lived serverless function, where a connection pool is
 * something to leak rather than something to reuse.
 */

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let cached: Database | null = null;

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("DATABASE_URL is not set.");
    this.name = "DatabaseNotConfiguredError";
  }
}

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** The handle, or null when no database is configured. */
export function getDb(): Database | null {
  if (cached) return cached;

  const url = process.env.DATABASE_URL;
  if (!url) return null;

  cached = drizzle(neon(url), { schema });
  return cached;
}

/** The handle, or a clear failure. For code that cannot proceed without one. */
export function requireDb(): Database {
  const db = getDb();
  if (!db) throw new DatabaseNotConfiguredError();
  return db;
}

/** Test seam, mirroring `setKvClientForTesting`. */
export function setDbForTesting(db: Database | null): void {
  cached = db;
}
