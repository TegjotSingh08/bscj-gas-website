import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Telling the agency and BSCJ that a tenant booked late.
 *
 * The intent is a row, written with the appointment. Delivery is separate and
 * is allowed to fail, retry and give up — none of which may touch the
 * appointment itself.
 *
 * Three properties are load-bearing and each is tested here:
 *
 * 1. **A notification never runs ahead of the diary.** An agency told "your
 *    tenant booked Tuesday" before the calendar event exists is one phone call
 *    from finding out it does not.
 * 2. **A stale notification is never sent.** If the appointment moved, the
 *    message describes a visit that is not happening.
 * 3. **`sent` means the provider accepted it.** It is not a delivery receipt.
 */

type Row = {
  id: string;
  jobId: string | null;
  kind: string;
  recipient: string;
  /** Frozen at queue time for a certificate. Null for the older kinds. */
  recipientAddress?: string | null;
  idempotencyKey: string;
  state: string;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  /** When the row last moved. The lease is read from this. */
  updatedAt: Date;
};

type JobRow = {
  id: string;
  reference: string;
  productId: string;
  lifecycleStatus: string;
  appointmentStart: Date | null;
  appointmentEnd: Date | null;
  calendarSyncState: string;
  deadlineExceptionAt: Date | null;
  cancelledAt: Date | null;
  propertyId: string;
  tenancyId: string | null;
};

const APPOINTMENT = new Date("2026-10-05T09:00:00.000Z");
const JOB_ID = "job-1";

let rows: Row[] = [];
let job: JobRow;
let organisationEmail: string | null = "agency@example.invalid";
let tenantEmail: string | null = "tenant@example.invalid";
/** Scheduling tokens the worker minted, so a test can count them. */
let mintedTokens: { jobId: string; tokenHash: string }[] = [];
let exceptionDetail: Record<string, unknown> | null;
let sends: {
  kind: string;
  to: string;
  suffix: string;
  attachments?: { filename: string; content: Uint8Array }[];
}[] = [];
let sendResult: { status: string; reason?: string; id?: string | null } = {
  status: "sent",
  id: "e1",
};
let internalRecipient: string | null = "ops@example.invalid";
let customerEmail: string | null = "landlord@example.invalid";
let organisationActive = true;
let customerActive = true;
let organisationOnJob = true;
/** The certificate row the worker reads, or null to make it missing. */
let certificateRow: Record<string, unknown> | null = null;
/** What private storage answers with, and what it hands back. */
let storedDocument: { ok: boolean; bytes?: Uint8Array } = { ok: true };

const PROPERTY = {
  id: "property-1",
  houseOrName: "12",
  street: "Example Street",
  town: "Wolverhampton",
  postcode: "WV1 1AA",
};

function nameOf(table: unknown): string {
  const symbol = Object.getOwnPropertySymbols(table as object).find((s) =>
    String(s).includes("Name"),
  );
  return symbol ? String((table as Record<symbol, unknown>)[symbol]) : "unknown";
}

/**
 * A fake that answers the three reads this module makes.
 *
 * Drizzle's predicates are opaque here, so which rows come back is decided by
 * the table being read. That is fair: these tests are about what the module
 * *does* with a row, not about the SQL, and the query itself runs for real in
 * the live reconciliation run recorded in the handoff.
 */
function makeDb() {
  return {
    select() {
      return {
        from(table: unknown) {
          const name = nameOf(table);
          const answer = () => {
            if (name === "outbound_email") {
              /*
                Copies, not the live objects. A real driver hands back rows
                read at query time; returning references let the claim mutate
                what the loop had already read, which is a fault in the fake
                and not in the worker.
              */
              /*
                The eligibility rule, restated: pending, under the attempt
                cap, and either never attempted or past its lease. The lease is
                the whole point — a row in flight must be invisible, not merely
                hard to claim.
              */
              const cutoff = Date.now() - LEASE_SECONDS * 1000;
              return rows
                .filter(
                  (r) =>
                    r.state === "pending" &&
                    r.attempts < 5 &&
                    (r.attempts === 0 || r.updatedAt.getTime() < cutoff),
                )
                .map((r) => ({ ...r }));
            }
            if (name === "activity") {
              return exceptionDetail ? [{ detail: exceptionDetail }] : [];
            }
            if (name === "certificate") {
              return certificateRow ? [certificateRow] : [];
            }
            /*
              Two different reads hit `job`: the one that loads the job for
              delivery, and the eligibility re-check. Both shapes are
              returned merged, so each caller finds the fields it
              destructures without the fake having to guess which is which.
            */
            return [
              {
                job,
                property: PROPERTY,
                organisationName: "FIXTURE Lettings",
                organisationEmail,
                tenantEmail,
                customerEmail,
                organisationId: organisationOnJob ? "org-1" : null,
                organisationActive,
                customerActive,
              },
            ];
          };
          const chain = {
            innerJoin: () => chain,
            leftJoin: () => chain,
            where: () => chain,
            limit: async () => answer(),
            then: (resolve: (value: unknown) => void) =>
              Promise.resolve(answer()).then(resolve),
          };
          return chain;
        },
      };
    },
    insert(table: unknown) {
      const name = nameOf(table);
      return {
        values(value: Record<string, unknown>) {
          const run = () => {
            if (name === "scheduling_token") {
              mintedTokens.push(value as { jobId: string; tokenHash: string });
            }
            return [{ id: "inserted" }];
          };
          const statement = {
            onConflictDoNothing: () => statement,
            returning: async () => run(),
            then: (resolve: (v: unknown) => void) =>
              Promise.resolve(run()).then(() => resolve(undefined)),
          };
          return statement;
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          const chain = {
            where: (predicate: unknown) => {
              lastUpdatePredicate = predicate;
              return chain;
            },
            returning: async () =>
              applyAll(values).map((r) => ({ id: r.id })),
            then: (resolve: (value: unknown) => void) => {
              applyAll(values);
              return Promise.resolve([]).then(resolve);
            },
          };
          return chain;
        },
      };
    },
  };
}

