import { createHash } from "node:crypto";

import {
  CERTIFICATE_DRAFT_FIELDS,
  type CertificateDraftFields,
} from "./certificate-draft-fields";

/**
 * The two signatures a gas safety record carries, and what keeps one honest.
 *
 * **What the certificate actually asks for.** The sheet's signature row has
 * exactly three columns — *Issued by: Signed*, *Received by: Signed* and
 * *Date* — and each of the first two has a print-name box beside an empty
 * box for the mark. There is **no declaration text** anywhere on the sheet,
 * and none is added here: nothing in this module says what a signature means,
 * because the certificate does not say it either and inventing the wording
 * would be inventing a legal fact.
 *
 * What is modelled is narrower and true:
 *
 * - **Issued by** is the engineer who carried out the inspection. They are
 *   the person holding the device, so their mark is required before the
 *   record may be submitted — an *Issued by: Signed* box left empty on a
 *   document that is about to be released is the gap this exists to close.
 * - **Received by** is whoever was at the property and took a copy. They may
 *   not exist: an empty property, a tenant who has gone out, a landlord who
 *   asked for it by email. It is therefore **optional**, and its absence is
 *   recorded as absence. Nothing here fabricates it, infers it from a typed
 *   name, or carries one across from another certificate.
 *
 * **A signature is bound to what it was put against.** Each stored mark
 * carries a hash of the fields it attested to. When those fields change, the
 * mark no longer belongs to the document in front of the engineer, so it is
 * removed and they are told — see `pruneSignatures`. That is the whole of the
 * "edits after signing" rule, and it is enforced on the server during an
 * ordinary save, not offered as a courtesy by the browser.
 */

export const SIGNATURE_ROLES = ["issued", "received"] as const;

export type SignatureRole = (typeof SIGNATURE_ROLES)[number];

/** What each box is called on the sheet, for a message a person reads. */
export const SIGNATURE_LABELS: Record<SignatureRole, string> = {
  issued: "Issued by (engineer)",
  received: "Received by",
};

export function isSignatureRole(value: unknown): value is SignatureRole {
  return (
    typeof value === "string" &&
    (SIGNATURE_ROLES as readonly string[]).includes(value)
  );
}

/**
 * One captured mark, as it is stored against the draft.
 *
 * The image is a PNG data URL — the generator's own canvas, cropped to the
 * ink and nothing else. It is not text, it is not derived from a name, and
 * there is no path by which a name becomes one.
 */
export type CertificateSignature = {
  dataUrl: string;
  /** When the person drew it. */
  capturedAt: string;
  /** The draft revision it was written into, for the audit trail. */
  capturedAtRevision: number;
  /** A hash of the fields it was put against. See `pruneSignatures`. */
  contentHash: string;
};

export type CertificateSignatures = Partial<
  Record<SignatureRole, CertificateSignature>
>;

/**
 * The longest a stored signature image may be, as a data URL.
 *
 * Line art at the size the box prints at is a few kilobytes; this is roughly
 * 190 KB of PNG, which is generous for a signature and nowhere near enough to
 * be useful as a file store attached to a job.
 */
export const SIGNATURE_MAX_DATA_URL_LENGTH = 256_000;

/** Sanity bounds on the drawing itself, so the column cannot hold a photograph. */
const MAX_IMAGE_WIDTH = 4_000;
const MAX_IMAGE_HEIGHT = 2_000;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const DATA_URL_PREFIX = "data:image/png;base64,";

export type SignatureImageResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string };

/**
 * Whatever the browser posted, reduced to a PNG this application drew.
 *
 * **Why it is decoded rather than pattern-matched.** The value ends up in an
 * `<img src>` on an engineer's screen and inside a PDF an administrator
 * opens. A regular expression over a string would happily pass
 * `data:image/png;base64,` followed by anything at all. So the bytes are
 * decoded, checked for the PNG signature, read for their dimensions, and
 * **re-encoded from the decoded bytes** — what is stored is exactly what was
 * validated, with no room for a payload smuggled past in the encoding.
 */
export function normaliseSignatureImage(input: unknown): SignatureImageResult {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, error: "No signature was drawn." };
  }
  const value = input.trim();
  if (value.length > SIGNATURE_MAX_DATA_URL_LENGTH) {
    return { ok: false, error: "That signature image is too large." };
  }
  if (!value.startsWith(DATA_URL_PREFIX)) {
    return { ok: false, error: "That is not a signature this form produced." };
  }

  const encoded = value.slice(DATA_URL_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return { ok: false, error: "That signature image could not be read." };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64");
  } catch {
    return { ok: false, error: "That signature image could not be read." };
  }

  /* 8 bytes of magic, then an IHDR chunk whose width and height start at 16. */
  if (bytes.length < 24) {
    return { ok: false, error: "That signature image could not be read." };
  }
  for (let index = 0; index < PNG_MAGIC.length; index += 1) {
    if (bytes[index] !== PNG_MAGIC[index]) {
      return { ok: false, error: "That is not a signature this form produced." };
    }
  }
  if (bytes.toString("latin1", 12, 16) !== "IHDR") {
    return { ok: false, error: "That is not a signature this form produced." };
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) {
    return { ok: false, error: "That signature image could not be read." };
  }
  if (width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT) {
    return { ok: false, error: "That signature image is too large." };
  }

  return { ok: true, dataUrl: DATA_URL_PREFIX + bytes.toString("base64") };
}

