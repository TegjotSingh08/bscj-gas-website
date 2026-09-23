import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import {
  attestedContentHash,
  describeMissingSignatures,
  normaliseSignatureImage,
  pruneSignatures,
  sanitiseSignatures,
  SIGNATURE_MAX_DATA_URL_LENGTH,
  type CertificateSignatures,
} from "./certificate-signatures";

/**
 * What a signature is allowed to be, and when it stops being true.
 *
 * These are the rules the workflow rests on, tested where they are decided
 * rather than through a browser: an image is an image and not a name, a mark
 * covers a stated set of fields, and changing those fields removes it.
 */

/* ---------------- A real PNG, built rather than pasted ---------------- */

const CRC_TABLE = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A genuine RGBA PNG of the given size, as a canvas would hand one over. */
function pngBytes(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 4));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngDataUrl(width = 120, height = 40): string {
  return "data:image/png;base64," + pngBytes(width, height).toString("base64");
}

/* ---------------- A record, as the generator collects one ---------------- */

function record(overrides: Record<string, string> = {}) {
  return {
    certNo: "TEST-NOT-VALID-0001",
    instEngineer: "Fixture Engineer",
    jobAddress: "14 Fixture Street, Wolverhampton",
    sigDate: "20/09/2026",
    issuedPrintName: "Fixture Engineer",
    app_1_location: "Kitchen",
    app_1_highCO: "12",
    coFitted: "yes",
    ...overrides,
  };
}

function signedAt(
  fields: Record<string, string>,
  role: "issued" | "received" = "issued",
): CertificateSignatures {
  return {
    [role]: {
      dataUrl: pngDataUrl(),
      capturedAt: "2026-09-20T10:00:00.000Z",
      capturedAtRevision: 4,
      contentHash: attestedContentHash(fields, role),
    },
  };
}

describe("what may be stored as a signature", () => {
  test("a PNG the pad produced is accepted and re-encoded canonically", () => {
    const result = normaliseSignatureImage(pngDataUrl());
    assert.ok(result.ok);
    assert.ok(result.dataUrl.startsWith("data:image/png;base64,"));
    /*
      Re-encoded from the decoded bytes rather than passed through: what is
      stored is exactly what was checked, with nothing carried past in the
      encoding.
    */
    const round = normaliseSignatureImage(result.dataUrl);
    assert.ok(round.ok);
    assert.equal(round.dataUrl, result.dataUrl);
  });

  test("whitespace around it is tolerated; the payload is not changed", () => {
    const clean = normaliseSignatureImage(pngDataUrl());
    const padded = normaliseSignatureImage("  " + pngDataUrl() + "\n");
    assert.ok(clean.ok && padded.ok);
    assert.equal(padded.dataUrl, clean.dataUrl);
  });

  test("a name is not a signature, and there is no way to make it one", () => {
    for (const notASignature of [
      "Fixture Engineer",
      "",
      "   ",
      null,
      undefined,
      42,
      { dataUrl: pngDataUrl() },
    ]) {
      const result = normaliseSignatureImage(notASignature);
      assert.equal(result.ok, false, String(notASignature));
    }
  });

  test("a data URL that only claims to be a PNG is refused", () => {
    const lying =
      "data:image/png;base64," +
      Buffer.from("<script>alert(1)</script>").toString("base64");
    const result = normaliseSignatureImage(lying);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.match(result.error, /not a signature this form produced/i);
  });

  test("another image format is refused rather than stored as a PNG", () => {
    const jpeg =
      "data:image/jpeg;base64," +
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
    assert.equal(normaliseSignatureImage(jpeg).ok, false);
  });

  test("an SVG, which could carry script, never reaches the box", () => {
    const svg =
      "data:image/svg+xml;base64," +
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString(
        "base64",
      );
    assert.equal(normaliseSignatureImage(svg).ok, false);
  });

  test("something far too big for a signature is refused", () => {
    const huge = "data:image/png;base64," + "A".repeat(SIGNATURE_MAX_DATA_URL_LENGTH);
    const result = normaliseSignatureImage(huge);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.match(result.error, /too large/i);
  });

  test("a photograph-sized image is refused even when it is a valid PNG", () => {
    const result = normaliseSignatureImage(pngDataUrl(5000, 20));
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.match(result.error, /too large/i);
  });
});

