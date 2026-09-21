/**
 * A real PostgreSQL, owned by the test run and thrown away with it.
 *
 * **Why this exists.** Every integration claim before now was made against a
 * fake at the database boundary. That proves what the application *decides* and
 * nothing about what Postgres *does* — not the unique indexes, not the foreign
 * keys, not transaction visibility, and not what two connections racing each
 * other actually produce. Those are exactly the properties the compliance and
 * import work depends on, so they need a database.
 *
 * **What this is.** `embedded-postgres` unpacks a genuine PostgreSQL server
 * into `node_modules` and runs it as a child process on a loopback port. It is
 * project-local: nothing is installed system-wide, no service is registered,
 * and the data directory is a temporary one that is deleted on stop. It is a
 * real server, so `pg_backend_pid()` differs between clients and a unique
 * violation on one connection is raised by the database rather than by us.
 *
 * **What this is not.** It is not a second persistence layer and not an
 * emulator. The application's own `getDb()` is handed a Drizzle instance
 * through the `setDbForTesting` seam that already existed; no production code
 * path changes, and the Neon HTTP driver remains what ships.
 *
 * **Fail closed.** Nothing here reads `.env.local`, `.env.pilot` or any other
 * environment file, and `start()` *deletes* any inherited `DATABASE_URL*` from
 * the process before it does anything. Every connection is checked against
 * `assertDisposable` — loopback host, the port this module chose, the one
 * database name, the one fictional user, and a marker this module set itself.
 * A connection string that is not recognisably ours is refused rather than
 * used.
 */

import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as schema from "../../src/lib/db/schema";

/** Fictional throughout. Not a secret, and it reaches nothing but this server. */
const TEST_USER = "bscj_disposable";
const TEST_PASSWORD = "disposable-fixture-password-not-a-secret";
const TEST_DATABASE = "bscj_disposable_test";
/** Loopback only. Deliberately far from 5432 so it cannot meet a real server. */
const TEST_PORT = 55433;
const TEST_HOST = "127.0.0.1";

/** Set by `start()`, checked by `assertDisposable`. */
const MARKER = "BSCJ_DISPOSABLE_DB";

export const DISPOSABLE_URL = `postgresql://${TEST_USER}:${TEST_PASSWORD}@${TEST_HOST}:${TEST_PORT}/${TEST_DATABASE}`;

export class NotDisposableError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to use this database: ${reason}. The integration harness only ever talks to the throwaway server it started itself.`,
    );
    this.name = "NotDisposableError";
  }
}

/**
 * Every check that has to pass before a connection is opened.
 *
 * Deliberately a whitelist of exact values rather than a blacklist of dangerous
 * ones. "Not production" is unprovable; "this is the server I started, on
 * loopback, with the fictional credentials I chose" is checkable.
 */
export function assertDisposable(url: string): void {
  if (process.env[MARKER] !== "1") {
    throw new NotDisposableError(
      "the disposable-database marker is not set, so no harness owns this run",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NotDisposableError("the connection string could not be parsed");
  }

  if (parsed.hostname !== TEST_HOST && parsed.hostname !== "localhost") {
    throw new NotDisposableError(`host ${parsed.hostname} is not loopback`);
  }
  if (parsed.port !== String(TEST_PORT)) {
    throw new NotDisposableError(
      `port ${parsed.port} is not the harness port ${TEST_PORT}`,
    );
  }
  if (parsed.pathname.replace(/^\//, "") !== TEST_DATABASE) {
    throw new NotDisposableError(
      `database ${parsed.pathname.replace(/^\//, "")} is not ${TEST_DATABASE}`,
    );
  }
  if (parsed.username !== TEST_USER) {
    throw new NotDisposableError(`user ${parsed.username} is not ${TEST_USER}`);
  }
}

/**
 * The Drizzle instance the application is handed.
 *
 * `drizzle(client)` is typed against a `Pool`; we deliberately pass a single
 * `Client` (see `connect`), so the handle is described by what the tests and
 * the application actually call rather than by the overload that assumes a
 * pool.
 */
export type DisposableDatabase = Omit<
  ReturnType<typeof drizzle<typeof schema>>,
  "$client"
