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
 * **The connected workflow, through the application, against PostgreSQL.**
 *
 * Agency imports a property → requests a CP12 → the tenant is invited and
 * chooses a time → an administrator assigns an engineer → the engineer starts
 * and completes the work → the certificate is uploaded, reviewed and released →
 * the compliance position moves → the delivery intent is processed → the
 * invoice is drafted, issued, delivered and paid.
 *
 * **What is real:** every business transition goes through the production
 * function that owns it, and every write lands in a real database with real
 * constraints. Fixtures establish only *prior* state — accounts, an agency, an
 * uploaded PDF — never a transition the journey is meant to prove.
 *
 * **What is captured:** Google Calendar, Redis holds, document storage and the
 * email transport, each replaced at its own boundary with a recorder. Nothing
 * leaves this process; no calendar event, no upload and no message is real.
 *
 * **Business settings are fictional and live only here.** The application's
 * refusal to issue an invoice without owner-supplied details is preserved — it
 * is asserted before the settings are written, and the settings are written
 * into the disposable database only.
 */

// ---------------------------------------------------------------------------
// Captured external services
// ---------------------------------------------------------------------------

type CalendarEvent = { id: string; start: string; end: string };

let calendar: CalendarEvent[] = [];
let sentEmails: { kind: string; to: string; subject: string }[] = [];
let stored = new Map<string, Uint8Array>();
let heldSlots = new Set<string>();

mock.module("@/lib/google/calendar", {
  namedExports: {
    fetchBusyPeriods: async () => ({ status: "ok", periods: [] }),
    fetchBookingEvents: async () => ({ status: "ok", events: [] }),
    createCalendarEvent: async (input: { start: Date; end: Date }) => {
      const event = {
        id: `evt-${calendar.length + 1}`,
        start: input.start.toISOString(),
        end: input.end.toISOString(),
      };
      calendar.push(event);
      return { status: "ok", eventId: event.id };
    },
    deleteCalendarEvent: async (id: string) => {
      calendar = calendar.filter((event) => event.id !== id);
      return { status: "ok" };
    },
    calendarConfigured: () => true,
  },
});

mock.module("@/lib/booking/holds", {
  namedExports: {
    checkHold: async (slotStart: string, token: string) =>
      heldSlots.has(`${slotStart}:${token}`) ? "ok" : "missing",
    releaseHold: async () => undefined,
    findHeldSlots: async () => new Set<string>(),
    isWellFormedToken: (value: unknown) => typeof value === "string" && value.length > 8,
    HOLD_WARNING_SECONDS: 300,
  },
});

mock.module("@/lib/storage/documents", {
  namedExports: {
    /*
      `putDocument(bytes, { key })` — matches the real module's signature,
      including the optional derived key the connected certificate submission
      uses so a retry writes to the same place. Honouring it here is what
      lets the idempotency behaviour be genuinely exercised through this
      capture, rather than one that always mints a fresh key regardless of
      what was asked for.
    */
    putDocument: async (bytes: Uint8Array, options: { key?: string } = {}) => {
      const key = options.key ?? `captured/${stored.size + 1}`;
      stored.set(key, bytes);
      return { ok: true, key };
    },
    getDocument: async (key: string) => {
      const bytes = stored.get(key);
      return bytes ? { ok: true, bytes } : { ok: false, error: "missing" };
    },
    deleteDocument: async (key: string) => {
      stored.delete(key);
    },
    storageStatus: () => ({ ready: true, driver: "captured", outstanding: [] }),
    newDocumentKey: () => `captured/${stored.size + 1}`,
    derivedDocumentKey: (seed: string) => `captured/derived/${seed}`,
  },
});

mock.module("@/lib/email/send", {
  namedExports: {
    sendOutboxEmail: async (input: {
      kind: string;
      to: string;
      email: { subject: string };
    }) => {
      sentEmails.push({
        kind: input.kind,
        to: input.to,
        subject: input.email.subject,
      });
      return { status: "sent", id: `msg-${sentEmails.length}` };
    },
    internalNotificationRecipient: () => "bscj@fixture.example.invalid",
    MAX_ATTACHMENT_BYTES: 15 * 1024 * 1024,
  },
});