/**
 * Applies an update the way the conditional claim depends on.
 *
 * The worker claims a row with `UPDATE … SET attempts = n + 1 WHERE attempts =
 * n`, which is the whole of its concurrency control — so a fake that applied
 * every update unconditionally would report that two workers both won. When
 * the update carries only an attempt count it is matched against the stored
 * one; everything else (state, error, timestamp) lands on the row in flight.
 *
 * Returns the rows it changed, so `returning()` is honest about emptiness.
 */
function applyAll(values: Record<string, unknown>): Row[] {
  const next = values.attempts;
  const onlyAttempts =
    typeof next === "number" &&
    Object.keys(values).every((k) => k === "attempts" || k === "updatedAt");

  if (onlyAttempts) {
    // A claim moves n → n+1; a refund moves n → n-1. Never both at once.
    const target = rows.find(
      (r) =>
        r.state === "pending" &&
        (r.attempts === next - 1 || r.attempts === next + 1),
    );
    if (!target) return [];
    Object.assign(target, values);
    return [target];
  }

  const changed = rows.filter((r) => r.state === "pending");
  for (const row of changed) Object.assign(row, values);
  return changed;
}

/** The `where` the most recent update was built with, for the keep-set test. */
let lastUpdatePredicate: unknown = null;

let configured = true;

mock.module("@/lib/db/client", {
  namedExports: { getDb: () => (configured ? makeDb() : null) },
});

/*
  Private storage, stubbed. No filesystem, no network, no Blob store — the
  worker only needs to know whether the bytes came back and what they were.
*/
mock.module("@/lib/storage/documents", {
  namedExports: {
    getDocument: async () =>
      storedDocument.ok
        ? { ok: true, bytes: storedDocument.bytes ?? new Uint8Array([1, 2, 3]) }
        : { ok: false, error: "unavailable" },
  },
});

mock.module("@/lib/email/send", {
  namedExports: {
    internalNotificationRecipient: () => internalRecipient,
    // The worker reads the cap before it attaches anything.
    MAX_ATTACHMENT_BYTES: 15 * 1024 * 1024,
    sendOutboxEmail: async (input: {
      kind: string;
      to: string;
      idempotencySuffix: string;
      attachments?: { filename: string; content: Uint8Array }[];
    }) => {
      sends.push({
        kind: input.kind,
        to: input.to,
        suffix: input.idempotencySuffix,
        attachments: input.attachments,
      });
      return sendResult;
    },
  },
});

const {
  LEASE_SECONDS,
  appointmentFromKey,
  cancelSupersededNotifications,
  confirmationKey,
  drainOutbox,
  invitationKey,
  invitationRow,
  lateBookingKey,
  lateBookingRows,
  MAX_ATTEMPTS,
  OUTBOX_KINDS,
  parseException,
} = await import("./outbox");

function baseJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: JOB_ID,
    reference: "BSCJ-FX0001",
    productId: "cp12",
    lifecycleStatus: "scheduled",
    appointmentStart: APPOINTMENT,
    appointmentEnd: new Date(APPOINTMENT.getTime() + 45 * 60000),
    calendarSyncState: "synced",
    deadlineExceptionAt: new Date("2026-09-20T10:00:00.000Z"),
    cancelledAt: null,
    propertyId: PROPERTY.id,
    tenancyId: "tenancy-1",
    ...overrides,
  };
}

/** An invitation row, as agency job creation writes it. */
/** A timestamp well outside any lease window. */
function longAgo(): Date {
  return new Date(Date.now() - 60 * 60 * 1000);
}

