import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * **Releasing a certificate moves the renewal it proves.**
 *
 * Driven through `releaseCertificate` itself — the permission check, the
 * document lookup, the supersede-and-version batch, the reviewed-date check and
 * the compliance write — with the database replaced by a recording fake that
 * speaks enough Drizzle to observe which tables are written, in what order, and
 * with what.
 *
 * Service level, not live: there is no Postgres on this machine, so the unique
 * indexes, the foreign keys and the real transaction semantics are **not**
 * exercised. What is exercised is everything the application decides.
 */

type Insert = { table: string; row: Record<string, unknown> };
type Update = { table: string; values: Record<string, unknown> };

let inserts: Insert[] = [];
let updates: Update[] = [];
/** Rows the fake returns, by table, in the order the code selects them. */
let rows: Record<string, Record<string, unknown>[]> = {};
/** A table whose next write should throw. */
let failWrite: string | null = null;
let audits: string[] = [];

function tableName(table: unknown): string {
  const symbol = Object.getOwnPropertySymbols(table).find((s) =>
    String(s).includes("Name"),
  );
  return symbol ? String((table as Record<symbol, unknown>)[symbol]) : "unknown";
}

type Statement = {
  run: () => unknown[];
  where: () => Statement;
  onConflictDoNothing: () => Statement;
  /** Drizzle returns a builder here, not a promise — a batch collects them. */
  returning: () => Statement;
  then: (resolve: (value: unknown) => void) => Promise<void>;
};