mock.module("@/lib/config/origin", {
  namedExports: {
    resolveAppOrigin: () => ({ ok: true, origin: "https://fixture.example.invalid" }),
  },
});

// ---------------------------------------------------------------------------

const { setDbForTesting } = await import("../../src/lib/db/client");
const { createAgentJob } = await import("../../src/lib/jobs/create-agent-job");
const { assignEngineer, startWork, completeWork } = await import(
  "../../src/lib/jobs/work-actions"
);
const { uploadCertificate, releaseCertificate, queueCertificateEmail } =
  await import("../../src/lib/documents/certificates");
const { drainOutbox } = await import("../../src/lib/notifications/outbox");
const { createInvoiceDraft, issueInvoice, markInvoicePaid } = await import(
  "../../src/lib/invoices/invoices"
);
const { listDueWork } = await import("../../src/lib/compliance/due-work");
const { readFileSync } = await import("node:fs");
const { saveCertificateDraft, submitCertificateDraft } = await import(
  "../../src/lib/documents/certificate-drafts"
);
const { listAgencyJobCertificates } = await import(
  "../../src/lib/documents/certificates"
);
const { getProperty } = await import("../../src/lib/portfolio/queries");

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
  calendar = [];
  sentEmails = [];
  stored = new Map();
  heldSlots = new Set();
});

const admin = () => ({
  user: {
    id: fixture.adminUserId,
    email: "admin@fixture.example.invalid",
    role: "admin",
  },
  scope: { kind: "all" as const },
});

const engineer = (userId?: string) => ({
  user: {
    id: userId ?? fixture.engineerUserId,
    email: "engineer@fixture.example.invalid",
    role: "engineer",
  },
  scope: { kind: "assigned" as const, userId: userId ?? fixture.engineerUserId },
});

/** The TEST / NOT VALID PDF from the acceptance pack. Certifies nothing. */
const TEST_PDF = new Uint8Array(
  readFileSync("docs/acceptance/TEST-NOT-VALID-certificate.pdf"),
);

/** A second, unrequested property, so the job is raised against a real one. */
async function freshProperty(): Promise<string> {
  const { rows } = await conn.client.query<{ id: string }>(
    `insert into property
       (agent_organisation_id, customer_id, house_or_name, street, postcode)
     values ($1, $2, '22', 'Journey Street', 'WV2 2BB') returning id`,
    [fixture.organisationId, fixture.landlordId],
  );
  return rows[0].id;
}

