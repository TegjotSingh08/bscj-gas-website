import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  connect,
  reset,
  start,
  stop,
  type Connection,
} from "../support/disposable-postgres";
import { seed, type Fixture } from "../support/fixtures";

/**
 * A failed attempt, a recovery, and a successful attempt — through the real
 * worker, against the real database.
 *
 * **Every provider operation is captured locally.** The transport is replaced
 * at its own boundary with a recorder that behaves the way Resend documents:
 * it keeps idempotency keys for 24 hours, returns the original response for a
 * repeat of the same key with the same payload, and refuses a repeat with a
 * *different* payload. Nothing leaves this process, and no address here can
 * receive mail.
 *
 * What the recorder makes visible is the thing the previous wording got wrong:
 * which retries the provider would actually deduplicate, and which it would
 * refuse outright.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type Sent = { key: string; to: string; subject: string; body: string };

/** Everything the worker asked the provider to do. */
let sent: Sent[] = [];
/** Keys the fake provider currently remembers, with the payload they carried. */
let remembered = new Map<string, { body: string; at: number }>();
/** Forced outcomes, by the number of the call. */
let outcomes: ("ok" | "timeout" | "rejected")[] = [];
let call = 0;
let clock = Date.now();

mock.module("@/lib/email/send", {
  namedExports: {
    /**
     * Resend, as documented, in miniature.
     *
     * Only the behaviour that matters here: key retention, same-payload
     * de-duplication, and the 409 on a changed payload.
     */
    sendOutboxEmail: async (input: {
      kind: string;
      to: string;
      email: { subject: string; html: string; text: string };
      reference: string;
      idempotencySuffix: string;
    }) => {
      call += 1;
      const forced = outcomes[call - 1] ?? "ok";
      const key = `${input.kind}-${input.reference}-${input.idempotencySuffix}`;
      const body = `${input.to}|${input.email.subject}|${input.email.text}`;

      // Expire anything older than the retention window.
      for (const [held, value] of remembered) {
        if (clock - value.at >= DAY_MS) remembered.delete(held);
      }

      const previous = remembered.get(key);
      if (previous) {
        if (previous.body !== body) {
          // 409 invalid_idempotent_request.
          return { status: "failed", reason: "idempotency_conflict" };
        }
        // The original response, without sending again.
        return { status: "sent", id: "deduplicated" };
      }

      if (forced === "timeout") {
        /*
          The ambiguous outcome: the provider may or may not have taken it. The
          real one remembers the key either way, which is what makes the retry
          safe — so the recorder does too.
        */
        remembered.set(key, { body, at: clock });
        return { status: "failed", reason: "timeout" };
      }
      if (forced === "rejected") {
        return { status: "failed", reason: "rejected" };
      }

      remembered.set(key, { body, at: clock });
      sent.push({ key, to: input.to, subject: input.email.subject, body });
      return { status: "sent", id: `msg-${sent.length}` };
    },
    internalNotificationRecipient: () => "bscj@fixture.example.invalid",
    // Unchanged from production; the recorder replaces only the transport.
    MAX_ATTACHMENT_BYTES: 15 * 1024 * 1024,
  },
});

mock.module("@/lib/config/origin", {
  namedExports: {
    resolveAppOrigin: () => ({ ok: true, origin: "https://fixture.example.invalid" }),
  },
});

const { drainOutbox, retryFailedNotification, MAX_ATTEMPTS, LEASE_SECONDS } =
  await import("../../src/lib/notifications/outbox");
const { setDbForTesting } = await import("../../src/lib/db/client");

let conn: Connection;
let fixture: Fixture;

before(async () => {
  await start();
  conn = await connect();
  setDbForTesting(conn.db as never);
});

after(async () => {
  setDbForTesting(null);
  await stop();
});

beforeEach(async () => {
  await reset(conn);
  fixture = await seed(conn);
  sent = [];
  remembered = new Map();
  outcomes = [];
  call = 0;
  clock = Date.now();
});

/** Queues a tenant invitation for the fixture job, exactly as the app does. */
async function queueInvitation(): Promise<string> {
  const { rows } = await conn.client.query<{ id: string }>(
    `insert into outbound_email
       (job_id, kind, recipient, idempotency_key, state, attempts)
     values ($1, 'tenant-scheduling-invitation', 'tenant', $2, 'pending', 0)
     returning id`,
    [fixture.jobId, `tenant-scheduling-invitation:${fixture.jobId}:${new Date().toISOString()}`],
  );
  // The invitation addresses the tenancy the **job** points at.
  await attachTenancy();
  await conn.client.query(
    "update job set lifecycle_status = 'awaiting_tenant' where id = $1",
    [fixture.jobId],
  );
  return rows[0].id;
}

