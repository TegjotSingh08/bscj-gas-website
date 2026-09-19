import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { ImportRecord } from "./rows";
import type { PlannedRow, Resolution } from "./plan";

/**
 * Carrying a reviewed plan from the preview to the confirmation.
 *
 * The problem: the agent has just reviewed 200 rows and is about to press
 * Confirm. Between the two requests, something has to hold what they reviewed
 * — and whatever holds it becomes the thing the write path trusts.
 *
 * **The uploaded file is not kept.** Neither on disk nor in a store: the
 * parsed, validated plan travels back to the browser in a signed envelope and
 * returns with the submission. So there is no temporary file to leak, nothing
 * to clean up, no expiry job, and an abandoned preview leaves nothing at all
 * behind — which is what "do not retain raw files unnecessarily" actually
 * looks like in code.
 *
 * **The envelope is signed, so the browser cannot edit it.** It is not
 * encrypted and does not need to be: it contains only what the agent uploaded
 * and just read on screen. What matters is that they cannot change a postcode,
 * add a row, or — the one that would matter — swap the organisation.
 *
 * Three things are bound into the signature:
 *
 * - **The organisation.** A plan built for one agency cannot be confirmed by
 *   another, even if the envelope were somehow obtained. The action re-checks
 *   `requireAgent()` as well; this is the belt that makes the rule visible.
 * - **A nonce**, minted per preview. It is what makes the digest identify
 *   *this review* rather than *this file* — so double-submitting one preview
 *   is recognised and refused, while genuinely uploading the same file again
 *   is a new review and is allowed.
 * - **An expiry.** A reviewed plan is a decision taken at a moment; acting on
 *   one from last week would write conflicts the agent never saw.
 */

/** Long enough to read 200 rows carefully. Short enough to be a decision. */
export const ENVELOPE_MAX_AGE_SECONDS = 60 * 60;

/** Domain separation, so this key is neither Auth.js's nor a credential's. */
const LABEL = "bscj:portfolio-import:v1";

export class EnvelopeSecretMissingError extends Error {
  constructor() {
    super("AUTH_SECRET is not set, so an import plan cannot be signed.");
    this.name = "EnvelopeSecretMissingError";
  }
}

function key(): string {
  const secret = process.env.AUTH_SECRET;
  // Fail closed. An unsigned plan is a plan the browser writes.
  if (!secret) throw new EnvelopeSecretMissingError();
  return `${LABEL}:${secret}`;
}

/** One row, reduced to what the write path needs. */
export type PlannedWrite = {
  line: number;
  action: "create" | "conflict";
  record: ImportRecord;
  /** Set for `conflict`: the property already held. */
  existingPropertyId?: string;
  /**
   * Set for `conflict`: whether an import may apply this row at all.
   *
   * Carried **inside the signature** rather than recomputed at write time, so
   * a submission that claims "update" for a row the preview said could not be
   * updated is refused by the envelope rather than by a second implementation
   * of the same rule.
   */
  applicable?: boolean;
  /**
   * Set for `conflict`: the state the conflicts were judged against, hashed.
   *
   * Inside the signature, so the browser cannot claim the record was in a
   * state it was not. Re-checked against a fresh read at write time — see
   * `fingerprintOf` and `commitImport`.
   */
  observed?: string;
};

export type ImportEnvelope = {
  organisationId: string;
  /** Minted per preview. What makes the digest identify this review. */
  nonce: string;
  issuedAt: number;
  /** Presentation only, and never re-read as a path. */
  filename: string;
  /** How many rows the agent saw in total, including ones that write nothing. */
  reviewed: number;
  writes: PlannedWrite[];
};

/**
 * Builds an envelope from a plan.
 *
 * Only the rows that **could** write are carried. An error row, a duplicate
 * and an unchanged row are all reported on screen and then dropped: carrying
 * them would triple the size of the envelope to describe work that is not
 * going to happen.
 */
export function envelopeFor(input: {
  organisationId: string;
  filename: string;
  rows: PlannedRow[];
  now?: Date;
}): ImportEnvelope {
  const writes: PlannedWrite[] = [];

  for (const row of input.rows) {
    if (!row.record) continue;
    if (row.action === "create") {
      writes.push({ line: row.line, action: "create", record: row.record });
    } else if (row.action === "conflict") {
      writes.push({
        line: row.line,
        action: "conflict",
        record: row.record,
        existingPropertyId: row.existingPropertyId,
        applicable: row.conflictsApplicable === true,
        observed: row.observed,
      });
    }
  }

  return {
    organisationId: input.organisationId,
    nonce: randomBytes(16).toString("hex"),
    issuedAt: (input.now ?? new Date()).getTime(),
    filename: input.filename,
    reviewed: input.rows.length,
    writes,
  };
}

function sign(payload: string): string {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}

/** `<base64url payload>.<signature>`. Opaque to the browser, readable by us. */
export function sealEnvelope(envelope: ImportEnvelope): string {
  const payload = Buffer.from(JSON.stringify(envelope), "utf8").toString(
    "base64url",
  );
  return `${payload}.${sign(payload)}`;
}

/**
 * Opens an envelope, or returns null.
 *
 * **Null for every kind of failure** — malformed, wrong signature, expired,
 * wrong organisation, no secret. A caller cannot tell them apart, and a
 * confirmation that failed for any of these reasons gets the same sentence and
 * the same instruction: upload it again.
 *
 * The organisation is passed in from `requireAgent()` and compared, rather
 * than read out of the envelope and trusted. That ordering is the point.
 */
export function openEnvelope(
  sealed: string | undefined,
  organisationId: string,
  now = new Date(),
): ImportEnvelope | null {
  if (!sealed) return null;

  const separator = sealed.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = sealed.slice(0, separator);
  const signature = sealed.slice(separator + 1);

  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }

  const left = Buffer.from(signature, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return null;
  if (!timingSafeEqual(left, right)) return null;

  let envelope: ImportEnvelope;
  try {
    envelope = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as ImportEnvelope;
  } catch {
    return null;
  }

  if (typeof envelope?.organisationId !== "string") return null;
  if (!Array.isArray(envelope.writes)) return null;
  // The signature proves we wrote it; this proves it was written for *them*.
  if (envelope.organisationId !== organisationId) return null;

  const age = now.getTime() - envelope.issuedAt;
  if (!Number.isFinite(age) || age < 0) return null;
  if (age > ENVELOPE_MAX_AGE_SECONDS * 1000) return null;

  return envelope;
}

/**
 * The digest that makes a confirmation retry-safe.
 *
 * Covers the envelope **and the resolutions the agent chose**, because those
 * are part of what was decided: ticking a different box is a different import
 * and must be allowed to run. The nonce inside the envelope is what stops the
 * same *file* being permanently blocked after one successful import.
 *
 * Written into `portfolio_import.plan_digest`, where a unique index on
 * `(organisation, digest)` arbitrates between two browsers pressing Confirm at
 * the same moment — which a read-then-write in the application does not.
 */
export function digestFor(
  envelope: ImportEnvelope,
  resolutions: Map<number, Resolution>,
): string {
  const canonical = [
    envelope.organisationId,
    envelope.nonce,
    String(envelope.issuedAt),
    ...envelope.writes.map(
      (write) =>
        `${write.line}:${write.action}:${write.record.key}:${
          resolutions.get(write.line) ?? "skip"
        }`,
    ),
  ].join("|");

  return createHash("sha256").update(canonical).digest("hex");
}