function makeDb() {
  const statement = (run: () => unknown[]): Statement => {
    const self: Statement = {
      run,
      where: () => self,
      onConflictDoNothing: () => self,
      returning: () => self,
      then: (resolve) => Promise.resolve(run()).then((value) => resolve(value)),
    };
    return self;
  };

  return {
    select: () => ({
      from: (table: unknown) => {
        const name = tableName(table);
        const chain = {
          innerJoin: () => chain,
          leftJoin: () => chain,
          where: () => chain,
          /*
            The fake ignores projections and WHEREs, so where one table is read
            twice for different questions the fixtures are keyed separately.
            `certificate` is read as a list (every version, ordered) and as a
            single row (is *this document* already released?).
          */
          orderBy: async () => rows[name] ?? [],
          limit: async () => (rows[`${name}:one`] ?? rows[name] ?? []).slice(0, 1),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => {
      const name = tableName(table);
      return {
        values: (row: Record<string, unknown>) =>
          statement(() => {
            if (failWrite === name) throw new Error("write refused");
            inserts.push({ table: name, row });
            return [{ id: `${name}-${inserts.length}` }];
          }),
      };
    },
    update: (table: unknown) => {
      const name = tableName(table);
      return {
        set: (values: Record<string, unknown>) =>
          statement(() => {
            if (failWrite === name) throw new Error("write refused");
            updates.push({ table: name, values });
            return [];
          }),
      };
    },
    async batch(statements: Statement[]) {
      return statements.map((item) => item.run());
    },
  };
}

mock.module("@/lib/db/client", { namedExports: { getDb: () => makeDb() } });
mock.module("@/lib/audit/record", {
  namedExports: {
    recordAudit: async (entry: { kind: string }) => {
      audits.push(entry.kind);
    },
  },
});
mock.module("@/lib/storage/documents", {
  namedExports: {
    putDocument: async () => ({ ok: true, key: "k" }),
    getDocument: async () => ({ ok: true, bytes: new Uint8Array() }),
    deleteDocument: async () => undefined,
    storageStatus: () => ({ ready: true, driver: "local", outstanding: [] }),
  },
});

const { releaseCertificate, updateRenewalFromCertificate } = await import(
  "@/lib/documents/certificates"
);

const ADMIN = {
  user: { id: "u-1", email: "admin@fixture.example.invalid", role: "admin" },
  scope: { kind: "all" as const },
};

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOCUMENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CERTIFICATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const DETAILS = {
  certificateNumber: "TEST-0001",
  inspectionDate: "2026-09-20",
  nextDueDate: "2027-09-19",
  correctionReason: "",
};

/** The rows the release path reads, for a job of the given product. */
function given(options: {
  productId?: string;
  activeCycle?: Record<string, unknown> | null;
  existingCertificates?: Record<string, unknown>[];
  organisationId?: string | null;
} = {}) {
  rows = {
    job: [
      {
        id: JOB,
        reference: "BSCJ-TEST01",
        propertyId: "prop-1",
        agentOrganisationId:
          options.organisationId === undefined ? "org-1" : options.organisationId,
        productId: options.productId ?? "cp12",
      },
    ],
    document: [{ id: DOCUMENT, filename: "cert.pdf" }],
    // Every version on the job, newest first.
    certificate: options.existingCertificates ?? [],
    // "Has *this document* already been released?" — no, in every case here.
    "certificate:one": [],
    compliance_cycle: options.activeCycle ? [options.activeCycle] : [],
  };
}

const cycles = () => inserts.filter((row) => row.table === "compliance_cycle");
const activityKinds = () =>
  inserts.filter((row) => row.table === "activity").map((row) => row.row.kind);

beforeEach(() => {
  inserts = [];
  updates = [];
  audits = [];
  failWrite = null;
  given();
});

async function release(details = DETAILS) {
  return releaseCertificate({
    session: ADMIN as never,
    jobId: JOB,
    documentId: DOCUMENT,
    details,
    today: "2026-09-21",
  });
}

describe("releasing a CP12 records the renewal", () => {
  test("a property with no position gets one, from the reviewed dates", async () => {
    const result = await release();

    assert.equal(result.ok, true);
    assert.equal(cycles().length, 1);

    const cycle = cycles()[0].row;
    assert.equal(cycle.productId, "cp12");
    // The dates an administrator read off the certificate, not a derived pair.
    assert.equal(cycle.inspectionDate, "2026-09-20");
    assert.equal(cycle.dueDate, "2027-09-19");
    assert.equal(cycle.status, "active");
    assert.equal(cycle.establishedByJobId, JOB);
    assert.equal(cycle.dueDateSource, "manual");
  });

  test("the renewal is not derived from the inspection date", async () => {
    /*
      `renewal.ts` would make this 2027-09-19 as it happens, but the point is
      that the value comes from the form. A certificate whose printed due date
      differs from the rule keeps its printed date.
    */
    await release({ ...DETAILS, nextDueDate: "2027-06-30" });
    assert.equal(cycles()[0].row.dueDate, "2027-06-30");
  });

  test("the cycle points at the certificate, so a retry is a no-op", async () => {
    await release();
    assert.ok(cycles()[0].row.certificateId, "the certificate id is recorded");
  });

  test("it is recorded in the property's history", async () => {
    await release();
    assert.ok(activityKinds().includes("compliance.established"));
  });

  test("the administrator is told the renewal moved", async () => {
    const result = await release();
    assert.match(result.ok ? result.message : "", /renewal is now recorded/i);
  });
});

describe("which service the certificate moves", () => {
  test("a combined CP12-and-service job moves the CP12 only", async () => {
    given({ productId: "cp12-boiler-service" });
    await release();

    assert.deepEqual(
      cycles().map((row) => row.row.productId),
      ["cp12"],
    );
  });

  test("a boiler-service job records no compliance position at all", async () => {
    /*
      There is no certificate for a service. Recording a CP12 here would claim
      a gas safety check that was never part of the work.
    */
    given({ productId: "boiler-service" });
    const result = await release();

    assert.equal(result.ok, true);
    assert.equal(cycles().length, 0);
  });

  test("and its release still succeeds — the document is still a document", async () => {
    given({ productId: "boiler-service" });
    const result = await release();
    assert.match(result.ok ? result.message : "", /released/i);
  });
});

describe("an existing position", () => {
  test("an older one is superseded rather than edited", async () => {
    given({
      activeCycle: {
        id: "cycle-old",
        inspectionDate: "2025-09-20",
        dueDate: "2026-09-19",
        establishedByJobId: "job-previous",
        certificateId: "cert-previous",
      },
    });

    await release();

    const superseded = updates.filter(
      (row) => row.table === "compliance_cycle" && row.values.status === "superseded",
    );
    assert.equal(superseded.length, 1);
    assert.equal(cycles().length, 1);
  });

  test("a newer one is kept, and the release says so", async () => {
    given({
      activeCycle: {
        id: "cycle-newer",
        inspectionDate: "2027-02-01",
        dueDate: "2028-01-31",
        establishedByJobId: "job-later",
        certificateId: "cert-later",
      },
    });

    const result = await release();

    assert.equal(cycles().length, 0);
    assert.equal(
      updates.filter((row) => row.table === "compliance_cycle").length,
      0,
    );
    assert.match(result.ok ? result.message : "", /left as it is/i);
    assert.match(result.ok ? result.message : "", /2028-01-31/);
  });

  test("keeping a newer position is recorded, not silent", async () => {
    given({
      activeCycle: {
        id: "cycle-newer",
        inspectionDate: "2027-02-01",
        dueDate: "2028-01-31",
        establishedByJobId: "job-later",
        certificateId: "cert-later",
      },
    });

    await release();
    assert.ok(activityKinds().includes("compliance.position_kept"));
  });
});

describe("a correction", () => {
  test("supersedes the certificate and moves the renewal with it", async () => {
    given({
      existingCertificates: [
        { id: CERTIFICATE, version: 1, status: "issued" },
      ],
      activeCycle: {
        id: "cycle-ours",
        inspectionDate: "2026-09-20",
        dueDate: "2027-09-19",
        establishedByJobId: JOB,
        certificateId: CERTIFICATE,
      },
    });

    const result = await release({
      ...DETAILS,
      nextDueDate: "2027-08-31",
      correctionReason: "The due date was mistyped.",
    });

    assert.equal(result.ok, true);
    // Version 2 of the certificate, and a replacement position.
    assert.equal(cycles().length, 1);
    assert.equal(cycles()[0].row.dueDate, "2027-08-31");
    assert.equal(audits.includes("certificate.corrected"), true);
  });

  test("a correction without a reason is refused before anything is written", async () => {
    given({
      existingCertificates: [{ id: CERTIFICATE, version: 1, status: "issued" }],
    });

    const result = await release({ ...DETAILS, correctionReason: "" });

    assert.equal(result.ok, false);
    assert.equal(inserts.length, 0);
    assert.equal(cycles().length, 0);
  });
});

describe("when the renewal write fails after the certificate is written", () => {
  test("the release still succeeds and says the renewal did not move", async () => {
    /*
      The two cannot be one statement — the cycle needs the certificate's id,
      which does not exist until the certificate is inserted. So this state is
      reachable, and the answer is to make it **visible** rather than to
      pretend it cannot happen.
    */
    failWrite = "compliance_cycle";

    const result = await release();

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.complianceOutstanding, true);
    assert.match(result.ok ? result.message : "", /has not moved/i);
    assert.match(result.ok ? result.message : "", /Update the renewal/i);
  });

  test("the retry applies it, and is safe when nothing is wrong", async () => {
    rows = {
      // Aliased exactly as `updateRenewalFromCertificate` selects them.
      "certificate:one": [
        {
          certificateId: CERTIFICATE,
          inspectionDate: "2026-09-20",
          nextDueDate: "2027-09-19",
          status: "issued",
          jobId: JOB,
          propertyId: "prop-1",
          agentOrganisationId: "org-1",
          productId: "cp12",
        },
      ],
      compliance_cycle: [],
    };

    const result = await updateRenewalFromCertificate({
      session: ADMIN as never,
      jobId: JOB,
      certificateId: CERTIFICATE,
    });

    assert.equal(result.ok, true);
    assert.equal(cycles().length, 1);
    assert.equal(cycles()[0].row.certificateId, CERTIFICATE);
  });

  test("the retry refuses a superseded version, so a renewal cannot walk backwards", async () => {
    rows = {
      "certificate:one": [
        {
          certificateId: CERTIFICATE,
          inspectionDate: "2025-09-20",
          nextDueDate: "2026-09-19",
          status: "superseded",
          jobId: JOB,
          propertyId: "prop-1",
          agentOrganisationId: "org-1",
          productId: "cp12",
        },
      ],
    };

    const result = await updateRenewalFromCertificate({
      session: ADMIN as never,
      jobId: JOB,
      certificateId: CERTIFICATE,
    });

    assert.equal(result.ok, false);
    assert.equal(cycles().length, 0);
  });
});

describe("who may do it", () => {
  test("an agent cannot release a certificate", async () => {
    await assert.rejects(() =>
      releaseCertificate({
        session: {
          user: { id: "u-2", email: "agent@fixture.example.invalid", role: "agent_admin" },
          scope: { kind: "organisation", organisationId: "org-1" },
        } as never,
        jobId: JOB,
        documentId: DOCUMENT,
        details: DETAILS,
        today: "2026-09-21",
      }),
    );
    assert.equal(cycles().length, 0);
  });

  test("an engineer cannot move a renewal", async () => {
    /*
      An engineer *does* hold `certificate:issue` — they produce the document.
      What stops them here is the scope: releasing and correcting a renewal are
      BSCJ's, and the check is on the session rather than on the screen.
    */
    const result = await updateRenewalFromCertificate({
      session: {
        user: { id: "u-3", email: "engineer@fixture.example.invalid", role: "engineer" },
        scope: { kind: "assigned", userId: "u-3" },
      } as never,
      jobId: JOB,
      certificateId: CERTIFICATE,
    });

    assert.equal(result.ok, false);
    assert.equal(cycles().length, 0);
  });

  test("an engineer cannot release one either", async () => {
    const result = await releaseCertificate({
      session: {
        user: { id: "u-3", email: "engineer@fixture.example.invalid", role: "engineer" },
        scope: { kind: "assigned", userId: "u-3" },
      } as never,
      jobId: JOB,
      documentId: DOCUMENT,
      details: DETAILS,
      today: "2026-09-21",
    });

    assert.equal(result.ok, false);
    assert.equal(cycles().length, 0);
  });
});