async function row(id: string) {
  const { rows } = await conn.client.query<{
    state: string;
    attempts: number;
    last_error: string | null;
    sent_at: Date | null;
    updated_at: Date;
  }>(
    `select state, attempts, last_error, sent_at, updated_at
       from outbound_email where id = $1`,
    [id],
  );
  return rows[0];
}

describe("a failed attempt, then a successful one", () => {
  test("a transient failure leaves it queued and tries again next pass", async () => {
    const id = await queueInvitation();
    outcomes = ["rejected"];

    const first = await drainOutbox();
    assert.equal(first.claimed, 1);
    assert.equal(first.stillQueued, 1);

    const afterFirst = await row(id);
    assert.equal(afterFirst.state, "pending");
    assert.equal(afterFirst.attempts, 1);
    assert.equal(afterFirst.last_error, "rejected");
    assert.equal(sent.length, 0);

    /*
      The lease has to expire before the row is eligible again — that is what
      stops two workers sending the same message, and it doubles as backoff.
    */
    await expireLease(id);

    const second = await drainOutbox();
    assert.equal(second.accepted, 1);

    const afterSecond = await row(id);
    assert.equal(afterSecond.state, "sent");
    assert.ok(afterSecond.sent_at);
    assert.equal(afterSecond.last_error, null);
    assert.equal(sent.length, 1);
  });

  test("a message that has given up can be retried and then succeeds", async () => {
    const id = await queueInvitation();
    outcomes = Array.from({ length: MAX_ATTEMPTS }, () => "rejected" as const);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await drainOutbox();
      await expireLease(id);
    }

    const exhausted = await row(id);
    assert.equal(exhausted.state, "failed");
    assert.equal(exhausted.attempts, MAX_ATTEMPTS);
    assert.equal(sent.length, 0);

    // The operator's recovery action.
    outcomes = [];
    call = 0;
    const retry = await retryFailedNotification({
      id,
      actorUserId: fixture.adminUserId,
    });
    assert.equal(retry.ok, true);

    const queued = await row(id);
    assert.equal(queued.state, "pending");
    assert.equal(queued.attempts, 0);

    await drainOutbox();
    const delivered = await row(id);
    assert.equal(delivered.state, "sent");
    assert.equal(sent.length, 1);
  });

  test("the retry is recorded against the person who pressed it", async () => {
    const id = await queueInvitation();
    outcomes = Array.from({ length: MAX_ATTEMPTS }, () => "rejected" as const);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await drainOutbox();
      await expireLease(id);
    }

    await retryFailedNotification({ id, actorUserId: fixture.adminUserId });

    const { rows } = await conn.client.query<{ kind: string; detail: unknown }>(
      `select kind, detail from audit_event where kind = 'notification.retried'`,
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].detail, {
      kind: "tenant-scheduling-invitation",
      previousError: "rejected",
      previousAttempts: MAX_ATTEMPTS,
    });
  });
});

describe("the retry no longer collides with its own past key", () => {
  test("resetting the attempt count does not reuse an old key on new content", async () => {
    /*
      **The defect.** The invitation's provider key used to be derived from the
      attempt number, and each attempt mints a new link. Resetting the count to
      zero therefore sent attempt 1's *key* with attempt 6's *content* — which
      the provider refuses for 24 hours (409 `invalid_idempotent_request`). The
      message never went, and the operator had been told it would not be sent
      twice.

      The key is now derived from the minted credential, so it moves with the
      content by construction.
    */
    const id = await queueInvitation();
    outcomes = Array.from({ length: MAX_ATTEMPTS }, () => "rejected" as const);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await drainOutbox();
      await expireLease(id);
    }

    outcomes = [];
    call = 0;
    await retryFailedNotification({ id, actorUserId: fixture.adminUserId });
    await drainOutbox();

    const after = await row(id);
    assert.equal(
      after.last_error,
      null,
      "a key collision would have left idempotency_conflict here",
    );
    assert.equal(after.state, "sent");
    assert.equal(sent.length, 1);
  });

  test("every attempt used a different key, because every attempt had a different link", async () => {
    const id = await queueInvitation();
    outcomes = ["timeout", "timeout"];

    await drainOutbox();
    await expireLease(id);
    await drainOutbox();

    const keys = [...remembered.keys()];
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
  });
});

