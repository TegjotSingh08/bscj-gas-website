import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  digestFor,
  envelopeFor,
  ENVELOPE_MAX_AGE_SECONDS,
  openEnvelope,
  sealEnvelope,
  type ImportEnvelope,
} from "./envelope";
import type { PlannedRow, Resolution } from "./plan";
import type { ImportRecord } from "./rows";

/**
 * Carrying a reviewed plan from the preview to the confirmation.
 *
 * What is being proved: the browser holds the plan but cannot change it, one
 * agency's plan cannot be confirmed by another, and the same review submitted
 * twice is recognisable as the same review.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const RIVAL = "22222222-2222-4222-8222-222222222222";

let saved: string | undefined;
before(() => {
  saved = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "test-secret-for-import-envelopes";
});
after(() => {
  if (saved === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = saved;
});

const record = (key: string): ImportRecord => ({
  landlord: {
    name: "A Landlord",
    company: null,
    email: "landlord@example.invalid",
    phone: "01902 000000",
  },
  property: {
    houseOrName: "14",
    street: "Example Street",
    town: null,
    postcode: "WV1 1AA",
    accessNotes: null,
  },
  tenancy: null,
  compliance: null,
  key,
});

const rows: PlannedRow[] = [
  { line: 2, action: "create", record: record("WV1 1AA|14"), address: "14" },
  {
    line: 3,
    action: "conflict",
    record: record("WV1 1AA|16"),
    address: "16",
    existingPropertyId: "p1",
    conflictsApplicable: true,
  },
  { line: 4, action: "error", address: "18", errors: [] },
  { line: 5, action: "unchanged", record: record("WV1 1AA|20"), address: "20" },
  {
    line: 6,
    action: "duplicate_in_file",
    record: record("WV1 1AA|14"),
    address: "14",
  },
];

const DIGEST = "v2|landlordName=Owner|unknown|auto|uk|reject_row";

const build = (organisationId = ACME, now?: Date, digest = DIGEST) =>
  envelopeFor({
    organisationId,
    filename: "portfolio.csv",
    rows,
    profileDigest: digest,
    now,
  });

describe("only the rows that could write are carried", () => {
  test("errors, duplicates and unchanged rows are dropped", () => {
    // They are reported on screen and then left behind. Carrying them would
    // triple the envelope to describe work that is not going to happen.
    const envelope = build();
    assert.equal(envelope.writes.length, 2);
    assert.deepEqual(
      envelope.writes.map((write) => write.line),
      [2, 3],
    );
  });

  test("the reviewed count still reflects the whole file", () => {
    assert.equal(build().reviewed, rows.length);
  });

  test("applicability is carried under the signature, not recomputed later", () => {
    const envelope = build();
    const conflict = envelope.writes.find((write) => write.action === "conflict");
    assert.equal(conflict?.applicable, true);
  });
});

describe("the browser holds it but cannot change it", () => {
  test("a round trip preserves the plan", () => {
    const envelope = build();
    const opened = openEnvelope(sealEnvelope(envelope), ACME);
    assert.ok(opened);
    assert.equal(opened.writes.length, 2);
    assert.equal(opened.writes[0].record.property.postcode, "WV1 1AA");
  });

  test("an edited payload is refused", () => {
    const sealed = sealEnvelope(build());
    const [payload, signature] = sealed.split(".");
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as ImportEnvelope;

    // The edit somebody would actually attempt: reach into another agency.
    decoded.organisationId = RIVAL;
    const forged =
      Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url") +
      "." +
      signature;

    assert.equal(openEnvelope(forged, RIVAL), null);
    assert.equal(openEnvelope(forged, ACME), null);
  });

  test("a row added by hand is refused", () => {
    const sealed = sealEnvelope(build());
    const [payload, signature] = sealed.split(".");
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as ImportEnvelope;
    decoded.writes.push({
      line: 99,
      action: "create",
      record: record("WV1 9ZZ|99"),
    });
    const forged =
      Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url") +
      "." +
      signature;
    assert.equal(openEnvelope(forged, ACME), null);
  });

  test("a mangled or absent envelope is refused, never thrown", () => {
    for (const value of [undefined, "", "nonsense", "a.b", ".", "x."]) {
      assert.equal(openEnvelope(value, ACME), null, String(value));
    }
  });
});

describe("one agency's plan cannot be confirmed by another", () => {
  test("a genuine envelope opened under the wrong organisation is refused", () => {
    // The organisation is passed in from `requireAgent()` and compared, rather
    // than read out of the envelope and trusted. That ordering is the point.
    const sealed = sealEnvelope(build(ACME));
    assert.ok(openEnvelope(sealed, ACME));
    assert.equal(openEnvelope(sealed, RIVAL), null);
  });
});

describe("a reviewed plan is a decision taken at a moment", () => {
  test("an expired envelope is refused", () => {
    const issued = new Date("2026-09-19T10:00:00.000Z");
    const sealed = sealEnvelope(build(ACME, issued));
    const later = new Date(
      issued.getTime() + (ENVELOPE_MAX_AGE_SECONDS + 1) * 1000,
    );
    assert.equal(openEnvelope(sealed, ACME, later), null);
  });

  test("one still inside its window is accepted", () => {
    const issued = new Date("2026-09-19T10:00:00.000Z");
    const sealed = sealEnvelope(build(ACME, issued));
    const later = new Date(issued.getTime() + 60 * 1000);
    assert.ok(openEnvelope(sealed, ACME, later));
  });

  test("an envelope from the future is refused", () => {
    const issued = new Date("2026-09-19T12:00:00.000Z");
    const sealed = sealEnvelope(build(ACME, issued));
    assert.equal(
      openEnvelope(sealed, ACME, new Date("2026-09-19T10:00:00.000Z")),
      null,
    );
  });
});

describe("the digest is what makes confirmation retry-safe", () => {
  const skipAll = new Map<number, Resolution>();

  test("the same review with the same answers digests the same", () => {
    // A refresh, a double-click or a second tab must be recognised.
    const envelope = build();
    assert.equal(digestFor(envelope, skipAll), digestFor(envelope, skipAll));
  });

  test("different answers are a different import, and are allowed to run", () => {
    const envelope = build();
    const applied = new Map<number, Resolution>([[3, "update"]]);
    assert.notEqual(digestFor(envelope, skipAll), digestFor(envelope, applied));
  });

  test("uploading the same file again is a new review", () => {
    /*
      The nonce is what makes this true. Without it, one successful import
      would permanently block re-importing the same spreadsheet — which an
      agent legitimately does after fixing the rows that failed.
    */
    assert.notEqual(digestFor(build(), skipAll), digestFor(build(), skipAll));
  });

  test("two agencies importing identical files do not collide", () => {
    const acme = build(ACME);
    const rival = { ...build(RIVAL), nonce: acme.nonce, issuedAt: acme.issuedAt };
    assert.notEqual(digestFor(acme, skipAll), digestFor(rival, skipAll));
  });
});

