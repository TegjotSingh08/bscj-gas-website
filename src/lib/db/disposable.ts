import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
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
    **One connection *and* a lock.** Neither on its own is enough.

    An earlier version used `max: 1` alone and reasoned that a single
    connection made the batch below atomic. It does not. `pool.query` checks
    the connection out and hands it back **per statement**, so between the
    `BEGIN` and the `COMMIT` it returns to the pool and another caller's query
    is served on it — inside the open transaction. A browser issues concurrent
    requests as a matter of course, so this is reachable, and what it produces
    is one request's write rolled back by an unrelated request's failure.

    The lock is what supplies the property; `max: 1` is what makes "the same
    session" true. Stated for what it is: **a test-harness approximation of
    the Neon driver's batch**, correct for the one driven session this handle
    exists for. It is not a transaction manager, and it makes no claim about
    the application's concurrency — the in-process integration harness gives
    every connection its own `pg.Client`, and that is what the concurrency
    tests use.
  */
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema });

  /*
    Whether the current asynchronous context is the batch that holds the lock.

    `AsyncLocalStorage` rather than a flag, because a flag cannot tell the
    batch's own statements apart from a concurrent request's: both run while
    the batch is awaiting. A Drizzle statement begins executing when it is
    awaited, so awaiting it inside `run` puts its `pool.query` in this context
    and leaves every other caller's outside it.
  */
  const inBatch = new AsyncLocalStorage<true>();

  /** One unit of work at a time, in arrival order. */
  let tail: Promise<unknown> = Promise.resolve();
  const exclusively = <T>(body: () => Promise<T>): Promise<T> => {
    const run = tail.then(body, body);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /*
    Every query waits for the lock unless it belongs to the batch holding it.
    Without this the lock would only order batches against each other, and an
    ordinary query would still land in the middle of one.
  */
  const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  pool.query = ((...args: unknown[]) =>
    inBatch.getStore()
      ? query(...args)
      : exclusively(() => query(...args))) as typeof pool.query;

  /**
   * The Neon driver's one-transaction batch, over `node-postgres`.
   *
   * The application uses `db.batch([...])` wherever several writes must land
   * together. `node-postgres` has no such method, so it is provided here with
   * the same meaning — one transaction, all or nothing — enforced by Postgres
   * rather than described.
   *
   * **No dedicated client is checked out**, deliberately. The statements are
   * bound to the *pool*, so a transaction opened on a client the pool did not
   * give them would be a transaction with nothing in it — and with `max: 1`,
   * checking one out while the statements queue for the same connection is a
   * deadlock. It presented once as an import that claimed its run, wrote
   * nothing and sat at "Importing…" for ever, which is how it was found. So
   * `BEGIN` goes through the pool like everything else, and the lock is what
   * guarantees nothing else is on the connection in between.
   */
  db.batch = async (statements: readonly PromiseLike<unknown>[]) =>
    exclusively(() =>
      inBatch.run(true, async () => {
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
      }),
    );

  return db;
}