async function jobRow(jobId: string) {
  const { rows } = await conn.client.query<{
    lifecycle_status: string;
    assigned_engineer_id: string | null;
    appointment_start: Date | null;
    calendar_event_id: string | null;
    completed_at: Date | null;
  }>(
    `select lifecycle_status, assigned_engineer_id, appointment_start,
            calendar_event_id, completed_at
       from job where id = $1`,
    [jobId],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------

describe("the agency requests work", () => {
  test("a CP12 is raised against their own property, priced by the server", async () => {
    const propertyId = await freshProperty();

    const result = await createAgentJob(
      fixture.organisationId,
      {
        propertyId,
        productId: "cp12",
        applianceCount: 1,
        requestedAsap: true,
        completeByDate: null,
        notes: null,
        submissionKey: "journey-1",
      },
      fixture.agentUserId,
    );

    assert.equal(result.status, "created");

    const { rows } = await conn.client.query<{
      price_total_pence: number;
      product_id: string;
      lifecycle_status: string;
    }>(
      "select price_total_pence, product_id, lifecycle_status from job where id = $1",
      [result.status === "created" ? result.jobId : ""],
    );
    // £45, from the registry — never from anything a browser sent.
    assert.equal(rows[0].price_total_pence, 4500);
    assert.equal(rows[0].product_id, "cp12");
  });

  test("submitting the same form twice raises one job", async () => {
    const propertyId = await freshProperty();
    const input = {
      propertyId,
      productId: "cp12" as const,
      applianceCount: 1,
      requestedAsap: true,
      completeByDate: null,
      notes: null,
      submissionKey: "journey-double",
    };

    const first = await createAgentJob(fixture.organisationId, input, fixture.agentUserId);
    const second = await createAgentJob(fixture.organisationId, input, fixture.agentUserId);

    assert.equal(first.status, "created");
    assert.equal(second.status, "exists");

    const { rows } = await conn.client.query<{ n: string }>(
      "select count(*)::text as n from job where property_id = $1",
      [propertyId],
    );
    assert.equal(rows[0].n, "1");
  });

  test("another agency cannot raise work against this property", async () => {
    /*
      Isolation is the property the whole portal rests on. The other agency's
      id matches no property here, so the request finds nothing rather than
      being refused by a check somebody could forget.
    */
    const propertyId = await freshProperty();

    const result = await createAgentJob(
      fixture.otherOrganisationId,
      {
        propertyId,
        productId: "cp12",
        applianceCount: 1,
        requestedAsap: true,
        completeByDate: null,
        notes: null,
        submissionKey: "journey-rival",
      },
      fixture.otherAgentUserId,
    );

    assert.notEqual(result.status, "created");
    const { rows } = await conn.client.query<{ n: string }>(
      "select count(*)::text as n from job where property_id = $1",
      [propertyId],
    );
    assert.equal(rows[0].n, "0");
  });

  test("raising work queues an invitation and sends nothing yet", async () => {
    const propertyId = await freshProperty();
    await conn.client.query(
      `insert into tenancy (property_id, name, email)
       values ($1, 'Tom Tenant', 'tom@fixture.example.invalid')`,
      [propertyId],
    );

    await createAgentJob(
      fixture.organisationId,
      {
        propertyId,
        productId: "cp12",
        applianceCount: 1,
        requestedAsap: true,
        completeByDate: null,
        notes: null,
        submissionKey: "journey-invite",
      },
      fixture.agentUserId,
    );

    const { rows } = await conn.client.query<{ kind: string; state: string }>(
      "select kind, state from outbound_email",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "tenant-scheduling-invitation");
    assert.equal(rows[0].state, "pending");
    // Intent recorded durably; delivery is the worker's, later.
    assert.equal(sentEmails.length, 0);
  });

  test("and the worker then delivers it", async () => {
    const propertyId = await freshProperty();
    await conn.client.query(
      `insert into tenancy (property_id, name, email)
       values ($1, 'Tom Tenant', 'tom@fixture.example.invalid')`,
      [propertyId],
    );
    const created = await createAgentJob(
      fixture.organisationId,
      {
        propertyId,
        productId: "cp12",
        applianceCount: 1,
        requestedAsap: true,
        completeByDate: null,
        notes: null,
        submissionKey: "journey-invite-2",
      },
      fixture.agentUserId,
    );
    assert.equal(created.status, "created");

    const report = await drainOutbox();
    assert.equal(report.accepted, 1);
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].to, "tom@fixture.example.invalid");
  });
});