/**
 * Fields that are on the sheet but not on the certificate.
 *
 * `landlordSelect2` is the standalone landlord picker. It is hidden in
 * connected mode and stripped from the PDF, so changing it cannot change what
 * anybody signed.
 */
const NOT_ON_THE_CERTIFICATE = new Set(["landlordSelect2"]);

/**
 * Fields a given role's mark does **not** attest to.
 *
 * **Why the two differ, and why this is not a convenience.** The engineer
 * certifies the inspection: the installation, the readings, the outcomes, the
 * property, the date and the number. Who happened to take the copy is not
 * part of that — so typing the tenant's name after the engineer has signed
 * does not invalidate the engineer's mark, which is exactly the order the
 * work happens in on a doorstep.
 *
 * The person receiving it is acknowledging *this document*, so everything
 * printed on it counts, including their own printed name. In practice theirs
 * is the last thing to happen, and nothing after it should change.
 */
const NOT_ATTESTED_BY: Record<SignatureRole, ReadonlySet<string>> = {
  issued: new Set(["receivedPrintName"]),
  received: new Set<string>(),
};

/**
 * A hash of everything one role's mark was put against.
 *
 * Deterministic and insensitive to noise that is not a change: values are
 * trimmed, blanks are treated the same whether they are absent or empty, and
 * the keys are sorted. So re-saving an untouched sheet never clears a
 * signature, and altering a single character always does.
 */
export function attestedContentHash(
  fields: CertificateDraftFields,
  role: SignatureRole,
): string {
  const excluded = NOT_ATTESTED_BY[role];
  const entries: [string, string][] = [];

  for (const key of CERTIFICATE_DRAFT_FIELDS) {
    if (NOT_ON_THE_CERTIFICATE.has(key)) continue;
    if (excluded.has(key)) continue;
    const value = (fields[key] ?? "").trim();
    if (value === "") continue;
    entries.push([key, value]);
  }

  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
}

/** Whatever is in the column, reduced to signatures this module understands. */
export function sanitiseSignatures(input: unknown): CertificateSignatures {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {};
  }

  const signatures: CertificateSignatures = {};
  for (const role of SIGNATURE_ROLES) {
    const raw = (input as Record<string, unknown>)[role];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;

    const entry = raw as Record<string, unknown>;
    const image = normaliseSignatureImage(entry.dataUrl);
    if (!image.ok) continue;
    if (typeof entry.contentHash !== "string" || entry.contentHash === "") {
      continue;
    }

    signatures[role] = {
      dataUrl: image.dataUrl,
      capturedAt:
        typeof entry.capturedAt === "string"
          ? entry.capturedAt
          : new Date(0).toISOString(),
      capturedAtRevision:
        typeof entry.capturedAtRevision === "number" &&
        Number.isInteger(entry.capturedAtRevision)
          ? entry.capturedAtRevision
          : 0,
      contentHash: entry.contentHash,
    };
  }
  return signatures;
}

export type PruneResult = {
  signatures: CertificateSignatures;
  /** Which marks no longer belong to the record, so the engineer can be told. */
  cleared: SignatureRole[];
};

/**
 * Drops every mark that no longer belongs to the record it is on.
 *
 * **This is the rule, stated once.** A signature is kept only while the
 * fields it was put against are unchanged. When they change, it is removed —
 * not carried silently, not re-dated, not reapplied. The person signs again
 * against what the document now says, or the box stays empty.
 *
 * It runs inside the ordinary save, on the server, from the fields being
 * stored. The browser mirrors the outcome so the engineer sees the box empty
 * and reads why; it does not get a vote.
 */
export function pruneSignatures(
  signatures: CertificateSignatures,
  fields: CertificateDraftFields,
): PruneResult {
  const kept: CertificateSignatures = {};
  const cleared: SignatureRole[] = [];

  for (const role of SIGNATURE_ROLES) {
    const signature = signatures[role];
    if (!signature) continue;
    if (signature.contentHash === attestedContentHash(fields, role)) {
      kept[role] = signature;
    } else {
      cleared.push(role);
    }
  }

  return { signatures: kept, cleared };
}

/**
 * What is still missing from the signature row before this may be submitted.
 *
 * Only the engineer's mark is required, and only because they are the person
 * present. A *Received by* box with nobody to sign it is a fact about the
 * visit, not an incomplete record, and refusing the submission would only
 * teach engineers to sign it themselves.
 */
export function describeMissingSignatures(
  fields: CertificateDraftFields,
  signatures: CertificateSignatures,
): readonly string[] {
  const issued = signatures.issued;
  if (!issued) return ["Engineer signature"];
  if (issued.contentHash !== attestedContentHash(fields, "issued")) {
    return ["Engineer signature (the record changed after it was signed)"];
  }
  return [];
}

/**
 * The signatures as a browser may see them.
 *
 * The image goes back — the engineer's own screen has to show what is on the
 * record — but nothing is added that the browser should be deciding from.
 */
export function describeSignatures(signatures: CertificateSignatures): Record<
  string,
  { dataUrl: string; capturedAt: string; capturedAtRevision: number }
> {
  const described: Record<
    string,
    { dataUrl: string; capturedAt: string; capturedAtRevision: number }
  > = {};
  for (const role of SIGNATURE_ROLES) {
    const signature = signatures[role];
    if (!signature) continue;
    described[role] = {
      dataUrl: signature.dataUrl,
      capturedAt: signature.capturedAt,
      capturedAtRevision: signature.capturedAtRevision,
    };
  }
  return described;
}
