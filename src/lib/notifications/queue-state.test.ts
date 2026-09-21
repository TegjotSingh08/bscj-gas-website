import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  QUEUE_STATE_LABELS,
  canRetry,
  describeError,
  isMissingRecipient,
  queueStateOf,
  type QueueRowInput,
} from "./queue-state";
import { LEASE_SECONDS } from "./outbox";

/**
 * What an operator is told about a message that has not gone.
 *
 * The pilot failure these exist for: a green dashboard over an undrained
 * queue, where the only way to find out why was a browser console.
 */

const NOW = new Date("2026-09-22T12:00:00.000Z");
const opts = { leaseSeconds: LEASE_SECONDS, now: NOW };

const row = (overrides: Partial<QueueRowInput> = {}): QueueRowInput => ({
  state: "pending",
  attempts: 0,
  lastError: null,
  updatedAt: new Date("2026-09-22T11:00:00.000Z"),
  ...overrides,
});

describe("what state a message is actually in", () => {
  test("queued and never attempted", () => {
    assert.equal(queueStateOf(row(), opts), "queued");
  });

  test("a claimed row inside its lease is being sent right now", () => {
    /*
      The distinction the counts could not make: "nothing is happening" and
      "something is happening this second" both read as `pending`.
    */
    const claimed = row({
      attempts: 1,
      updatedAt: new Date(NOW.getTime() - 10_000),
    });
    assert.equal(queueStateOf(claimed, opts), "attempting");
  });

  test("a row whose lease has run out is waiting for another attempt", () => {
    const stale = row({
      attempts: 2,
      updatedAt: new Date(NOW.getTime() - (LEASE_SECONDS + 1) * 1000),
    });
    assert.equal(queueStateOf(stale, opts), "retrying");
  });

  test("the lease boundary itself is past, not held", () => {
    const exactly = row({
      attempts: 1,
      updatedAt: new Date(NOW.getTime() - LEASE_SECONDS * 1000),
    });
    assert.equal(queueStateOf(exactly, opts), "retrying");
  });

  test("a crashed worker's row becomes eligible again on its own", () => {
    // No cleanup job: the lease simply expires and the next drain takes it.
    const abandoned = row({
      attempts: 1,
      updatedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    assert.equal(queueStateOf(abandoned, opts), "retrying");
  });

  test("a missing address is its own state, not an ordinary failure", () => {
    /*
      Retrying this forever changes nothing. It wants somebody to add an email
      address, which is a different action from "try again".
    */
    const noAddress = row({ attempts: 3, lastError: "tenant_email_missing" });
    assert.equal(queueStateOf(noAddress, opts), "needs_information");
  });

  test("a missing address is still called out once the row has given up", () => {
    const noAddress = row({
      state: "failed",
      attempts: 5,
      lastError: "agent_email_missing",
    });
    // Stored as failed, and the operator is told which kind of failure it is.
    assert.equal(queueStateOf(noAddress, opts), "failed");
    assert.equal(isMissingRecipient(noAddress.lastError), true);
  });

  test("provider acceptance is never called delivery", () => {
    const accepted = row({ state: "sent", attempts: 1 });
    assert.equal(queueStateOf(accepted, opts), "accepted");
    assert.match(QUEUE_STATE_LABELS.accepted, /accepted by the email provider/i);
    assert.equal(/delivered|inbox|received/i.test(QUEUE_STATE_LABELS.accepted), false);
  });

  test("a stood-down message is not a failure", () => {
    const cancelled = row({
      state: "cancelled",
      lastError: "superseded_by_appointment_change",
    });
    assert.equal(queueStateOf(cancelled, opts), "cancelled");
  });

  test("a terminal failure says a person is needed", () => {
    const failed = row({ state: "failed", attempts: 5, lastError: "unknown" });
    assert.equal(queueStateOf(failed, opts), "failed");
    assert.match(QUEUE_STATE_LABELS.failed, /needs a person/i);
  });
});

describe("what an operator may do about it", () => {
  test("only a terminal failure can be put back", () => {
    assert.equal(canRetry("failed"), true);
  });

  test("a queued or in-flight message is left alone", () => {
    // Touching it would either do nothing or reset a lease somebody holds.
    assert.equal(canRetry("queued"), false);
    assert.equal(canRetry("attempting"), false);
    assert.equal(canRetry("retrying"), false);
  });

  test("an accepted message is never offered a retry", () => {
    // It cannot be recalled, and it must never be made to look unsent.
    assert.equal(canRetry("accepted"), false);
  });

  test("a message waiting for an address is not offered one either", () => {
    // It would land in exactly the same place; the fix is an address.
    assert.equal(canRetry("needs_information"), false);
  });

  test("a stood-down message is not offered one", () => {
    assert.equal(canRetry("cancelled"), false);
  });
});

describe("the reason, in words that name an action", () => {
  test("a missing address names whose", () => {
    assert.match(describeError("tenant_email_missing") ?? "", /tenant/i);
    assert.match(describeError("agent_email_missing") ?? "", /agent/i);
    assert.match(describeError("customer_email_missing") ?? "", /customer/i);
  });

  test("a configuration gap says it is configuration", () => {
    assert.match(describeError("transport_not_configured") ?? "", /not configured/i);
    assert.match(describeError("app_origin_not_configured") ?? "", /origin/i);
  });

  test("an address changed after approval explains why nothing was sent", () => {
    const message = describeError("approved_address_changed") ?? "";
    assert.match(message, /changed after/i);
    assert.match(message, /approve it again/i);
  });

  test("an unrecognised code is reported as unrecognised, not guessed at", () => {
    /*
      Inventing a friendly sentence for a reason nobody has seen is how an
      operator is sent in the wrong direction. The code is kept so it can be
      searched for.
    */
    const message = describeError("some_new_reason") ?? "";
    assert.match(message, /some_new_reason/);
    assert.match(message, /logs/i);
  });

  test("nothing raw and unbounded reaches the screen", () => {
    const hostile = `x`.repeat(500) + " user@private.example.invalid";
    const message = describeError(hostile) ?? "";
    assert.ok(message.length < 140);
    assert.equal(message.includes("user@private.example.invalid"), false);
  });

  test("no reason at all is no sentence at all", () => {
    assert.equal(describeError(null), null);
    assert.equal(describeError(""), null);
  });
});