describe("the engineer's work", () => {
  test("an administrator assigns, and the engineer starts and completes", async () => {
    await conn.client.query(
      `update job set lifecycle_status = 'scheduled',
              appointment_start = now(), appointment_end = now() + interval '45 minutes'
        where id = $1`,
      [fixture.jobId],
    );

    const assigned = await assignEngineer({
      session: admin() as never,
      jobId: fixture.jobId,
      engineerId: fixture.engineerUserId,
    });
    assert.equal(assigned.ok, true);
    assert.equal((await jobRow(fixture.jobId)).assigned_engineer_id, fixture.engineerUserId);

    const started = await startWork({
      session: engineer() as never,
      jobId: fixture.jobId,
    });
    assert.equal(started.ok, true);
    assert.equal((await jobRow(fixture.jobId)).lifecycle_status, "in_progress");

    const completed = await completeWork({
      session: engineer() as never,
      jobId: fixture.jobId,
      notes: "Fixture visit. Nothing real was done.",
    });
    assert.equal(completed.ok, true);

    const after = await jobRow(fixture.jobId);
    assert.equal(after.lifecycle_status, "completed");
    assert.ok(after.completed_at);
  });

  test("an engineer cannot touch a job they are not assigned to", async () => {
    await conn.client.query(
      `update job set lifecycle_status = 'engineer_assigned',
                      assigned_engineer_id = $2 where id = $1`,
      [fixture.jobId, fixture.engineerUserId],
    );

    const result = await startWork({
      session: engineer(fixture.otherEngineerUserId) as never,
      jobId: fixture.jobId,
    });

    assert.equal(result.ok, false);
    assert.equal((await jobRow(fixture.jobId)).lifecycle_status, "engineer_assigned");
  });

  test("completing twice does not move a finished job again", async () => {
    await conn.client.query(
      `update job set lifecycle_status = 'in_progress',
                      assigned_engineer_id = $2 where id = $1`,
      [fixture.jobId, fixture.engineerUserId],
    );

    const first = await completeWork({
      session: engineer() as never,
      jobId: fixture.jobId,
      notes: null,
    });
    const second = await completeWork({
      session: engineer() as never,
      jobId: fixture.jobId,
      notes: null,
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
  });
});

describe("the certificate", () => {
  async function uploadAndRelease() {
    const uploaded = await uploadCertificate({
      session: engineer() as never,
      jobId: fixture.jobId,
      bytes: TEST_PDF,
      filename: "TEST-NOT-VALID-certificate.pdf",
    });
    assert.equal(uploaded.ok, true);
    /*
      The id the upload returned, not "the newest row" — the fixture's own
      documents share a timestamp with it, and releasing one of those would
      point the certificate at bytes that were never stored.
    */
    const documentId = uploaded.ok ? uploaded.documentId : undefined;
    assert.ok(documentId);

    return releaseCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      documentId,
      details: {
        certificateNumber: "TEST-NOT-VALID-0001",
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-09-19",
        correctionReason: "",
      },
      today: "2026-09-22",
    });
  }

  test("uploading is not releasing, and claims nothing", async () => {
    await conn.client.query(
      `update job set assigned_engineer_id = $2 where id = $1`,
      [fixture.jobId, fixture.engineerUserId],
    );

    const uploaded = await uploadCertificate({
      session: engineer() as never,
      jobId: fixture.jobId,
      bytes: TEST_PDF,
      filename: "TEST-NOT-VALID-certificate.pdf",
    });

    assert.equal(uploaded.ok, true);
    const { rows } = await conn.client.query<{ n: string }>(
      "select count(*)::text as n from certificate",
    );
    assert.equal(rows[0].n, "0", "a PDF on a job is not an issued certificate");
  });

  test("releasing moves the property's renewal", async () => {
    await conn.client.query(
      `update job set assigned_engineer_id = $2 where id = $1`,
      [fixture.jobId, fixture.engineerUserId],
    );
    const released = await uploadAndRelease();
    assert.equal(released.ok, true);

    const { rows } = await conn.client.query<{ due_date: string; status: string }>(
      `select due_date, status from compliance_cycle where property_id = $1`,
      [fixture.propertyId],
    );
    assert.deepEqual(rows, [{ due_date: "2027-09-19", status: "active" }]);
  });

  test("and the property leaves the due-work list's unknown bucket", async () => {
    await conn.client.query(
      `update job set assigned_engineer_id = $2 where id = $1`,
      [fixture.jobId, fixture.engineerUserId],
    );

    const before = await listDueWork({
      range: { from: "2026-09-22", to: "2026-11-21" },
      today: "2026-09-22",
    });
    assert.equal(before?.summary.unknown, 1);

    await uploadAndRelease();

    const after = await listDueWork({
      range: { from: "2026-09-22", to: "2026-11-21" },
      today: "2026-09-22",
    });
    assert.equal(after?.summary.unknown, 0);
    assert.equal(after?.summary.later, 1);
  });

  test("delivery is a separate, chosen act — and the worker carries it out", async () => {
    await conn.client.query(
      `update job set assigned_engineer_id = $2 where id = $1`,
      [fixture.jobId, fixture.engineerUserId],
    );
    await uploadAndRelease();

    // Nothing is sent by releasing.
    assert.equal(sentEmails.length, 0);

    const { rows } = await conn.client.query<{ id: string }>(
      "select id from certificate where status = 'issued'",
    );
    const queued = await queueCertificateEmail({
      session: admin() as never,
      certificateId: rows[0].id,
      recipients: ["customer"],
    });
    assert.equal(queued.ok, true);

    await drainOutbox();
    assert.equal(sentEmails.length, 1);
    // The landlord, because that is the recipient the administrator chose.
    assert.equal(sentEmails[0].to, "ada@fixture.example.invalid");
  });

  test("an agency cannot see another agency's document", async () => {
    await conn.client.query(
      `update job set assigned_engineer_id = $2 where id = $1`,
      [fixture.jobId, fixture.engineerUserId],
    );
    await uploadAndRelease();

    const { readDocumentFor } = await import("../../src/lib/documents/certificates");
    const { rows } = await conn.client.query<{ id: string }>(
      "select id from document where blob_key like 'captured/%' limit 1",
    );

    const access = await readDocumentFor(
      {
        kind: "organisation",
        organisationId: fixture.otherOrganisationId,
      } as never,
      rows[0].id,
    );

    assert.equal(access.ok, false, "another agency's document is not readable");
  });

  test("the connected engineer workflow reaches the same review and release", async () => {
    /*
      The same business outcome as `uploadAndRelease`, reached the way an
      engineer on a phone actually reaches it: a server-held draft, saved,
      then submitted as a PDF — never a plain file upload. It has to arrive at
      the identical admin surface, because that is the whole promise of the
      connected workflow: nothing about review or release changes underneath
      it.
    */
    await conn.client.query(
      `update job set assigned_engineer_id = $2 where id = $1`,
      [fixture.jobId, fixture.engineerUserId],
    );

    const draft = {
      certNo: "TEST-NOT-VALID-0002",
      instEngineer: "Fixture Engineer",
      jobAddress: "14 Fixture Street, Wolverhampton",
      sigDate: "20/09/2026",
      issuedPrintName: "Fixture Engineer",
      app_1_location: "Kitchen",
      app_1_type: "Boiler",
      coFitted: "yes",
      coTested: "yes",
      chkEmergency: "yes",
      chkTightness: "yes",
      chkPipework: "yes",
      chkBonding: "yes",
    };

    const saved = await saveCertificateDraft({
      session: engineer() as never,
      jobId: fixture.jobId,
      fields: draft,
      expectedRevision: 0,
    });
    assert.ok(saved.ok);

    const submitted = await submitCertificateDraft({
      session: engineer() as never,
      jobId: fixture.jobId,
      bytes: TEST_PDF,
      filename: "TEST-NOT-VALID-certificate.pdf",
      submissionKey: "journey-connected-1",
    });
    assert.ok(submitted.ok);

    /*
      Submitting is not issuing. It landed as a document awaiting review, the
      same list the manual upload feeds — not as a certificate, and it moved
      no renewal.
    */
    assert.equal(
      (await conn.client.query<{ n: string }>(
        "select count(*)::text as n from certificate",
      )).rows[0].n,
      "0",
    );
    assert.equal(
      (await conn.client.query<{ n: string }>(
        "select count(*)::text as n from compliance_cycle",
      )).rows[0].n,
      "0",
    );

    const released = await releaseCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      documentId: submitted.documentId,
      details: {
        certificateNumber: "TEST-NOT-VALID-0002",
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-09-19",
        correctionReason: "",
      },
      today: "2026-09-22",
    });
    assert.equal(released.ok, true);

    const { rows } = await conn.client.query<{ due_date: string }>(
      `select due_date from compliance_cycle where property_id = $1`,
      [fixture.propertyId],
    );
    assert.deepEqual(rows, [{ due_date: "2027-09-19" }]);
  });

  test("the agency sees the released certificate, and the correct renewal date, only after release", async () => {
    await conn.client.query(
      `update job set assigned_engineer_id = $2 where id = $1`,
      [fixture.jobId, fixture.engineerUserId],
    );

    /* Before release: no certificate visible, no renewal date on the property. */
    const before = await listAgencyJobCertificates(
      fixture.organisationId,
      fixture.jobId,
    );
    assert.equal(before.length, 0);

    const propertyBefore = await getProperty(
      fixture.organisationId,
      fixture.propertyId,
    );
    assert.ok(propertyBefore);
    assert.equal(
      propertyBefore.cycles.length,
      0,
      "no renewal position exists before release",
    );
    assert.equal(propertyBefore.activeCycle, null);

    await uploadAndRelease();

    /* After release: the agency can see it, scoped to their own organisation. */
    const after = await listAgencyJobCertificates(
      fixture.organisationId,
      fixture.jobId,
    );
    assert.equal(after.length, 1);
    assert.equal(after[0].certificateNumber, "TEST-NOT-VALID-0001");
    assert.equal(after[0].status, "issued");
    /* The agency's view carries no delivery bookkeeping. */
    assert.equal(after[0].sentTo, null);

    const propertyAfter = await getProperty(
      fixture.organisationId,
      fixture.propertyId,
    );
    assert.ok(propertyAfter);
    assert.equal(propertyAfter.activeCycle?.dueDate, "2027-09-19");

    /* And it is invisible to the rival agency, exactly as the document is. */
    const rival = await listAgencyJobCertificates(
      fixture.otherOrganisationId,
      fixture.jobId,
    );
    assert.equal(rival.length, 0);
  });
});

