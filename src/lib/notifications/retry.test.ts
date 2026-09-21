import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Putting a failed message back in the queue, through the real service.
 *
 * The recovery half of Priority 4: the pilot's problem was not that messages
 * failed, it was that nobody could see or do anything about it without a
 * browser console.
 *
 * Service level — the database is a recording fake. What is exercised is the
 * decision: which rows may be retried, what is written, what is audited, and
 * what two administrators pressing the button together produce.
 */

type Update = { values: Record<string, unknown>; conditional: boolean };

let rows: Record<string, unknown>[] = [];
let updates: Update[] = [];
let audits: { kind: string; detail: unknown }[] = [];
/** Rows the conditional update matches. Zero means somebody else got there. */
let updateMatches = 1;
let failRead = false;

function makeDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (failRead) throw new Error("connection lost");
            return rows;
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updates.push({ values, conditional: true });
            return updateMatches > 0 ? [{ id: "row-1" }] : [];
          },
        }),
      }),
    }),
  };
}

mock.module("@/lib/db/client", { namedExports: { getDb: () => makeDb() } });
mock.module("@/lib/audit/record", {
  namedExports: {
    recordAudit: async (entry: { kind: string; detail: unknown }) => {
      audits.push(entry);
    },
  },
});

const { retryFailedNotification } = await import("./outbox");

const FAILED = {
  id: "row-1",
  kind: "tenant.invitation",
  state: "failed",
  lastError: "unknown",
  attempts: 5,
};

beforeEach(() => {
  rows = [FAILED];
  updates = [];
  audits = [];
  updateMatches = 1;
  failRead = false;
});

describe("retrying a message that gave up", () => {
  test("it goes back to pending with its attempts reset", async () => {
    /*
      Resetting the count is the point: a bounded retry that has run out needs
      its bound reset, or the button does nothing at all.
    */
    const result = await retryFailedNotification({
      id: "row-1",
      actorUserId: "u-1",
    });

    assert.equal(result.ok, true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].values.state, "pending");
    assert.equal(updates[0].values.attempts, 0);
    assert.equal(updates[0].values.lastError, null);
  });

  test("it says the provider will not send it twice", async () => {
    /*
      The case that makes retries frightening — a provider that accepted the
      message and whose acceptance we failed to record — is covered by the
      stable provider idempotency key, and the operator is told so rather than
      left to worry.
    */
    const result = await retryFailedNotification({
      id: "row-1",
      actorUserId: "u-1",
    });
    assert.match(result.ok ? result.message : "", /not send it twice/i);
  });

  test("who did it, and what it had failed with, are recorded", async () => {
    await retryFailedNotification({ id: "row-1", actorUserId: "u-1" });

    const [entry] = audits;
    assert.equal(entry.kind, "notification.retried");
    // The reason is kept before it is cleared, or the history loses it.
    assert.deepEqual(entry.detail, {
      kind: "tenant.invitation",
      previousError: "unknown",
      previousAttempts: 5,
    });
  });
});

describe("what cannot be retried", () => {
  test("a message the provider accepted", async () => {
    rows = [{ ...FAILED, state: "sent", lastError: null }];
    const result = await retryFailedNotification({
      id: "row-1",
      actorUserId: "u-1",
    });

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /already accepted/i);
    // Nothing is written, so an accepted message is never made to look unsent.
    assert.equal(updates.length, 0);
  });

  test("a message that is still queued", async () => {
    rows = [{ ...FAILED, state: "pending", attempts: 2 }];
    const result = await retryFailedNotification({
      id: "row-1",
      actorUserId: "u-1",
    });

    assert.equal(result.ok, false);
    assert.equal(updates.length, 0);
  });

  test("a message that was stood down deliberately", async () => {
    rows = [
      {
        ...FAILED,
        state: "cancelled",
        lastError: "superseded_by_appointment_change",
      },
    ];
    const result = await retryFailedNotification({
      id: "row-1",
      actorUserId: "u-1",
    });

    assert.equal(result.ok, false);
    assert.equal(updates.length, 0);
  });

  test("a message that does not exist", async () => {
    rows = [];
    const result = await retryFailedNotification({
      id: "row-1",
      actorUserId: "u-1",
    });

    assert.equal(result.ok, false);
    assert.equal(updates.length, 0);
    assert.equal(audits.length, 0);
  });
});

describe("two administrators pressing it at once", () => {
  test("the loser is told the row moved, and nothing is written twice", async () => {
    /*
      The condition is in the WHERE rather than checked first and written
      second, so the database arbitrates. The loser matches no rows.
    */
    updateMatches = 0;
    const result = await retryFailedNotification({
      id: "row-1",
      actorUserId: "u-2",
    });

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /moved while you were looking/i);
    // No audit entry for a retry that did not happen.
    assert.equal(audits.length, 0);
  });
});

describe("when the database cannot be read", () => {
  test("it refuses rather than writing on a guess", async () => {
    failRead = true;
    const result = await retryFailedNotification({
      id: "row-1",
      actorUserId: "u-1",
    });

    assert.equal(result.ok, false);
    assert.equal(updates.length, 0);
  });
});
