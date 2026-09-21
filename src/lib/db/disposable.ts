import "server-only";

import { createRequire } from "node:module";

import * as schema from "./schema";

/**
 * A handle onto the throwaway PostgreSQL the integration harness starts.
 *
 * **Why this exists in `src/` at all.** Driving the real application in a
 * browser means running the real Next server, and that server is its own
 * process — it cannot be handed an instance through `setDbForTesting`. It has
 * to build one from `DATABASE_URL` like any other deployment. The shipping
 * driver is Neon's HTTP one, which speaks Neon's endpoint protocol and cannot
 * talk to a plain local Postgres, so without this there is no way to point the
 * actual application at a disposable database and click through it.
 *
 * **Why production cannot reach it.** Two conditions, both required, and
 * neither is true of any real deployment:
 *
 * 1. `BSCJ_DISPOSABLE_DB` is exactly `"1"`. The harness sets it; nothing else
 *    does, and it is not in `.env.example`.
 * 2. The connection string passes a **whitelist of exact values** — loopback
 *    host, the harness's own port, its one database name, its one fictional
 *    user. Not a blacklist of dangerous things: "this is not production" is
 *    unprovable, "this is the throwaway server" is checkable.
 *
 * The pilot satisfies neither. Its URL names a Neon host on the ordinary port,
 * and it never sets the variable. If somebody set the variable by accident, the
 * whitelist still refuses; if somebody pointed it at a real database, the
 * variable is still absent. Both have to be wrong at once.
 *
 * **It changes nothing about how the application behaves.** The same Drizzle
 * schema, the same queries, the same constraints — only the wire underneath.
 * `getDb()` falls through to the Neon driver whenever this returns null, which
 * is always, outside a test run.
 */

/** Exactly what `test/support/disposable-postgres.ts` creates. Kept in step. */
const DISPOSABLE = {
  host: "127.0.0.1",
  port: "55433",
  database: "bscj_disposable_test",
  user: "bscj_disposable",
} as const;

/** Whether this connection string is recognisably the harness's own server. */
export function isDisposableTarget(url: string): boolean {
  if (process.env.BSCJ_DISPOSABLE_DB !== "1") return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  return (
    (parsed.hostname === DISPOSABLE.host || parsed.hostname === "localhost") &&
    parsed.port === DISPOSABLE.port &&
    parsed.pathname.replace(/^\//, "") === DISPOSABLE.database &&
    parsed.username === DISPOSABLE.user
  );
}

/**
 * Builds the handle, or returns null so the caller uses the shipping driver.
 *
 * `require` rather than `import`, through `createRequire`, for two reasons:
 * `getDb()` is synchronous and must stay so, and `pg` is a development
 * dependency that must not become a static import in a production bundle. The
 * specifier is held in a variable so a bundler does not try to resolve it at
 * build time either.
 */
export function disposableDb(url: string): unknown | null {
  if (!isDisposableTarget(url)) return null;

  const require = createRequire(import.meta.url);
  const pgSpecifier = "pg";
  const drizzleSpecifier = "drizzle-orm/node-postgres";

  const { Pool } = require(pgSpecifier) as typeof import("pg");
  const { drizzle } = require(drizzleSpecifier) as {
    drizzle: (client: unknown, options: unknown) => Record<string, unknown>;
  };

  /*
    **One connection, on purpose.** A pool that hands out whichever connection
    is free would make the batch below meaningless: its `BEGIN` and its
    `COMMIT` could land on different sessions, and the atomicity the
    application relies on would silently not be there.
  */
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema });

  /**
   * The Neon driver's one-transaction batch, over `node-postgres`.
   *
   * The application uses `db.batch([...])` wherever several writes must land
   * together. `node-postgres` has no such method, so it is provided here with
   * the same meaning — one transaction, all or nothing — enforced by Postgres
   * rather than described.
   *
   * **`BEGIN` goes through the pool, not through a checked-out client.** An
   * earlier version took a dedicated client for the transaction and then
   * awaited the Drizzle statements, which are bound to the *pool* — so they
   * queued for a connection the batch itself was holding, and with `max: 1`
   * that is a deadlock. It presented as an import that claimed its run, wrote
   * nothing and sat at "Importing…" for ever, which is how it was found.
   *
   * With `max: 1` the pool has exactly one connection and serialises onto it,
   * so `BEGIN`, the statements and `COMMIT` all land on the same session in
   * the order they are issued.
   *
   * **The limitation that comes with that**, stated rather than discovered: a
   * genuinely concurrent caller on this same handle would have its statements
   * fall inside this transaction. That is acceptable for what this is for —
   * driving one browser session — and it is why the in-process integration
   * harness gives each connection its own `pg.Client` instead, which is what
   * every concurrency test uses.
   */
  db.batch = async (statements: readonly PromiseLike<unknown>[]) => {
    await pool.query("BEGIN");
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement);
      await pool.query("COMMIT");
      return results;
    } catch (error) {
      try {
        await pool.query("ROLLBACK");
      } catch {
        // The transaction is going back whatever happens to this statement.
      }
      throw error;
    }
  };

  return db;
}