describe("what a mark covers", () => {
  test("the same record hashes the same however it is written down", () => {
    const a = attestedContentHash(record(), "issued");
    const b = attestedContentHash(
      { ...record(), certNo: "  TEST-NOT-VALID-0001  ", comments: "" },
      "issued",
    );
    assert.equal(a, b, "trimming and blanks are not changes");
  });

  test("an absent field and an empty one are the same thing", () => {
    const withEmpty = record({ comments: "" });
    const without = record();
    assert.equal(
      attestedContentHash(withEmpty, "issued"),
      attestedContentHash(without, "issued"),
    );
  });

  test("a changed reading changes what was signed", () => {
    assert.notEqual(
      attestedContentHash(record(), "issued"),
      attestedContentHash(record({ app_1_highCO: "48" }), "issued"),
    );
  });

  test("a changed outcome changes what was signed", () => {
    assert.notEqual(
      attestedContentHash(record(), "issued"),
      attestedContentHash(record({ coFitted: "no" }), "issued"),
    );
  });

  test("the engineer does not attest to who took the copy", () => {
    /*
      Typing the tenant's name after the engineer has signed is the ordinary
      order of a doorstep visit. It is not a change to what the engineer
      certified, so it does not take their mark off.
    */
    assert.equal(
      attestedContentHash(record(), "issued"),
      attestedContentHash(record({ receivedPrintName: "A Tenant" }), "issued"),
    );
  });

  test("the person receiving it does attest to their own name", () => {
    assert.notEqual(
      attestedContentHash(record(), "received"),
      attestedContentHash(record({ receivedPrintName: "A Tenant" }), "received"),
    );
  });

  test("the person receiving it attests to the whole document", () => {
    assert.notEqual(
      attestedContentHash(record(), "received"),
      attestedContentHash(record({ app_1_highCO: "48" }), "received"),
    );
  });

  test("a field that never prints changes neither", () => {
    const picked = record({ landlordSelect2: "3" });
    assert.equal(
      attestedContentHash(record(), "issued"),
      attestedContentHash(picked, "issued"),
    );
    assert.equal(
      attestedContentHash(record(), "received"),
      attestedContentHash(picked, "received"),
    );
  });

  test("a key the draft does not carry cannot influence a hash", () => {
    assert.equal(
      attestedContentHash(record(), "issued"),
      attestedContentHash({ ...record(), somethingElse: "x" }, "issued"),
    );
  });
});

describe("a signature stops being true when the record changes", () => {
  test("an untouched record keeps its mark", () => {
    const fields = record();
    const pruned = pruneSignatures(signedAt(fields), fields);
    assert.ok(pruned.signatures.issued);
    assert.deepEqual(pruned.cleared, []);
  });

  test("a corrected reading takes the engineer's mark off, and says so", () => {
    const pruned = pruneSignatures(
      signedAt(record()),
      record({ app_1_highCO: "48" }),
    );
    assert.equal(pruned.signatures.issued, undefined);
    assert.deepEqual(pruned.cleared, ["issued"]);
  });

  test("each mark is judged on its own", () => {
    const fields = record();
    const both: CertificateSignatures = {
      ...signedAt(fields, "issued"),
      ...signedAt(fields, "received"),
    };
    /*
      Adding the received name is not a change to what the engineer
      certified, but it *is* a change to the document the other person
      acknowledged — so one survives and one does not.
    */
    const pruned = pruneSignatures(both, record({ receivedPrintName: "A Tenant" }));
    assert.ok(pruned.signatures.issued);
    assert.equal(pruned.signatures.received, undefined);
    assert.deepEqual(pruned.cleared, ["received"]);
  });

  test("a mark whose hash was tampered with does not survive", () => {
    const fields = record();
    const forged = signedAt(fields);
    forged.issued!.contentHash = "0".repeat(64);
    assert.deepEqual(pruneSignatures(forged, fields).cleared, ["issued"]);
  });
});

describe("what is read back out of the column", () => {
  test("a stored mark round-trips", () => {
    const fields = record();
    const stored = sanitiseSignatures(JSON.parse(JSON.stringify(signedAt(fields))));
    assert.ok(stored.issued);
    assert.equal(stored.issued.contentHash, attestedContentHash(fields, "issued"));
  });

  test("an entry with no usable image is not a signature", () => {
    assert.deepEqual(
      sanitiseSignatures({
        issued: { dataUrl: "Fixture Engineer", contentHash: "abc" },
      }),
      {},
    );
  });

  test("an entry with no hash is not a signature, because it covers nothing", () => {
    assert.deepEqual(
      sanitiseSignatures({ issued: { dataUrl: pngDataUrl() } }),
      {},
    );
  });

  test("a role the certificate does not have is dropped", () => {
    const stored = sanitiseSignatures({
      witness: { dataUrl: pngDataUrl(), contentHash: "abc" },
    });
    assert.deepEqual(Object.keys(stored), []);
  });

  test("junk in the column reads as nothing signed", () => {
    for (const junk of [null, undefined, "", 7, [], "issued"]) {
      assert.deepEqual(sanitiseSignatures(junk), {});
    }
  });
});

describe("what the signature row has to have before a record is submitted", () => {
  test("the engineer's mark is required", () => {
    assert.deepEqual(describeMissingSignatures(record(), {}), [
      "Engineer signature",
    ]);
  });

  test("a record signed as it stands is complete", () => {
    const fields = record();
    assert.deepEqual(describeMissingSignatures(fields, signedAt(fields)), []);
  });

  test("a mark left over from before an edit does not count as one", () => {
    assert.deepEqual(
      describeMissingSignatures(record({ app_1_highCO: "48" }), signedAt(record())),
      ["Engineer signature (the record changed after it was signed)"],
    );
  });

  test("nobody being there to receive it does not make the record incomplete", () => {
    /*
      **Deliberate, and the honest way round.** A property can be empty, a
      tenant can be out, and a landlord can ask for the certificate by email.
      Requiring a mark in that box would not produce one — it would produce an
      engineer drawing it themselves.
    */
    const fields = record();
    assert.deepEqual(
      describeMissingSignatures(fields, signedAt(fields, "issued")),
      [],
    );
  });
});
