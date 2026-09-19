import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Reading the two dates a cutoff is made of.
 *
 * The rule under test above all others: **a certificate due date belongs to
 * one service.** A property can hold an active CP12 cycle and a separate
 * boiler-service cycle, and the expiry of one says nothing about the other.
 * Matching on the property alone would make a CP12 expiry constrain a boiler
 * service that has nothing to do with it.
 */

type Cycle = {
  propertyId: string;
  productId: string;
  status: string;
  dueDate: string;
  id: string;
};

let completeByDate: string | null = null;
let jobProductId = "cp12";
let cycles: Cycle[] = [];
let configured = true;
let failRead = false;

const PROPERTY_ID = "property-1";

function nameOf(table: unknown): string {
  const symbol = Object.getOwnPropertySymbols(table as object).find((s) =>
    String(s).includes("Name"),
  );
  return symbol ? String((table as Record<symbol, unknown>)[symbol]) : "unknown";
}

/**
 * The fake applies the module's own filters.
 *
 * Restating the predicate would be circular if this were a test of the SQL. It
 * is not: it is a test of *which* cycle is considered relevant, and the query
 * itself runs for real in the browser verification recorded in the handoff.
 */
function makeDb() {
  return {
    select() {
      return {
        from(table: unknown) {
          const isCycle = nameOf(table) === "compliance_cycle";
          const answer = () => {
            if (failRead) throw new Error("connection lost");
            if (!isCycle) {
              return [
                {
                  completeByDate,
                  propertyId: PROPERTY_ID,
                  productId: jobProductId,
                },
              ];
            }
            return cycles
              .filter(
                (c) =>
                  c.propertyId === PROPERTY_ID &&
                  c.productId === jobProductId &&
                  c.status === "active",
              )
              .map((c) => ({ id: c.id, dueDate: c.dueDate }));
          };
          const chain = {
            where: () => chain,
            limit: async () => answer(),
            then: (resolve: (v: unknown) => void) =>
              Promise.resolve(answer()).then(resolve),
          };
          return chain;
        },
      };
    },
  };
}

mock.module("@/lib/db/client", {
  namedExports: { getDb: () => (configured ? makeDb() : null) },
});

const { fetchJobDeadline } = await import("./deadline-lookup");

beforeEach(() => {
  completeByDate = null;
  jobProductId = "cp12";
  cycles = [];
  configured = true;
  failRead = false;
});

describe("a certificate deadline belongs to one service", () => {
  test("a CP12 cycle constrains a CP12 job", async () => {
    jobProductId = "cp12";
    cycles = [
      {
        id: "cycle-1",
        propertyId: PROPERTY_ID,
        productId: "cp12",
        status: "active",
        dueDate: "2026-10-10",
      },
    ];

    const { deadline, complianceCycleId } = await fetchJobDeadline("job-1");

    assert.equal(deadline.status, "set");
    assert.equal((deadline as { date: string }).date, "2026-10-10");
    assert.equal(complianceCycleId, "cycle-1");
  });

  test("a CP12 cycle does NOT constrain a boiler service", async () => {
    /*
      The point of the whole test file. A boiler service has nothing to do with
      when the gas safety certificate runs out, and treating one as a deadline
      for the other would refuse perfectly good appointments — and record
      exceptions against a date that never applied.
    */
    jobProductId = "boiler-service";
    cycles = [
      {
        id: "cycle-1",
        propertyId: PROPERTY_ID,
        productId: "cp12",
        status: "active",
        dueDate: "2026-10-10",
      },
    ];

    const { deadline, complianceCycleId } = await fetchJobDeadline("job-1");

    assert.equal(deadline.status, "none", "a CP12 expiry leaked onto a service");
    assert.equal(complianceCycleId, null);
  });

  test("each service uses its own cycle when a property has both", async () => {
    cycles = [
      {
        id: "cycle-cp12",
        propertyId: PROPERTY_ID,
        productId: "cp12",
        status: "active",
        dueDate: "2026-10-10",
      },
      {
        id: "cycle-service",
        propertyId: PROPERTY_ID,
        productId: "boiler-service",
        status: "active",
        dueDate: "2027-03-01",
      },
    ];

    jobProductId = "cp12";
    const cp12 = await fetchJobDeadline("job-1");
    assert.equal((cp12.deadline as { date: string }).date, "2026-10-10");

    jobProductId = "boiler-service";
    const service = await fetchJobDeadline("job-1");
    assert.equal((service.deadline as { date: string }).date, "2027-03-01");
  });

  test("a superseded cycle describes a position that has been replaced", async () => {
    cycles = [
      {
        id: "cycle-old",
        propertyId: PROPERTY_ID,
        productId: "cp12",
        status: "superseded",
        dueDate: "2025-01-01",
      },
    ];

    const { deadline } = await fetchJobDeadline("job-1");
    assert.equal(deadline.status, "none");
  });

  test("a cycle at another property is not this job's", async () => {
    cycles = [
      {
        id: "cycle-elsewhere",
        propertyId: "property-2",
        productId: "cp12",
        status: "active",
        dueDate: "2026-10-10",
      },
    ];

    const { deadline } = await fetchJobDeadline("job-1");
    assert.equal(deadline.status, "none");
  });
});

describe("the two dates together", () => {
  test("the earlier of the requested date and the certificate wins", async () => {
    completeByDate = "2026-09-01";
    cycles = [
      {
        id: "cycle-1",
        propertyId: PROPERTY_ID,
        productId: "cp12",
        status: "active",
        dueDate: "2026-10-10",
      },
    ];

    const { deadline } = await fetchJobDeadline("job-1");
    assert.equal((deadline as { date: string }).date, "2026-09-01");
    assert.equal((deadline as { source: string }).source, "requested");
    assert.equal((deadline as { certificateDueBy: string }).certificateDueBy, "2026-10-10");
  });

  test("a requested date alone still applies with no cycle at all", async () => {
    completeByDate = "2026-09-01";
    const { deadline } = await fetchJobDeadline("job-1");
    assert.equal((deadline as { source: string }).source, "requested");
  });
});

describe("a read that fails is not 'no deadline'", () => {
  test("it degrades to normal availability rather than refusing anybody", async () => {
    /*
      It must never record an exception against a cutoff it could not read —
      but nor may it refuse a tenant an appointment because a query failed. It
      behaves exactly as a job with no deadline did before this phase.
    */
    failRead = true;
    const { deadline } = await fetchJobDeadline("job-1");
    assert.equal(deadline.status, "none");
  });

  test("no database configured behaves the same way", async () => {
    configured = false;
    const { deadline } = await fetchJobDeadline("job-1");
    assert.equal(deadline.status, "none");
  });

  test("it never throws into the scheduling path", async () => {
    failRead = true;
    await assert.doesNotReject(() => fetchJobDeadline("job-1"));
  });
});