> & {
  /**
   * The Neon HTTP driver's one-transaction batch, over `node-postgres`.
   *
   * The application uses `db.batch([...])` wherever several writes must land
   * together, and that is a Neon-driver method. Here the Drizzle instance holds
   * a **single `pg.Client`**, so every statement it builds goes down the same
   * connection — which means wrapping them in `BEGIN`/`COMMIT` on that client
   * gives exactly the semantics the application is relying on, enforced by
   * Postgres rather than described by a fake. A failure rolls the whole thing
   * back, which is the property the batch exists for.
   */
  batch: (statements: readonly PromiseLike<unknown>[]) => Promise<unknown[]>;
};

export type Connection = {
  db: DisposableDatabase;
  client: Client;
  /** The backend process id, so a test can prove two connections are two. */
  backendPid(): Promise<number>;
  close(): Promise<void>;
};

let server: EmbeddedPostgres | null = null;
let dataDir: string | null = null;
const open = new Set<Client>();

/**
 * Starts the server, creates the database and applies the real migration chain.
 *
 * The migrations are the committed SQL files, run by Drizzle's own migrator in
 * journal order — `0000` through `0009`, including the partial unique index
 * that makes two active compliance positions impossible. Nothing is generated
 * from the schema at run time: if the chain would not apply to the pilot, it
 * does not apply here either, and that is the point.
 */
export async function start(): Promise<void> {
  if (server) return;

  /*
    Anything inherited is removed before a connection can be opened. A harness
    that fell back to an ambient `DATABASE_URL` would be one mistyped shell away
    from writing fixtures into development.
  */
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("DATABASE_URL")) delete process.env[key];
  }
  process.env[MARKER] = "1";

  dataDir = mkdtempSync(path.join(tmpdir(), "bscj-disposable-pg-"));

  server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: TEST_USER,
    password: TEST_PASSWORD,
    port: TEST_PORT,
    // Nothing survives the run. There is no state to keep and none to leak.
    persistent: false,
  });

  await server.initialise();
  await server.start();
  await server.createDatabase(TEST_DATABASE);

  const migrator = await connect();
  try {
    await migrate(migrator.db, {
      migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    });
  } finally {
    await migrator.close();
  }
}

/** Stops the server and deletes its data directory. Safe to call twice. */
export async function stop(): Promise<void> {
  for (const client of open) {
    try {
      await client.end();
    } catch {
      // Already gone. Shutting down is not a place to fail.
    }
  }
  open.clear();

  if (server) {
    try {
      await server.stop();
    } catch {
      // Same.
    }
    server = null;
  }

  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
  delete process.env[MARKER];
}

/**
 * One connection, with its own Drizzle instance.
 *
 * A `Client` rather than a `Pool`, on purpose. A pool hands out whichever
 * connection is free, which would make "the same connection" untrue and the
 * batch shim above wrong — and would quietly destroy the one property a
 * concurrency test is trying to establish. Two callers wanting two connections
 * call this twice and genuinely get two backends.
 */
export async function connect(): Promise<Connection> {
  assertDisposable(DISPOSABLE_URL);

  const client = new Client({ connectionString: DISPOSABLE_URL });
  await client.connect();
  open.add(client);

  const base = drizzle(client, { schema });

  const batch = async (statements: readonly PromiseLike<unknown>[]) => {
    await client.query("BEGIN");
    try {
      const results: unknown[] = [];
      // Sequentially, down this one connection, inside this one transaction.
      for (const statement of statements) results.push(await statement);
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  };

  const db = Object.assign(base, { batch }) as unknown as DisposableDatabase;

  return {
    db,
    client,
    async backendPid() {
      const { rows } = await client.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      return rows[0].pid;
    },
    async close() {
      open.delete(client);
      await client.end();
    },
  };
}

/**
 * Empties every table, leaving the schema and the migration journal.
 *
 * `TRUNCATE ... CASCADE` rather than dropping and re-migrating between tests:
 * it is far quicker, and it keeps the constraints under test rather than
 * rebuilding them. `RESTART IDENTITY` puts the invoice sequence back, so a test
 * that asserts on a number is not reading the previous test's.
 */
export async function reset(connection: Connection): Promise<void> {
  const { rows } = await connection.client.query<{ tablename: string }>(
    `select tablename from pg_tables
      where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  if (rows.length === 0) return;

  const names = rows.map((row) => `"public"."${row.tablename}"`).join(", ");
  await connection.client.query(
    `truncate table ${names} restart identity cascade`,
  );
}
