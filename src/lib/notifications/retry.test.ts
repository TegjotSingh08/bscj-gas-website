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
  kind: "tenant-scheduling-invitation",
  state: "failed",
  lastError: "unknown",
  attempts: 5,
  createdAt: new Date(),
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

  test("it states the duplication risk that actually applies", async () => {
    /*
      **The promise this replaces was false.** It said "the provider will not
      send it twice if it already accepted it" — true only for a message whose
      content has not changed, retried inside the provider's 24-hour window.
      This fixture is a tenant invitation, which mints a new link every attempt,
      so the honest answer is the opposite one.
    */
    const result = await retryFailedNotification({
      id: "row-1",
      actorUserId: "u-1",
    });

    assert.match(result.ok ? result.message : "", /mints a new one/i);
    // Earlier links stay valid — `access.ts` accepts any unexpired token.
    assert.match(result.ok ? result.message : "", /every link still works/i);
    assert.equal(/not send it twice/i.test(result.ok ? result.message : ""), false);
  });

  test("a message queued recently is described as unlikely to duplicate, not certain", async () => {
    rows = [
      {
        ...FAILED,
        kind: "tenant-appointment-confirmation",
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    ];
    const result = await retryFailedNotification({
      id: "row-1",
      actorUserId: "u-1",
    });

    assert.match(result.ok ? result.message : "", /unlikely/i);
    assert.match(result.ok ? result.message : "", /not impossible/i);
  });

  test("a message queued beyond the window is described as possibly duplicating", async () => {
    rows = [
      {
        ...FAILED,
        kind: "tenant-appointment-confirmation",
        createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
      },
    ];
    const result = await retryFailedNotification({
      id: "row-1",
      actorUserId: "u-1",
    });

    assert.match(result.ok ? result.message : "", /second copy/i);
    assert.match(result.ok ? result.message : "", /may no longer recognise/i);
  });

  test("a long-queued message that was retried a minute ago is still described as old", async () => {
    /*
      The regression that matters: reading the risk off `updatedAt` made a
      fortnight-old message look freshly attempted, and each retry made the
      sentence more confident.
    */
    rows = [
      {
        ...FAILED,
        kind: "tenant-appointment-confirmation",
        createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
    ];
    const result = await retryFailedNotification({
      id: "row-1",
      actorUserId: "u-1",
    });

    assert.match(result.ok ? result.message : "", /may no longer recognise/i);
  });

  test("no message anywhere claims exactly-once delivery", async () => {
    for (const kind of ["tenant-scheduling-invitation", "tenant-appointment-confirmation", "invoice-issue"]) {
      rows = [{ ...FAILED, kind, createdAt: new Date() }];
      const result = await retryFailedNotification({ id: "row-1", actorUserId: "u-1" });
      const message = result.ok ? result.message : "";
      assert.equal(/exactly once|guaranteed|never duplicate/i.test(message), false, kind);
    }
  });

  test("who did it, and what it had failed with, are recorded", async () => {
    await retryFailedNotification({ id: "row-1", actorUserId: "u-1" });

    const [entry] = audits;
    assert.equal(entry.kind, "notification.retried");
    // The reason is kept before it is cleared, or the history loses it.
    assert.deepEqual(entry.detail, {
      kind: "tenant-scheduling-invitation",
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
