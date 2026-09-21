import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  PROVIDER_IDEMPOTENCY_HOURS,
  QUEUE_STATE_LABELS,
  canRetry,
  describeError,
  isMissingRecipient,
  queueStateOf,
  retryDuplicationRisk,
  retryOutlook,
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

// ---------------------------------------------------------------------------
// What a retry may promise
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const NOW_RETRY = new Date("2026-09-22T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW_RETRY.getTime() - hours * HOUR);

describe("the evidence a retry's promise can rest on", () => {
  test("a message queued within the window may be deduplicated, but only may", () => {
    const risk = retryDuplicationRisk({
      kind: "tenant-appointment-confirmation",
      createdAt: hoursAgo(2),
      now: NOW_RETRY,
    });
    assert.equal(risk, "window_open_content_unknown");
  });

  test("a message queued beyond the window promises nothing", () => {
    const risk = retryDuplicationRisk({
      kind: "tenant-appointment-confirmation",
      createdAt: hoursAgo(PROVIDER_IDEMPOTENCY_HOURS + 1),
      now: NOW_RETRY,
    });
    assert.equal(risk, "window_may_have_passed");
  });

  test("an OLD original with a RECENT local update is still old", () => {
    /*
      **The defect.** The risk was read off `updatedAt`, which moves on every
      claim, every failed attempt and the retry itself — so a message whose
      first attempt was a fortnight ago reported as freshly attempted, and the
      more it had been retried the more confident the sentence became. The bound
      is `createdAt`: the first attempt cannot have preceded the intent.
    */
    const risk = retryDuplicationRisk({
      kind: "tenant-appointment-confirmation",
      createdAt: hoursAgo(14 * 24),
      now: NOW_RETRY,
    });
    assert.equal(risk, "window_may_have_passed");
  });

  test("repeated manual retries do not make the promise stronger", () => {
    // Whatever has happened locally since, the queueing time is fixed.
    const old = { kind: "invoice-issue", createdAt: hoursAgo(72) };
    const first = retryDuplicationRisk({ ...old, now: NOW_RETRY });
    const second = retryDuplicationRisk({
      ...old,
      now: new Date(NOW_RETRY.getTime() + HOUR),
    });
    const third = retryDuplicationRisk({
      ...old,
      now: new Date(NOW_RETRY.getTime() + 5 * HOUR),
    });

    assert.equal(first, "window_may_have_passed");
    assert.equal(second, "window_may_have_passed");
    assert.equal(third, "window_may_have_passed");
  });

  test("the boundary itself is treated as possibly passed", () => {
    // Exactly 24 hours is not inside the window.
    assert.equal(
      retryDuplicationRisk({
        kind: "invoice-issue",
        createdAt: hoursAgo(PROVIDER_IDEMPOTENCY_HOURS),
        now: NOW_RETRY,
      }),
      "window_may_have_passed",
    );
  });
});

describe("the sentence a retry shows", () => {
  test("never promises that a second copy will not happen", () => {
    for (const kind of [
      "tenant-appointment-confirmation",
      "invoice-issue",
      "certificate-release",
      "tenant-scheduling-invitation",
      "account-invitation",
      "account-password-reset",
    ]) {
      for (const hours of [1, 12, 25, 400]) {
        const sentence = retryOutlook({
          kind,
          createdAt: hoursAgo(hours),
          now: NOW_RETRY,
        });
        assert.equal(
          /will not (be sent|send|get|produce)|never (be sent|duplicate)|exactly once|guaranteed/i.test(
            sentence,
          ),
          false,
          `${kind} at ${hours}h: ${sentence}`,
        );
      }
    }
  });

  test("an uncertain payload is said to be uncertain", () => {
    const sentence = retryOutlook({
      kind: "tenant-appointment-confirmation",
      createdAt: hoursAgo(2),
      now: NOW_RETRY,
    });
    assert.match(sentence, /unlikely/i);
    assert.match(sentence, /not impossible|identical/i);
  });

  test("a scheduling link says every link still works until it expires", () => {
    /*
      `access.ts` accepts any unexpired, unrevoked token and using one does not
      revoke the others. The old sentence said only the newest link worked,
      which would have had somebody tell a tenant to ignore a link that works.
    */
    const sentence = retryOutlook({
      kind: "tenant-scheduling-invitation",
      createdAt: hoursAgo(1),
      now: NOW_RETRY,
    });
    assert.match(sentence, /every link still works/i);
    assert.match(sentence, /expires/i);
    assert.equal(/only the newer|only the newest/i.test(sentence), false);
  });

  test("an account link says the others retire when one is used", () => {
    /*
      `credentials.ts` deliberately does not revoke earlier credentials on
      minting; redeeming any one revokes the rest in the same statement.
    */
    for (const kind of ["account-invitation", "account-password-reset"]) {
      const sentence = retryOutlook({
        kind,
        createdAt: hoursAgo(1),
        now: NOW_RETRY,
      });
      assert.match(sentence, /every link still works/i);
      assert.match(sentence, /until one of them is used/i);
      assert.equal(/only the newer|only the newest/i.test(sentence), false);
    }
  });

  test("a credential message is never described as deduplicated", () => {
    // Its key differs by construction, so the provider has nothing to match.
    const sentence = retryOutlook({
      kind: "account-invitation",
      createdAt: hoursAgo(1),
      now: NOW_RETRY,
    });
    assert.equal(/provider should still recognise/i.test(sentence), false);
  });
});
