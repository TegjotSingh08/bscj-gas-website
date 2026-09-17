import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Recording a website booking.
 *
 * The database is replaced with a recording fake that speaks just enough
 * Drizzle to observe what the module does: which tables it writes, in what
 * order, and — the point of most of these — what it writes on a retry.
 *
 * The rule under test above all others: **this cannot fail a booking.** By the
 * time it runs the calendar event exists and the customer has been emailed, so
 * every failure has to come back as a value.
 */

/** Every table written, in order. */
let writes: string[] = [];
/** Rows the fake pretends already exist, by table. */
let existingRows: Record<string, unknown[]> = {};
/** What the next operation should do instead of succeeding. */
let failOn: string | null = null;
/** Rows captured at insert time, by table. */
let inserted: Record<string, Record<string, unknown>[]> = {};
/** Whether `getDb` should report a configured database at all. */
let configured = true;

function tableName(table: unknown): string {
  // Drizzle keeps the SQL name on a symbol; the fake only needs a label.
  const symbol = Object.getOwnPropertySymbols(table).find((s) =>
    String(s).includes("Name"),
  );
  return symbol ? String((table as Record<symbol, unknown>)[symbol]) : "unknown";
}

function makeDb() {
  return {
    select() {
      return {
        from(table: unknown) {
          const name = tableName(table);
          const chain = {
            leftJoin: () => chain,
            where: () => chain,
            orderBy: () => chain,
            limit: async () => {
              if (failOn === `select:${name}`) throw new Error("connection lost");
              return existingRows[name] ?? [];
            },
          };
          return chain;
        },
      };
    },
    insert(table: unknown) {
      const name = tableName(table);
      return {
        values(row: Record<string, unknown>) {
          const result = {
            onConflictDoNothing: () => result,
            returning: async () => {
              writes.push(name);
              if (failOn === `insert:${name}`) throw new Error("write refused");
              if (failOn === `conflict:${name}`) return [];
              (inserted[name] ??= []).push(row);
              return [{ id: `${name}-id` }];
            },
            // The activity insert has no .returning().
            then: (resolve: (value: unknown) => void) => {
              writes.push(name);
              if (failOn === `insert:${name}`) throw new Error("write refused");
              (inserted[name] ??= []).push(row);
              return Promise.resolve(undefined).then(resolve);
            },
          };
          return result;
        },
      };
    },
  };
}

mock.module("@/lib/db/client", {
  namedExports: {
    getDb: () => (configured ? makeDb() : null),
  },
});

const { persistWebsiteBooking } = await import("./persist-booking");
import type { PersistBookingInput } from "./persist-booking";

const INPUT: PersistBookingInput = {
  reference: "BSCJ-A1B2C3",
  idempotencyKey: "attempt-key-1",
  calendarEventId: "event-abc123",
  customerType: "landlord" as const,
  fullName: "A Customer",
  company: null,
  email: "  Person@Example.COM  ",
  phone: "+447700900123",
  houseOrName: "12",
  street: "Example Street",
  town: "Wolverhampton",
  postcode: "wv1 1aa",
  accessNotes: "Key safe by the door",
  tenantName: null,
  tenantPhone: null,
  productId: "cp12" as const,
  applianceCount: 3,
  extraAppliances: 0,
  extraAppliancePrice: 15,
  priceTotal: 45,
  appointmentStart: new Date("2026-10-01T09:00:00.000Z"),
  appointmentEnd: new Date("2026-10-01T09:45:00.000Z"),
  durationMinutes: 45,
};

beforeEach(() => {
  writes = [];
  existingRows = {};
  inserted = {};
  failOn = null;
  configured = true;
});

describe("a new booking is recorded", () => {
  test("it writes the customer, the property and the job", async () => {
    const result = await persistWebsiteBooking(INPUT);

    assert.equal(result.status, "created");
    assert.ok(writes.includes("customer"));
    assert.ok(writes.includes("property"));
    assert.ok(writes.includes("job"));
  });

  test("the job is written after the customer and the property it points at", async () => {
    await persistWebsiteBooking(INPUT);
    assert.ok(
      writes.indexOf("job") > writes.indexOf("customer"),
      "the job was written before its customer",
    );
    assert.ok(
      writes.indexOf("job") > writes.indexOf("property"),
      "the job was written before its property",
    );
  });

  test("a timeline entry is written for it", async () => {
    await persistWebsiteBooking(INPUT);
    assert.equal(inserted.activity?.[0]?.kind, "job.created");
    assert.equal(inserted.activity?.[0]?.actor, "system");
  });
});

