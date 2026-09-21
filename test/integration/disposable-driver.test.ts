import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  DISPOSABLE_URL,
  connect,
  reset,
  start,
  stop,
  type Connection,
} from "../support/disposable-postgres";
import { disposableDb } from "../../src/lib/db/disposable";
import { agentOrganisations } from "../../src/lib/db/schema";

/**
 * The test driver itself, held to what it claims.
 *
 * This handle is what the **browser** acceptance runs on: the real Next
 * server builds it from `DATABASE_URL` like any deployment would, and every
 * signed-in click goes through it. So a defect in it does not produce a
 * failing test — it produces a *passing* browser run whose evidence is wrong,
 * which is the worst kind of harness bug and the reason these exist.
 *
 * What is under test is the `batch` shim, which stands in for the Neon
 * driver's one-transaction batch. Its promise is narrow and is written down
 * in `disposable.ts`: for one driven session, a batch is atomic and nothing
 * else is dragged into it. These tests hold it to exactly that and to no
 * more.
 */

let conn: Connection;
let db: ReturnType<typeof handle>;

function handle() {
  const built = disposableDb(DISPOSABLE_URL);
  assert.ok(built, "the harness's own URL is a disposable target");
  return built as {
    insert: (table: unknown) => { values: (row: unknown) => PromiseLike<unknown> };
    batch: (statements: readonly PromiseLike<unknown>[]) => Promise<unknown[]>;
    $client: { end: () => Promise<void> };
  };
}

before(async () => {
  await start();
  conn = await connect();
  db = handle();
});

after(async () => {
  await db.$client.end();
  await stop();
});

beforeEach(async () => {
  await reset(conn);
});

const organisation = (name: string, id?: string) => ({
  ...(id ? { id } : {}),
  name,
  email: `${name.toLowerCase()}@fixture.example.invalid`,
});

/**
 * A fixed id, so a second insert of it is a primary-key violation.
 *
 * The table has no unique constraint the application does not need, so the
 * key is what gives a statement that is certain to fail — which is what a
 * rollback has to be provoked by.
 */
const CLASH = "00000000-0000-4000-8000-0000000000aa";
const CLASH_TWO = "00000000-0000-4000-8000-0000000000bb";

async function names(): Promise<string[]> {
  const { rows } = await conn.client.query<{ name: string }>(
    "select name from agent_organisation order by name",
  );
  return rows.map((row) => row.name);
}

/** A statement that is certain to fail, so the batch has to roll back. */
function failingStatement() {
  // The primary key the same batch just used.
  return db.insert(agentOrganisations).values(organisation("Alpha", CLASH));
}

describe("a batch is all or nothing", () => {
  test("a failure inside it leaves nothing behind", async () => {
    await assert.rejects(
      db.batch([
        db.insert(agentOrganisations).values(organisation("Alpha", CLASH)),
        failingStatement(),
      ]),
    );
    assert.deepEqual(await names(), []);
  });

  test("and a batch that succeeds keeps all of it", async () => {
    await db.batch([
      db.insert(agentOrganisations).values(organisation("Alpha")),
      db.insert(agentOrganisations).values(organisation("Beta")),
    ]);
    assert.deepEqual(await names(), ["Alpha", "Beta"]);
  });
});

describe("a concurrent caller is not dragged into the transaction", () => {
  test("its write survives a batch that rolls back", async () => {
    /*
      **The defect this reproduces.** `pool.query` checks the connection out
      and returns it per statement, so with no lock the ordering on a
      single-connection pool is: BEGIN, *the other caller's insert*, the
      batch's own statements, ROLLBACK. The unrelated write is inside the
      transaction and is destroyed by a failure it had nothing to do with.

      A browser reaches this without trying — a prefetch beside a form post
      is two requests on one handle. Issuing the second write here while the
      batch is awaiting its `BEGIN` is exactly that, deterministically.
    */
    const rollingBack = db.batch([
      db.insert(agentOrganisations).values(organisation("Alpha", CLASH)),
      failingStatement(),
    ]);

    // Issued now, while the batch is mid-flight, as a second request would be.
    const unrelated = db
      .insert(agentOrganisations)
      .values(organisation("Bystander"));

    const [batchResult, unrelatedResult] = await Promise.allSettled([
      rollingBack,
      unrelated,
    ]);

    assert.equal(batchResult.status, "rejected", "the batch still rolled back");
    assert.equal(unrelatedResult.status, "fulfilled");
    assert.deepEqual(
      await names(),
      ["Bystander"],
      "the bystander's write was committed on its own",
    );
  });

  test("and its read does not see the batch's uncommitted rows", async () => {
    const committing = db.batch([
      db.insert(agentOrganisations).values(organisation("Alpha")),
      db.insert(agentOrganisations).values(organisation("Beta")),
    ]);
    const duringBatch = names();

    await committing;
    /*
      The read is serialised against the batch rather than run inside it, so
      it observes either nothing or the whole thing — never half.
    */
    const seen = await duringBatch;
    assert.ok(
      seen.length === 0 || seen.length === 2,
      `a partial transaction was visible: ${JSON.stringify(seen)}`,
    );
  });

  test("two batches do not interleave", async () => {
    const first = db.batch([
      db.insert(agentOrganisations).values(organisation("Alpha")),
      db.insert(agentOrganisations).values(organisation("Beta")),
    ]);
    const second = db.batch([
      db.insert(agentOrganisations).values(organisation("Gamma", CLASH_TWO)),
      // Fails: the primary key this same batch just used.
      db.insert(agentOrganisations).values(organisation("Gamma", CLASH_TWO)),
    ]);

    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");

    // The first batch is intact; the second left nothing.
    assert.deepEqual(await names(), ["Alpha", "Beta"]);
  });
});