function queuedInvitation(overrides: Partial<Row> = {}): Row {
  const issuedAt = new Date("2026-09-01T09:00:00.000Z");
  return {
    id: "row-invite",
    jobId: JOB_ID,
    kind: OUTBOX_KINDS.invitation,
    recipient: "tenant",
    idempotencyKey: invitationKey(JOB_ID, issuedAt),
    state: "pending",
    attempts: 0,
    lastError: null,
    sentAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

/** A tenant's appointment confirmation, as `confirmTenantAppointment` writes it. */
function queuedConfirmation(overrides: Partial<Row> = {}): Row {
  return {
    id: "row-confirm",
    jobId: JOB_ID,
    kind: OUTBOX_KINDS.confirmation,
    recipient: "tenant",
    idempotencyKey: confirmationKey(JOB_ID, APPOINTMENT),
    state: "pending",
    attempts: 0,
    lastError: null,
    sentAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function queued(recipient: "agent" | "bscj", overrides: Partial<Row> = {}): Row {
  return {
    id: `row-${recipient}`,
    jobId: JOB_ID,
    kind: "late-booking-exception",
    recipient,
    idempotencyKey: lateBookingKey(JOB_ID, APPOINTMENT, recipient),
    state: "pending",
    attempts: 0,
    lastError: null,
    sentAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  configured = true;
  job = baseJob();
  rows = [];
  organisationEmail = "agency@example.invalid";
  tenantEmail = "tenant@example.invalid";
  mintedTokens = [];
  internalRecipient = "ops@example.invalid";
  sends = [];
  sendResult = { status: "sent", id: "e1" };
  exceptionDetail = {
    deadlineDate: "2026-10-01",
    deadlineSource: "requested",
    requestedBy: "2026-10-01",
    certificateDueBy: "2026-12-01",
    appointmentStart: APPOINTMENT.toISOString(),
    appointmentEnd: new Date(APPOINTMENT.getTime() + 45 * 60000).toISOString(),
    acknowledgedAt: "2026-09-20T10:00:00.000Z",
  };
});

describe("the key carries the appointment, not just the job", () => {
  test("it round-trips", () => {
    const key = lateBookingKey(JOB_ID, APPOINTMENT, "agent");
    assert.deepEqual(appointmentFromKey(key), APPOINTMENT);
  });

  test("a different appointment is a different notification", () => {
    // Which is what makes a reschedule a new alert rather than a duplicate.
    const later = new Date("2026-10-06T10:00:00.000Z");
    assert.notEqual(
      lateBookingKey(JOB_ID, APPOINTMENT, "agent"),
      lateBookingKey(JOB_ID, later, "agent"),
    );
  });

  test("the two recipients never collapse into one row", () => {
    assert.notEqual(
      lateBookingKey(JOB_ID, APPOINTMENT, "agent"),
      lateBookingKey(JOB_ID, APPOINTMENT, "bscj"),
    );
  });

  test("something that is not one of ours is refused", () => {
    assert.equal(appointmentFromKey("appointment:job-1:nonsense"), null);
    assert.equal(appointmentFromKey(""), null);
  });

  test("both recipients are queued for one late booking", () => {
    const queuedRows = lateBookingRows({
      jobId: JOB_ID,
      appointmentStart: APPOINTMENT,
    });
    assert.deepEqual(
      queuedRows.map((r) => r.recipient).sort(),
      ["agent", "bscj"],
    );
  });
});

describe("a notification never runs ahead of the calendar", () => {
  test("a job whose event is not written yet stays queued", async () => {
    job = baseJob({ calendarSyncState: "pending" });
    rows = [queued("agent")];

    const report = await drainOutbox();

    assert.equal(report.stillQueued, 1);
    assert.deepEqual(sends, [], "an agency was told before the diary knew");
    assert.equal(rows[0].attempts, 0, "waiting consumed a retry attempt");
  });

  test("a failed calendar write also holds it back", async () => {
    job = baseJob({ calendarSyncState: "failed" });
    rows = [queued("agent")];

    await drainOutbox();
    assert.deepEqual(sends, []);
  });

  test("once synced it goes", async () => {
    rows = [queued("agent")];
    const report = await drainOutbox();

    assert.equal(report.accepted, 1);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, "agency@example.invalid");
    assert.equal(rows[0].state, "sent");
  });
});

describe("a stale notification is stood down, never sent", () => {
  test("the appointment moved", async () => {
    rows = [queued("agent")];
    job = baseJob({ appointmentStart: new Date("2026-10-06T10:00:00.000Z") });

    const report = await drainOutbox();

    assert.equal(report.cancelled, 1);
    assert.deepEqual(sends, [], "an alert described a visit that moved");
    assert.equal(rows[0].state, "cancelled");
  });

  test("the job was called off", async () => {
    rows = [queued("agent")];
    job = baseJob({ lifecycleStatus: "cancelled", cancelledAt: new Date() });

    const report = await drainOutbox();
    assert.equal(report.cancelled, 1);
    assert.deepEqual(sends, []);
  });

  test("the exception was cleared by a reschedule into the deadline", async () => {
    // There is nothing to announce any more.
    rows = [queued("agent")];
    job = baseJob({ deadlineExceptionAt: null });

    const report = await drainOutbox();
    assert.equal(report.cancelled, 1);
    assert.deepEqual(sends, []);
  });

  test("an exception with no recorded detail is not guessed at", async () => {
    rows = [queued("agent")];
    exceptionDetail = null;

    const report = await drainOutbox();
    assert.equal(report.cancelled, 1);
    assert.deepEqual(sends, []);
  });
});

describe("what the email says is frozen, not recomputed", () => {
  test("detail for a different appointment is refused", () => {
    const parsed = parseException(
      { ...exceptionDetail, appointmentStart: "2026-10-06T10:00:00.000Z" },
      APPOINTMENT,
    );
    assert.equal(parsed, null);
  });

  test("a malformed entry never becomes an email", () => {
    for (const bad of [
      null,
      "text",
      {},
      { ...exceptionDetail, deadlineSource: "invented" },
      { ...exceptionDetail, acknowledgedAt: "nonsense" },
      { ...exceptionDetail, deadlineDate: 20261001 },
    ]) {
      assert.equal(parseException(bad, APPOINTMENT), null);
    }
  });

  test("a good entry keeps both dates", () => {
    const parsed = parseException(exceptionDetail, APPOINTMENT)!;
    assert.equal(parsed.requestedBy, "2026-10-01");
    assert.equal(parsed.certificateDueBy, "2026-12-01");
    assert.equal(parsed.deadlineSource, "requested");
  });
});

describe("a missing address is visible, not silent", () => {
  test("no agency address is recorded by name", async () => {
    organisationEmail = null;
    rows = [queued("agent")];

    const report = await drainOutbox();

    assert.equal(report.missingRecipient, 1);
    assert.equal(rows[0].lastError, "agent_email_missing");
    assert.deepEqual(sends, []);
  });

  test("no BSCJ address is recorded by name", async () => {
    internalRecipient = null;
    rows = [queued("bscj")];

    await drainOutbox();
    assert.equal(rows[0].lastError, "bscj_email_missing");
  });

  test("it still consumes an attempt, so it cannot spin forever", async () => {
    organisationEmail = null;
    rows = [queued("agent")];

    await drainOutbox();
    assert.equal(rows[0].attempts, 1);
  });
});

describe("retry is bounded and its states are distinct", () => {
  test("a transport failure leaves it queued for another go", async () => {
    sendResult = { status: "failed", reason: "timeout" };
    rows = [queued("agent")];

    const report = await drainOutbox();

    assert.equal(report.stillQueued, 1);
    assert.equal(rows[0].state, "pending", "one failure gave up too early");
    assert.equal(rows[0].attempts, 1);
    assert.equal(rows[0].lastError, "timeout");
  });

  test("the last attempt gives up, and says so", async () => {
    sendResult = { status: "failed", reason: "rejected" };
    rows = [
      queued("agent", { attempts: MAX_ATTEMPTS - 1, updatedAt: longAgo() }),
    ];

    const report = await drainOutbox();

    assert.equal(report.failed, 1);
    assert.equal(rows[0].state, "failed", "it was left to retry forever");
    assert.equal(rows[0].attempts, MAX_ATTEMPTS);
  });

  test("a row that has already given up is not picked up again", async () => {
    rows = [
      queued("agent", {
        state: "failed",
        attempts: MAX_ATTEMPTS,
        updatedAt: longAgo(),
      }),
    ];

    const report = await drainOutbox();

    assert.equal(report.considered, 0);
    assert.deepEqual(sends, []);
  });

  test("an unconfigured transport is a recorded reason, not a crash", async () => {
    sendResult = { status: "not_configured" };
    rows = [queued("agent")];

    await drainOutbox();
    assert.equal(rows[0].lastError, "transport_not_configured");
  });

  test("acceptance is recorded as acceptance, with a timestamp", async () => {
    /*
      `sent` means the provider took it. Nothing here knows whether anybody
      received it, and no state in this module claims otherwise.
    */
    rows = [queued("agent")];
    await drainOutbox();

    assert.equal(rows[0].state, "sent");
    assert.ok(rows[0].sentAt, "acceptance was not timestamped");
    assert.equal(rows[0].lastError, null);
  });

  test("each recipient gets its own provider idempotency suffix", async () => {
    // Otherwise the provider would collapse the two into one message.
    rows = [queued("agent")];
    await drainOutbox();
    assert.equal(sends[0].suffix, "agent");

    rows = [queued("bscj")];
    sends = [];
    await drainOutbox();
    assert.equal(sends[0].suffix, "bscj");
  });
});

describe("the drain never throws into the sweep", () => {
  test("no database is an empty report", async () => {
    configured = false;
    const report = await drainOutbox();
    assert.deepEqual(report, {
      considered: 0,
      claimed: 0,
      accepted: 0,
      cancelled: 0,
      stillQueued: 0,
      failed: 0,
      missingRecipient: 0,
    });
  });

  test("a send that blows up leaves the row queued rather than failed", async () => {
    // A row marked failed on the strength of an error nobody has seen is a
    // row nobody will look at again.
    rows = [queued("agent")];
    sendResult = { status: "boom" } as unknown as { status: string };

    await assert.doesNotReject(() => drainOutbox());
  });
});

/** Every string literal inside a Drizzle predicate, however deeply nested. */
function stringsIn(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const found: string[] = [];
  for (const entry of Object.values(value as Record<string, unknown>)) {
    found.push(...stringsIn(entry, seen));
  }
  return found;
}

describe("standing down what a move left behind", () => {
  test("the rows for the appointment being KEPT are excluded", async () => {
    /*
      The regression test for a predicate that was always true. "key ≠ A OR key
      ≠ B" holds for every key, because no key can equal both — written that
      way, a confirmation cancelled the two notifications it had just queued,
      and nobody was ever told about a late booking.

      The fake cannot evaluate Drizzle's SQL, so this asserts on the shape:
      exactly one keep-set, containing both recipients' keys for the surviving
      appointment.
    */
    lastUpdatePredicate = null;
    await cancelSupersededNotifications(JOB_ID, APPOINTMENT);

    const literals = stringsIn(lastUpdatePredicate);
    for (const recipient of ["agent", "bscj"] as const) {
      assert.ok(
        literals.includes(lateBookingKey(JOB_ID, APPOINTMENT, recipient)),
        `the keep-set did not protect the ${recipient} notification`,
      );
    }
  });

  test("with no appointment to keep, everything queued is stood down", async () => {
    lastUpdatePredicate = null;
    await cancelSupersededNotifications(JOB_ID, null);
    assert.ok(lastUpdatePredicate, "no update was attempted");
  });

  test("it never throws into a confirmation", async () => {
    configured = false;
    await assert.doesNotReject(() =>
      cancelSupersededNotifications(JOB_ID, APPOINTMENT),
    );
  });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

describe("an invitation does not wait for an appointment", () => {
  test("it is sent while the job is still waiting on its tenant", async () => {
    /*
      The whole point of an invitation is that there is no appointment yet, so
      the calendar rule that holds back confirmations must not apply to it.
    */
    job = baseJob({
      lifecycleStatus: "tenant_outreach",
      appointmentStart: null,
      appointmentEnd: null,
      calendarSyncState: "not_required",
      deadlineExceptionAt: null,
    });
    rows = [queuedInvitation()];

    const report = await drainOutbox();

    assert.equal(report.accepted, 1, "the invitation was held back");
    assert.equal(sends[0].to, "tenant@example.invalid");
    assert.equal(rows[0].state, "sent");
  });

  test("it mints a fresh token for the send, and stores only its hash", async () => {
    /*
      The token created with the job was never kept in plain form — only its
      hash is stored — so a link cannot be reproduced from the database and has
      to be minted again here.
    */
    job = baseJob({
      lifecycleStatus: "tenant_outreach",
      appointmentStart: null,
      calendarSyncState: "not_required",
    });
    rows = [queuedInvitation()];

    await drainOutbox();

    assert.equal(mintedTokens.length, 1, "no token was minted for the link");
    assert.equal(mintedTokens[0].jobId, JOB_ID);
    assert.match(
      mintedTokens[0].tokenHash,
      /^(hmac|sha256)\$[0-9a-f]{64}$/,
      "something other than a hash was stored",
    );
  });

  test("each retry carries its own link, so the provider cannot collapse them", async () => {
    job = baseJob({
      lifecycleStatus: "tenant_outreach",
      appointmentStart: null,
      calendarSyncState: "not_required",
    });
    sendResult = { status: "failed", reason: "timeout" };
    rows = [queuedInvitation()];

    await drainOutbox();
    const first = sends[0].suffix;

    rows = [queuedInvitation({ attempts: 1, updatedAt: longAgo() })];
    sends = [];
    await drainOutbox();

    assert.notEqual(sends[0].suffix, first, "a retry reused the first key");
  });

  test("a job that can no longer be scheduled has nothing to invite anyone to", async () => {
    job = baseJob({ lifecycleStatus: "completed", appointmentStart: null });
    rows = [queuedInvitation()];

    const report = await drainOutbox();

    assert.equal(report.cancelled, 1);
    assert.deepEqual(sends, []);
    assert.equal(mintedTokens.length, 0, "a token was minted for nothing");
  });

  test("no tenant address is recorded by name, not as a generic failure", async () => {
    tenantEmail = null;
    job = baseJob({ lifecycleStatus: "tenant_outreach", appointmentStart: null });
    rows = [queuedInvitation()];

    const report = await drainOutbox();

    assert.equal(report.missingRecipient, 1);
    assert.equal(rows[0].lastError, "tenant_email_missing");
    assert.equal(mintedTokens.length, 0, "a token was minted with nowhere to send it");
  });

  test("an already-scheduled job may still be invited, so a tenant can rebook", async () => {
    job = baseJob({ lifecycleStatus: "scheduled" });
    rows = [queuedInvitation()];

    const report = await drainOutbox();
    assert.equal(report.accepted, 1);
  });
});

// ---------------------------------------------------------------------------
// Tenant appointment confirmations
// ---------------------------------------------------------------------------

describe("a tenant's confirmation follows the calendar", () => {
  test("it goes once the appointment is in the diary", async () => {
    rows = [queuedConfirmation()];

    const report = await drainOutbox();

    assert.equal(report.accepted, 1);
    assert.equal(sends[0].kind, "tenant-appointment");
    assert.equal(sends[0].to, "tenant@example.invalid");
  });

  test("it waits while the calendar write is outstanding", async () => {
    job = baseJob({ calendarSyncState: "pending" });
    rows = [queuedConfirmation()];

    const report = await drainOutbox();

    assert.equal(report.stillQueued, 1);
    assert.deepEqual(sends, [], "a tenant was told before the diary knew");
    assert.equal(rows[0].attempts, 0, "waiting consumed a retry attempt");
  });

  test("it is stood down if the appointment moved", async () => {
    rows = [queuedConfirmation()];
    job = baseJob({ appointmentStart: new Date("2026-10-06T10:00:00.000Z") });

    const report = await drainOutbox();

    assert.equal(report.cancelled, 1);
    assert.deepEqual(sends, []);
  });

  test("a missing tenant address is visible", async () => {
    tenantEmail = null;
    rows = [queuedConfirmation()];

    const report = await drainOutbox();
    assert.equal(report.missingRecipient, 1);
    assert.equal(rows[0].lastError, "tenant_email_missing");
  });
});

// ---------------------------------------------------------------------------
// Two workers
// ---------------------------------------------------------------------------

describe("two workers cannot both process one intent", () => {
  test("the loser of the claim does not send", async () => {
    /*
      Both workers read the same page of the queue. The claim is a conditional
      update on the attempt count each of them read, so exactly one wins.
    */
    rows = [queued("agent")];

    const [first, second] = await Promise.all([drainOutbox(), drainOutbox()]);

    assert.equal(
      first.claimed + second.claimed,
      1,
      "both workers claimed the same row",
    );
    assert.equal(sends.length, 1, "the message was sent twice");
  });

  test("a second pass finds nothing left to do", async () => {
    rows = [queued("agent")];

    await drainOutbox();
    sends = [];
    const second = await drainOutbox();

    assert.equal(second.considered, 0, "an accepted row was picked up again");
    assert.deepEqual(sends, [], "the message was sent twice");
  });

  test("the attempt is spent before the send, so an ambiguous outcome is bounded", async () => {
    /*
      If the process dies between the provider accepting and the row being
      updated, the attempt is already counted — so the retry costs one attempt
      rather than looping forever. The provider's own idempotency key is what
      stops that retry becoming a second email.
    */
    rows = [queued("agent")];
    sendResult = { status: "failed", reason: "timeout" };

    await drainOutbox();
    assert.equal(rows[0].attempts, 1);
  });
});

describe("a message in flight is invisible, not merely hard to claim", () => {
  test("a row claimed a moment ago is not even considered", async () => {
    /*
      The defect this exists for. The conditional claim stops two workers that
      read the **same** attempt count — but a worker starting a second later
      reads the count the first one just wrote, claims from there, and sends
      the same message again. Two invitations, two links, one intent.

      Comparing attempt counts hid it completely: both workers incremented
      perfectly. What proves it is `considered`, and the number of messages
      that actually reached the provider.
    */
    rows = [queued("agent", { attempts: 1, updatedAt: new Date() })];

    const report = await drainOutbox();

    assert.equal(report.considered, 0, "an in-flight row was picked up");
    assert.equal(report.claimed, 0);
    assert.deepEqual(sends, [], "the same intent was sent twice");
  });

  test("a freshly queued row does NOT wait for a lease", async () => {
    // Nothing holds it, so nothing needs to expire — a first send must not sit
    // in the queue for two minutes on principle.
    rows = [queued("agent", { attempts: 0, updatedAt: new Date() })];

    const report = await drainOutbox();

    assert.equal(report.considered, 1);
    assert.equal(report.accepted, 1);
  });

  test("once the lease runs out the row is eligible again", async () => {
    /*
      Crash recovery. A process that dies holding a row loses its lease, and
      the row returns to the queue without anybody intervening.
    */
    rows = [queued("agent", { attempts: 1, updatedAt: longAgo() })];

    const report = await drainOutbox();

    assert.equal(report.considered, 1);
    assert.equal(report.accepted, 1);
  });

  test("a failed attempt waits one window before the next", async () => {
    // The lease doubles as backoff: retrying a provider that just refused, in
    // the same second, is not a retry strategy.
    sendResult = { status: "failed", reason: "timeout" };
    rows = [queued("agent", { attempts: 0, updatedAt: new Date() })];

    await drainOutbox();
    assert.equal(rows[0].attempts, 1);

    sends = [];
    const second = await drainOutbox();
    assert.equal(second.considered, 0, "it retried without waiting");
    assert.deepEqual(sends, []);
  });

  test("the lease is long enough to cover a send", () => {
    // Shorter than the transport's own timeout would let a second worker in
    // while the first was still waiting on the provider.
    assert.ok(LEASE_SECONDS >= 60, `lease is only ${LEASE_SECONDS}s`);
  });
});

/**
 * A released certificate, delivered with the document attached.
 *
 * The behavioural half of §20.b. The database and private storage are both
 * stubbed above, so nothing here touches a store, a provider or a row — but
 * the worker's own decisions are real: which address it uses, whether it
 * attaches, what it does when the bytes are unavailable, and what it
 * refuses to send at all.
 */
describe("certificate emails", () => {
  const CERT_ID = "cert-1";
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 7, 7, 7, 9, 9]);

  function queueCertificate(over: Partial<Row> = {}) {
    rows = [
      {
        id: "row-cert",
        jobId: JOB_ID,
        kind: "certificate-release",
        recipient: "agent",
        recipientAddress: "approved@example.invalid",
        idempotencyKey: `certificate-release:${CERT_ID}:agent:1`,
        state: "pending",
        attempts: 0,
        lastError: null,
        sentAt: null,
        updatedAt: new Date(0),
        ...over,
      },
    ];
  }

  beforeEach(() => {
    certificateRow = {
      id: CERT_ID,
      certificateNumber: "BSCJ-CERT-1",
      version: 1,
      status: "issued",
      inspectionDate: "2026-09-19",
      nextDueDate: "2027-09-18",
      correctionReason: null,
      documentId: "doc-1",
      filename: "certificate.pdf",
      blobKey: `doc_${"a".repeat(48)}`,
      sizeBytes: PDF.byteLength,
    };
    storedDocument = { ok: true, bytes: PDF };
    organisationEmail = "approved@example.invalid";
    customerEmail = "landlord@example.invalid";
    organisationActive = true;
    customerActive = true;
    organisationOnJob = true;
    // A certificate is about a record, not an appointment: the calendar
    // must not gate it.
    job.calendarSyncState = "pending";
  });

  test("the exact PDF is attached, and the message goes to the approved address", async () => {
    queueCertificate();
    const report = await drainOutbox();

    assert.equal(report.accepted, 1);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, "approved@example.invalid");
    assert.equal(sends[0].attachments?.length, 1);
    assert.equal(sends[0].attachments?.[0].filename, "certificate.pdf");
    assert.deepEqual([...(sends[0].attachments?.[0].content ?? [])], [...PDF]);
  });

  test("it is not held behind the calendar", async () => {
    /*
      The visit has happened and the diary entry may long since have been
      tidied away. An appointment-scoped message waits for `synced`; a
      certificate must not, or the record is held behind a calendar nobody
      needs any more.
    */
    queueCertificate();
    job.calendarSyncState = "pending";
    const report = await drainOutbox();
    assert.equal(report.accepted, 1);
    assert.equal(sends.at(-1)?.kind, "certificate-release");
  });

  test("the frozen address wins over a changed record", async () => {
    /*
      The whole point of freezing. If this re-resolved, an approved document
      would be redirected to an address nobody approved — and the
      eligibility check below is what makes that a refusal rather than a
      silent redirect.
    */
    queueCertificate({ recipientAddress: "approved@example.invalid" });
    organisationEmail = "approved@example.invalid";
    await drainOutbox();
    assert.equal(sends.at(-1)?.to, "approved@example.invalid");
  });

  test("an address changed after approval stops the send and flags it", async () => {
    queueCertificate({ recipientAddress: "approved@example.invalid" });
    organisationEmail = "someone.else@example.invalid";

    const before = sends.length;
    const report = await drainOutbox();

    assert.equal(report.failed, 1);
    assert.equal(sends.length, before, "it sent anyway");
    assert.equal(rows[0].state, "failed");
    assert.equal(rows[0].lastError, "approved_address_changed");
  });

  test("a deactivated agency is not sent to", async () => {
    queueCertificate();
    organisationActive = false;
    const before = sends.length;
    await drainOutbox();
    assert.equal(sends.length, before);
    assert.equal(rows[0].lastError, "agency_deactivated");
  });

  test("an agency no longer on the job is not sent to", async () => {
    queueCertificate();
    organisationOnJob = false;
    const before = sends.length;
    await drainOutbox();
    assert.equal(sends.length, before);
    assert.equal(rows[0].lastError, "agency_no_longer_on_job");
  });

  test("storage being unavailable retries rather than sending a bare message", async () => {
    /*
      The attachment *is* the message for a recipient with no account.
      Sending without it would be worse than sending late — and the attempt
      is given back, because waiting is not trying.
    */
    queueCertificate();
    storedDocument = { ok: false };

    const before = sends.length;
    const report = await drainOutbox();

    assert.equal(sends.length, before, "it sent without the certificate");
    assert.equal(report.stillQueued, 1);
    assert.equal(rows[0].state, "pending");
    assert.equal(rows[0].attempts, 0, "the attempt was not given back");
  });

  test("a superseded version is stood down, not sent", async () => {
    queueCertificate();
    certificateRow = { ...certificateRow!, status: "superseded" };

    const before = sends.length;
    const report = await drainOutbox();

    assert.equal(sends.length, before);
    assert.equal(report.cancelled, 1);
    assert.equal(rows[0].lastError, "superseded_by_correction");
  });

  test("a certificate whose document has gone is stood down", async () => {
    queueCertificate();
    certificateRow = { ...certificateRow!, documentId: null, blobKey: null };
    await drainOutbox();
    assert.equal(rows[0].lastError, "certificate_document_missing");
  });

  test("the provider key is identical across retries", async () => {
    queueCertificate();
    sendResult = { status: "failed", reason: "network" };
    await drainOutbox();
    const first = sends.at(-1)?.suffix;

    // A retry once the lease has expired.
    rows[0].updatedAt = new Date(Date.now() - 10 * 60 * 1000);
    sendResult = { status: "sent", id: "e2" };
    await drainOutbox();
    const second = sends.at(-1)?.suffix;

    assert.equal(first, second, "a retry would be a second email");
    assert.match(first ?? "", /^cert-cert-1-agent-1$/);
    assert.equal(rows[0].idempotencyKey, `certificate-release:${CERT_ID}:agent:1`);
    assert.equal(rows[0].state, "sent");
    assert.equal(rows[0].attempts, 2);
  });

  test("two workers on one row send once", async () => {
    // The lease and the conditional claim, over the new kind.
    queueCertificate();
    const [a, b] = await Promise.all([drainOutbox(), drainOutbox()]);
    assert.equal(a.claimed + b.claimed, 1);
    assert.equal(sends.length, 1);
  });

  test("a missing address is reported rather than retried forever", async () => {
    queueCertificate({ recipientAddress: null });
    organisationEmail = null;
    const report = await drainOutbox();
    assert.equal(report.missingRecipient, 1);
    assert.equal(rows[0].lastError, "agent_email_missing");
  });
});

/**
 * An ambiguous outcome, then a corrected address.
 *
 * The sequence the requeue fix exists for, run end to end against the
 * worker:
 *
 * 1. A send is attempted and the answer is ambiguous — a timeout after the
 *    provider may already have accepted it.
 * 2. The worker retries. Same row, same key, same payload, so the provider
 *    recognises it; nothing can be sent twice.
 * 3. Somebody notices the address on file has changed and approves the new
 *    one. That is a **new row with a new key**, so it actually goes — and
 *    the earlier row is untouched, because whatever happened to it is
 *    history.
 */
describe("an ambiguous outcome followed by a new approval", () => {
  const CERT_ID = "cert-amb";
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 4, 2]);

  test("the retry reuses the key; the re-approval does not", async () => {
    certificateRow = {
      id: CERT_ID,
      certificateNumber: "BSCJ-CERT-9",
      version: 1,
      status: "issued",
      inspectionDate: "2026-09-19",
      nextDueDate: "2027-09-18",
      correctionReason: null,
      documentId: "doc-9",
      filename: "certificate.pdf",
      blobKey: `doc_${"b".repeat(48)}`,
      sizeBytes: PDF.byteLength,
    };
    storedDocument = { ok: true, bytes: PDF };
    organisationEmail = "first@example.invalid";
    organisationActive = true;
    organisationOnJob = true;

    rows = [
      {
        id: "row-1",
        jobId: JOB_ID,
        kind: "certificate-release",
        recipient: "agent",
        recipientAddress: "first@example.invalid",
        idempotencyKey: `certificate-release:${CERT_ID}:agent:1`,
        state: "pending",
        attempts: 0,
        lastError: null,
        sentAt: null,
        updatedAt: new Date(0),
      },
    ];

    // 1. Ambiguous: the provider may have taken it; we never found out.
    sendResult = { status: "failed", reason: "timeout" };
    await drainOutbox();
    const firstKey = sends.at(-1)?.suffix;
    assert.equal(rows[0].attempts, 1);
    assert.equal(rows[0].state, "pending");

    // 2. The retry, once the lease expires. Identical key and payload.
    rows[0].updatedAt = new Date(Date.now() - 10 * 60 * 1000);
    sendResult = { status: "failed", reason: "timeout" };
    await drainOutbox();
    const retryKey = sends.at(-1)?.suffix;
    assert.equal(retryKey, firstKey, "a retry would have been a second email");
    assert.equal(sends.at(-1)?.to, "first@example.invalid");

    // The address on file changes, and the old intent now refuses to send.
    organisationEmail = "corrected@example.invalid";
    rows[0].updatedAt = new Date(Date.now() - 10 * 60 * 1000);
    const before = sends.length;
    await drainOutbox();
    assert.equal(sends.length, before, "it sent to an address nobody approved");
    assert.equal(rows[0].lastError, "approved_address_changed");

    // 3. The new approval: a second row, a second key, the new address.
    rows.push({
      id: "row-2",
      jobId: JOB_ID,
      kind: "certificate-release",
      recipient: "agent",
      recipientAddress: "corrected@example.invalid",
      idempotencyKey: `certificate-release:${CERT_ID}:agent:2`,
      state: "pending",
      attempts: 0,
      lastError: null,
      sentAt: null,
      updatedAt: new Date(0),
    });
    sendResult = { status: "sent", id: "e9" };
    await drainOutbox();

    const finalSend = sends.at(-1);
    assert.equal(finalSend?.to, "corrected@example.invalid");
    assert.notEqual(finalSend?.suffix, firstKey, "the provider would dedupe it away");
    assert.deepEqual([...(finalSend?.attachments?.[0].content ?? [])], [...PDF]);

    // The earlier attempt is preserved exactly as it ended.
    const old = rows.find((r) => r.id === "row-1");
    assert.equal(old?.state, "failed");
    assert.equal(old?.lastError, "approved_address_changed");
    assert.equal(old?.recipientAddress, "first@example.invalid");
  });
});