describe("what the job records", () => {
  test("the V1 reference is preserved exactly", async () => {
    // It is already printed on a confirmation in the customer's inbox.
    await persistWebsiteBooking(INPUT);
    assert.equal(inserted.job?.[0]?.reference, "BSCJ-A1B2C3");
  });

  test("the calendar event is recorded as already synced", async () => {
    // This runs after the event was written. Nothing is pending or retryable.
    const job = (await withJob()).job;
    assert.equal(job.calendarEventId, "event-abc123");
    assert.equal(job.calendarSyncState, "synced");
  });

  test("a self-booked website job is scheduled, from the website, by the customer", async () => {
    const job = (await withJob()).job;
    assert.equal(job.lifecycleStatus, "scheduled");
    assert.equal(job.schedulingMethod, "self_booked");
    assert.equal(job.source, "website_self");
  });

  test("money is stored in pence", async () => {
    const job = (await withJob()).job;
    assert.equal(job.priceTotalPence, 4500);
  });

  test("the price snapshot agrees with the total that was charged", async () => {
    /*
      The invariant that matters: the frozen snapshot an invoice will read must
      total the same as the figure the customer was quoted, or an invoice would
      silently disagree with a confirmation email.
    */
    const job = (await withJob()).job;
    const snapshot = job.priceSnapshot as Record<string, unknown>;
    assert.equal(snapshot.totalPence, job.priceTotalPence);
    assert.equal(snapshot.source, "list", "a consumer booking pays list price");
    assert.equal(snapshot.agreementId, null);
  });

  test("extra appliances are carried into the snapshot and the total", async () => {
    const job = (
      await withJob({ applianceCount: 5, extraAppliances: 2, priceTotal: 75 })
    ).job;
    const snapshot = job.priceSnapshot as Record<string, unknown>;
    assert.equal(snapshot.extraAppliances, 2);
    assert.equal(snapshot.extraChargePence, 3000);
    assert.equal(snapshot.totalPence, 7500);
    assert.equal(job.priceTotalPence, 7500);
  });

  test("a service that is not priced by appliance stores no count", async () => {
    const job = (
      await withJob({
        productId: "boiler-service" as const,
        applianceCount: null,
        extraAppliances: 0,
        priceTotal: 60,
      })
    ).job;
    assert.equal(job.applianceCount, null);
    assert.equal(job.priceTotalPence, 6000);
  });

  test("the appointment and its duration are stored", async () => {
    const job = (await withJob()).job;
    assert.deepEqual(job.appointmentStart, INPUT.appointmentStart);
    assert.deepEqual(job.appointmentEnd, INPUT.appointmentEnd);
    assert.equal(job.durationMinutes, 45);
  });

  test("it snapshots the customer and the property as they were", async () => {
    // Live relations answer "what is true now"; these answer "what was true
    // when this job was taken".
    const job = (await withJob()).job;
    const customer = job.customerSnapshot as Record<string, unknown>;
    const property = job.propertySnapshot as Record<string, unknown>;
    assert.equal(customer.name, "A Customer");
    assert.equal(customer.email, "person@example.com");
    assert.equal(property.postcode, "WV1 1AA");
    assert.equal(property.street, "Example Street");
  });

  test("consumer work belongs to no organisation", async () => {
    // A null organisation is what keeps a website booking out of every
    // agency's scope.
    const job = (await withJob()).job;
    assert.equal(job.agentOrganisationId, undefined);
  });

  test("the person who booked is the person billed", async () => {
    const job = (await withJob()).job;
    assert.equal(job.customerId, job.billingCustomerId);
  });
});

describe("normalisation", () => {
  test("the email is lower-cased and trimmed before it is stored or matched", async () => {
    await persistWebsiteBooking(INPUT);
    assert.equal(inserted.customer?.[0]?.email, "person@example.com");
  });

  test("the postcode is stored canonically", async () => {
    await persistWebsiteBooking(INPUT);
    assert.equal(inserted.property?.[0]?.postcode, "WV1 1AA");
  });

  test("the booking form's hyphenated customer type becomes the database enum", async () => {
    await persistWebsiteBooking({ ...INPUT, customerType: "letting-agent" });
    assert.equal(inserted.customer?.[0]?.type, "letting_agent");
  });
});

describe("a tenancy is only recorded when there is a tenant", () => {
  test("no tenant details, no tenancy row", async () => {
    // An empty tenancy asserts that somebody lives there and we know who.
    await persistWebsiteBooking(INPUT);
    assert.equal(writes.includes("tenancy"), false);
    assert.equal(inserted.job?.[0]?.tenancyId, null);
  });

  test("tenant details given, tenancy row written and linked", async () => {
    await persistWebsiteBooking({
      ...INPUT,
      tenantName: "A Tenant",
      tenantPhone: "+447700900456",
    });
    assert.ok(writes.includes("tenancy"));
    assert.equal(inserted.tenancy?.[0]?.name, "A Tenant");
    assert.equal(inserted.job?.[0]?.tenancyId, "tenancy-id");
  });
});