describe("failing closed without a secret", () => {
  test("nothing can be sealed", () => {
    const envelope = build();
    const secret = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      assert.throws(() => sealEnvelope(envelope));
    } finally {
      process.env.AUTH_SECRET = secret;
    }
  });

  test("opening refuses rather than throwing", () => {
    const sealed = sealEnvelope(build());
    const secret = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      assert.equal(openEnvelope(sealed, ACME), null);
    } finally {
      process.env.AUTH_SECRET = secret;
    }
  });
});

describe("a changed import profile invalidates an outstanding preview", () => {
  /*
    A preview is a promise about what confirming will write, computed under
    BSCJ's reading of this agency's export at that moment. If that reading is
    corrected in between — the second name column is a caretaker, not a tenant
    — confirming the old preview would write records the agent reviewed under a
    reading nobody holds any more.
  */

  test("the digest travels inside the signature", () => {
    const envelope = build();
    assert.equal(envelope.profileDigest, DIGEST);
    const opened = openEnvelope(sealEnvelope(envelope), ACME, undefined, DIGEST);
    assert.ok(opened);
    assert.equal(opened.profileDigest, DIGEST);
  });

  test("an unchanged profile still opens", () => {
    assert.ok(
      openEnvelope(sealEnvelope(build()), ACME, new Date(), DIGEST),
    );
  });

  test("a changed profile is REFUSED, not merged", () => {
    const sealed = sealEnvelope(build());
    const changed = "v2|landlordName=Owner|tenant|auto|uk|reject_row";
    assert.equal(openEnvelope(sealed, ACME, new Date(), changed), null);
  });

  test("the browser cannot edit the digest to make it agree", () => {
    const sealed = sealEnvelope(build());
    const [payload, signature] = sealed.split(".");
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as ImportEnvelope;
    decoded.profileDigest = "v2|whatever|tenant|auto|uk|reject_row";
    const forged =
      Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url") +
      "." +
      signature;
    assert.equal(
      openEnvelope(forged, ACME, new Date(), decoded.profileDigest),
      null,
    );
  });

  test("omitting the current digest does not weaken the other checks", () => {
    // Callers that genuinely have no profile to compare still get the
    // organisation, signature and expiry checks.
    const sealed = sealEnvelope(build(ACME));
    assert.ok(openEnvelope(sealed, ACME));
    assert.equal(openEnvelope(sealed, RIVAL), null);
  });
});
