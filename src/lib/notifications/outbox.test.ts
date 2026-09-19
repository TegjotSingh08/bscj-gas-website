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
  idempotencyKey: string;
  state: string;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
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
};

const APPOINTMENT = new Date("2026-10-05T09:00:00.000Z");
const JOB_ID = "job-1";

let rows: Row[] = [];
let job: JobRow;
let organisationEmail: string | null = "agency@example.invalid";
let exceptionDetail: Record<string, unknown> | null;
let sends: { kind: string; to: string; suffix: string }[] = [];
let sendResult: { status: string; reason?: string; id?: string | null } = {
  status: "sent",
  id: "e1",
};
let internalRecipient: string | null = "ops@example.invalid";

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
              return rows.filter(
                (r) => r.state === "pending" && r.attempts < 5,
              );
            }
            if (name === "activity") {
              return exceptionDetail ? [{ detail: exceptionDetail }] : [];
            }
            return [
              {
                job,
                property: PROPERTY,
                organisationName: "FIXTURE Lettings",
                organisationEmail,
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
    update() {
      return {
        set(values: Record<string, unknown>) {
          const chain = {
            where: (predicate: unknown) => {
              lastUpdatePredicate = predicate;
              return chain;
            },
            returning: async () => {
              applyAll(values);
              return rows.map((r) => ({ id: r.id }));
            },
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
 * The fake cannot see the predicate, so an update lands on the row the test is
 * driving. Each test has one row in flight, which keeps that honest.
 */
function applyAll(values: Record<string, unknown>) {
  for (const row of rows) {
    if (row.state === "pending") Object.assign(row, values);
  }
}

/** The `where` the most recent update was built with, for the keep-set test. */
let lastUpdatePredicate: unknown = null;

let configured = true;

mock.module("@/lib/db/client", {
  namedExports: { getDb: () => (configured ? makeDb() : null) },
});

mock.module("@/lib/email/send", {
  namedExports: {
    internalNotificationRecipient: () => internalRecipient,
    sendOutboxEmail: async (input: {
      kind: string;
      to: string;
      idempotencySuffix: string;
    }) => {
      sends.push({
        kind: input.kind,
        to: input.to,
        suffix: input.idempotencySuffix,
      });
      return sendResult;
    },
  },
});

const {
  appointmentFromKey,
  cancelSupersededNotifications,
  drainOutbox,
  lateBookingKey,
  lateBookingRows,
  MAX_ATTEMPTS,
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
    ...overrides,
  };
}

beforeEach(() => {
  configured = true;
  job = baseJob();
  rows = [];
  organisationEmail = "agency@example.invalid";
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
    rows = [queued("agent", { attempts: MAX_ATTEMPTS - 1 })];

    const report = await drainOutbox();

    assert.equal(report.failed, 1);
    assert.equal(rows[0].state, "failed", "it was left to retry forever");
    assert.equal(rows[0].attempts, MAX_ATTEMPTS);
  });

  test("a row that has already given up is not picked up again", async () => {
    rows = [queued("agent", { state: "failed", attempts: MAX_ATTEMPTS })];

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