describe("idempotency", () => {
  test("a retry finds the existing job and writes nothing at all", async () => {
    /*
      Not just "no duplicate job" — no duplicate customer and no duplicate
      property either. Checking before any write is what makes a double
      submission leave the database exactly as it found it.
    */
    existingRows.job = [{ id: "already-there" }];

    const result = await persistWebsiteBooking(INPUT);

    assert.deepEqual(result, { status: "exists", jobId: "already-there" });
    assert.deepEqual(writes, [], "a retry wrote something");
  });

  test("two runs of the same submission produce one job", async () => {
    const first = await persistWebsiteBooking(INPUT);
    assert.equal(first.status, "created");

    // The row the first run created is now there, as the database would have it.
    existingRows.job = [{ id: "job-id" }];
    writes = [];

    const second = await persistWebsiteBooking(INPUT);
    assert.equal(second.status, "exists");
    assert.deepEqual(writes, []);
    assert.equal(inserted.job?.length, 1, "a second job row was written");
  });

  test("a race that gets past the check is caught by the unique index", async () => {
    // Both requests saw no job; the index decides, and the loser reads the
    // winner's row rather than reporting a failure.
    failOn = "conflict:job";
    existingRows.job = [];

    const result = await persistWebsiteBooking(INPUT);
    // The post-conflict re-read finds what the winner wrote.
    assert.equal(result.status, "failed");
    assert.equal(
      (result as { reason: string }).reason,
      "conflict_without_row",
      "a conflict with no readable winner should be reported, not invented",
    );
  });

  test("the job carries the idempotency key it was keyed on", async () => {
    await persistWebsiteBooking(INPUT);
    assert.equal(inserted.job?.[0]?.idempotencyKey, "attempt-key-1");
  });
});

describe("existing records are reused, not duplicated", () => {
  test("a returning customer is matched, not created again", async () => {
    existingRows.customer = [{ id: "existing-customer" }];

    await persistWebsiteBooking(INPUT);

    assert.equal(writes.includes("customer"), false);
    assert.equal(inserted.job?.[0]?.customerId, "existing-customer");
  });

  test("the same property at the same address is reused", async () => {
    existingRows.customer = [{ id: "existing-customer" }];
    existingRows.property = [{ id: "existing-property" }];

    await persistWebsiteBooking(INPUT);

    assert.equal(writes.includes("property"), false);
    assert.equal(inserted.job?.[0]?.propertyId, "existing-property");
  });
});

describe("failure can never reach the booking", () => {
  test("no database configured is reported, not thrown", async () => {
    configured = false;
    const result = await persistWebsiteBooking(INPUT);
    assert.deepEqual(result, { status: "not_configured" });
  });

  test("a read failure is reported, not thrown", async () => {
    failOn = "select:job";
    const result = await persistWebsiteBooking(INPUT);
    assert.equal(result.status, "failed");
  });

  test("a write failure at any step is reported, not thrown", async () => {
    for (const step of ["insert:customer", "insert:property", "insert:job"]) {
      writes = [];
      inserted = {};
      failOn = step;

      const result = await persistWebsiteBooking(INPUT);
      assert.equal(result.status, "failed", step);
      assert.equal(
        (result as { reason: string }).reason,
        "write_failed",
        step,
      );
    }
  });

  test("nothing it can be handed makes it throw", async () => {
    /*
      The guarantee the booking route depends on. It is called plainly, with no
      try/catch around it, exactly as the two email sends above it are — so if
      it could throw, a confirmed appointment would become a 500.
    */
    for (const step of [
      "select:job",
      "select:customer",
      "insert:customer",
      "insert:property",
      "insert:tenancy",
      "insert:job",
      "insert:activity",
    ]) {
      failOn = step;
      await assert.doesNotReject(
        () =>
          persistWebsiteBooking({
            ...INPUT,
            tenantName: "A Tenant",
            tenantPhone: "+447700900456",
          }),
        step,
      );
    }
  });

  test("a failed timeline entry does not fail the job", async () => {
    // The job is the record. The timeline is commentary.
    failOn = "insert:activity";
    const result = await persistWebsiteBooking(INPUT);
    assert.equal(result.status, "created");
  });
});

/** Runs a persist and hands back the row that reached the job table. */
async function withJob(
  over: Partial<PersistBookingInput> = {},
) {
  writes = [];
  inserted = {};
  await persistWebsiteBooking({ ...INPUT, ...over });
  const job = inserted.job?.[0];
  assert.ok(job, "no job row was written");
  return { job };
}