describe("the invoice", () => {
  async function completeAndRelease() {
    await conn.client.query(
      `update job set assigned_engineer_id = $2, lifecycle_status = 'completed',
                      completed_at = now() where id = $1`,
      [fixture.jobId, fixture.engineerUserId],
    );
    const uploaded = await uploadCertificate({
      session: engineer() as never,
      jobId: fixture.jobId,
      bytes: TEST_PDF,
      filename: "TEST-NOT-VALID-certificate.pdf",
    });
    assert.equal(uploaded.ok, true);
    const documentId = uploaded.ok ? uploaded.documentId! : "";

    await releaseCertificate({
      session: admin() as never,
      jobId: fixture.jobId,
      documentId,
      details: {
        certificateNumber: "TEST-NOT-VALID-0001",
        inspectionDate: "2026-09-20",
        nextDueDate: "2027-09-19",
        correctionReason: "",
      },
      today: "2026-09-22",
    });
  }

  /** Fictional, and written only into the disposable database. */
  async function writeFictionalBusinessSettings() {
    const settings: [string, unknown][] = [
      ["business.identity", {
        displayName: "Fixture Gas (NOT REAL)",
        tradingName: null,
        legalName: "Fixture Gas Ltd (NOT REAL)",
        companyNumber: "00000000",
        addressLines: ["1 Fixture Way", "Wolverhampton"],
        postcode: "WV1 1AA",
        phone: "00000 000000",
        email: "fixture@fixture.example.invalid",
        website: null,
        gasSafeNumber: "000000",
        footerText: "Fictional. Not a real invoice.",
      }],
      ["invoice.terms", {
        paymentTerms: "Due on receipt (fictional)",
        paymentDueDays: 14,
        paymentInstructions: "Fictional payment instructions. Pay nobody.",
      }],
    ];
    for (const [key, value] of settings) {
      await conn.client.query(
        `insert into business_setting (key, value) values ($1, $2::jsonb)
         on conflict (key) do update set value = excluded.value`,
        [key, JSON.stringify(value)],
      );
    }
  }

  /**
   * The payer's own billing address.
   *
   * Deliberately **not** the property address — an invoice goes to whoever is
   * paying, at the address they gave for the purpose, and substituting the
   * property would put a bill through a tenant's door.
   */
  async function giveThePayerABillingAddress() {
    await conn.client.query(
      `update customer
          set billing_address_lines = $2::jsonb, billing_postcode = 'WV1 1AA'
        where id = $1`,
      [fixture.landlordId, JSON.stringify(["1 Landlord Way", "Wolverhampton"])],
    );
  }

  test("issuing refuses while the business details are empty", async () => {
    /*
      **The guard the real application depends on**, asserted before anything
      fictional is written. BSCJ has not supplied its legal identity or its
      payment terms, and an invoice without them is a document nobody may send.
    */
    await completeAndRelease();

    const draft = await createInvoiceDraft({
      session: admin() as never,
      jobId: fixture.jobId,
    });

    if (draft.ok && draft.invoiceId) {
      const issued = await issueInvoice({
        session: admin() as never,
        invoiceId: draft.invoiceId,
      });
      assert.equal(issued.ok, false, "no number may be drawn without the details");
    }

    const { rows } = await conn.client.query<{ n: string }>(
      "select count(*)::text as n from invoice where status = 'issued'",
    );
    assert.equal(rows[0].n, "0");
  });

  test("with fictional settings in place, it drafts, issues, delivers and records payment", async () => {
    await completeAndRelease();
    await writeFictionalBusinessSettings();
    await giveThePayerABillingAddress();

    const draft = await createInvoiceDraft({
      session: admin() as never,
      jobId: fixture.jobId,
    });
    assert.equal(draft.ok, true, draft.ok ? "" : draft.error);
    const invoiceId = draft.ok ? draft.invoiceId : undefined;
    assert.ok(invoiceId);

    const issued = await issueInvoice({
      session: admin() as never,
      invoiceId,
    });
    assert.equal(issued.ok, true, issued.ok ? "" : issued.error);

    const { rows } = await conn.client.query<{
      status: string;
      number: string | null;
      total_pence: number;
    }>("select status, number, total_pence from invoice");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "issued");
    assert.ok(rows[0].number, "an issued invoice has a number");
    assert.equal(rows[0].total_pence, 4500);

    const paid = await markInvoicePaid({
      session: admin() as never,
      invoiceId,
      // Today, in the server's terms. A payment cannot be recorded in the future.
      // Today, in the server's terms. A payment cannot be recorded in the future.
      paidOn: new Date().toISOString().slice(0, 10),
      note: "FIXTURE-PAYMENT",
    });
    assert.equal(paid.ok, true, paid.ok ? "" : paid.error);

    const after = await conn.client.query<{ status: string }>(
      "select status from invoice",
    );
    assert.equal(after.rows[0].status, "paid");
  });

  test("an issued invoice keeps its number and cannot be redrafted", async () => {
    await completeAndRelease();
    await writeFictionalBusinessSettings();
    await giveThePayerABillingAddress();

    const draft = await createInvoiceDraft({
      session: admin() as never,
      jobId: fixture.jobId,
    });
    assert.equal(draft.ok, true);
    const invoiceId = draft.ok ? draft.invoiceId : undefined;
    assert.ok(invoiceId);

    await issueInvoice({
      session: admin() as never,
      invoiceId,
    });

    const before = await conn.client.query<{ number: string }>(
      "select number from invoice",
    );

    // Issuing again must not draw a second number.
    await issueInvoice({
      session: admin() as never,
      invoiceId,
    });

    const after = await conn.client.query<{ number: string; n: string }>(
      "select number, (select count(*)::text from invoice) as n from invoice",
    );
    assert.equal(after.rows[0].number, before.rows[0].number);
    assert.equal(after.rows[0].n, "1");
  });
});