describe("an ambiguous outcome", () => {
  test("a timeout after the provider took it does not send a second copy", async () => {
    /*
      The case that makes retries frightening: the provider accepted it and our
      status write did not land. The key is remembered either way, so the next
      attempt is recognised — for a message whose content has not changed.
    */
    const id = await queueConfirmation();
    outcomes = ["timeout"];

    await drainOutbox();
    assert.equal((await row(id)).last_error, "timeout");
    assert.equal(sent.length, 0, "nothing was actually delivered on the timeout");

    await expireLease(id);
    outcomes = [];
    await drainOutbox();

    const after = await row(id);
    assert.equal(after.state, "sent");
    // Deduplicated by the provider: accepted, but not a second message.
    assert.equal(sent.length, 0);
  });

  test("and after the provider forgets the key, a retry does produce a second copy", async () => {
    /*
      The honest limit of the guarantee, and why the wording says so. Twenty-five
      hours later the key means nothing to the provider.
    */
    const id = await queueConfirmation();
    outcomes = ["timeout"];
    await drainOutbox();

    clock += 25 * 60 * 60 * 1000;
    await expireLease(id);
    outcomes = [];
    await drainOutbox();

    assert.equal((await row(id)).state, "sent");
    assert.equal(sent.length, 1, "the provider no longer recognises the key");
  });
});

describe("overlapping drains and the lease", () => {
  test("two drains at once claim the row once between them", async () => {
    const id = await queueInvitation();

    const [a, b] = await Promise.all([drainOutbox(), drainOutbox()]);
    assert.equal(a.claimed + b.claimed, 1, "exactly one worker takes it");
    assert.equal(sent.length, 1);
    assert.equal((await row(id)).state, "sent");
  });

  test("a row inside its lease is passed over", async () => {
    const id = await queueInvitation();
    outcomes = ["rejected"];
    await drainOutbox();

    // Still within the lease: the next pass must not touch it.
    const immediate = await drainOutbox();
    assert.equal(immediate.claimed, 0);
    assert.equal((await row(id)).attempts, 1);
  });

  test("a row whose lease has expired is picked up again", async () => {
    const id = await queueInvitation();
    outcomes = ["rejected"];
    await drainOutbox();
    await expireLease(id);

    const later = await drainOutbox();
    assert.equal(later.claimed, 1);
  });
});

describe("a message with nobody to send to", () => {
  test("is held for information rather than retried to exhaustion", async () => {
    const id = await queueInvitation();
    // Remove the address the invitation was going to use.
    await conn.client.query("update tenancy set email = null where property_id = $1", [
      fixture.propertyId,
    ]);

    const report = await drainOutbox();
    assert.equal(report.missingRecipient, 1);

    const after = await row(id);
    assert.equal(after.last_error, "tenant_email_missing");
    assert.equal(after.state, "pending");
    assert.equal(sent.length, 0);
  });
});

/** A tenancy on the property, pointed at by the job — which is how it is found. */
async function attachTenancy() {
  const { rows } = await conn.client.query<{ id: string }>(
    `insert into tenancy (property_id, name, email)
     values ($1, 'Tom Tenant', 'tom@fixture.example.invalid') returning id`,
    [fixture.propertyId],
  );
  await conn.client.query("update job set tenancy_id = $2 where id = $1", [
    fixture.jobId,
    rows[0].id,
  ]);
  return rows[0].id;
}

/** Moves the row's lease into the past, as the passage of time would. */
async function expireLease(id: string) {
  await conn.client.query(
    `update outbound_email
        set updated_at = now() - interval '${LEASE_SECONDS * 2} seconds'
      where id = $1`,
    [id],
  );
}

/** An appointment confirmation: stable key, stable content. */
async function queueConfirmation(): Promise<string> {
  const start = new Date("2026-10-02T09:30:00Z");
  /*
    `synced` because a confirmation is deliberately held until the appointment
    is actually in the calendar — telling somebody about a visit that is not in
    the diary is worse than telling them late.
  */
  await conn.client.query(
    `update job set appointment_start = $2, appointment_end = $3,
                    lifecycle_status = 'scheduled', calendar_sync_state = 'synced'
      where id = $1`,
    [fixture.jobId, start, new Date(start.getTime() + 45 * 60000)],
  );
  await attachTenancy();

  const { rows } = await conn.client.query<{ id: string }>(
    `insert into outbound_email
       (job_id, kind, recipient, idempotency_key, state, attempts)
     values ($1, 'tenant-appointment-confirmation', 'tenant', $2, 'pending', 0)
     returning id`,
    // `confirmationKey`: the worker stands down any confirmation whose key
    // does not name the appointment the job currently has.
    [fixture.jobId, `appointment:${fixture.jobId}:${start.toISOString()}`],
  );
  return rows[0].id;
}
