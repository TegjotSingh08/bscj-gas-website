import { randomBytes } from "node:crypto";

/**
 * The human-readable identifier for a job.
 *
 * V1 derived this from the calendar event id, which worked because a booking
 * and its event were created together. V2 jobs exist before any appointment
 * does — a job awaiting a tenant has no event to derive from — so references
 * are now allocated independently, from randomness rather than from anything
 * about the job.
 *
 * The format is unchanged from V1 on purpose. `BSCJ-` plus six characters is
 * already printed on confirmations sitting in customers' inboxes, and a second
 * format would mean two things to recognise on the phone.
 *
 * **A reference identifies a job. It never authorises access to one.** It is
 * short enough to read aloud, which is exactly why it is not a secret: nothing
 * about a customer, a property or a tenant may be retrievable by quoting it.
 *
 * Invoice numbers share the `BSCJ-` prefix but are six digits. Because digits
 * are also in the alphabet below, roughly one reference in a thousand would
 * otherwise come out looking exactly like an invoice number — so an all-digit
 * reference is refused at generation.
 *
 * `isJobReference` deliberately still accepts one. V1 derived references from
 * a hash and had no such rule, so all-digit references are already sitting in
 * customers' inboxes; refusing them here would make a real booking
 * unquotable. New references avoid the shape; old ones stay valid.
 */

/**
 * Crockford-style: no I, L, O or U, so a reference read down the phone cannot
 * be confused with 1 or 0, or written back as a rude word.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 6;

export const REFERENCE_PREFIX = "BSCJ-";

/** 32^6 — a little over a billion. */
export const REFERENCE_SPACE = ALPHABET.length ** LENGTH;

/**
 * Allocates a reference.
 *
 * Random rather than sequential, so the count of references issued never
 * reveals how much work the business is taking. Unbiased: bytes that would
 * wrap unevenly across the 32-character alphabet are discarded rather than
 * folded with a modulo, which would quietly favour the first few characters.
 *
 * Collisions are for the database to refuse — the `job_reference_key` unique
 * index is the authority, and the caller retries. At a billion possibilities
 * and a few thousand jobs that is a formality, but it is the formality that
 * makes uniqueness a fact rather than a probability.
 */
export function generateJobReference(): string {
  for (;;) {
    let reference = "";
    while (reference.length < LENGTH) {
      for (const byte of randomBytes(LENGTH * 2)) {
        // 256 is not a multiple of 32; 8 values would be over-represented.
        if (byte >= 256 - (256 % ALPHABET.length)) continue;
        reference += ALPHABET[byte % ALPHABET.length];
        if (reference.length === LENGTH) break;
      }
    }

    /*
      An all-digit body is indistinguishable from an invoice number. Drawing
      again is unbiased — it removes a whole class of outcomes rather than
      folding them onto another value — and happens about once in a thousand
      calls, so the loop is not a loop in practice.
    */
    if (/^\d+$/.test(reference)) continue;

    return `${REFERENCE_PREFIX}${reference}`;
  }
}

/** Shape check only. There is nothing to verify a reference against. */
export function isJobReference(value: string): boolean {
  return new RegExp(`^${REFERENCE_PREFIX}[${ALPHABET}]{${LENGTH}}$`).test(value);
}

/**
 * Tidies what someone typed or read out, before it is looked up.
 *
 * Accepts lower case, missing prefix and stray spaces or hyphens, because all
 * three are what actually arrives when a reference is quoted over the phone.
 * Returns null when the result is still not a reference, so a search never
 * runs on nonsense.
 */
export function normaliseJobReference(value: string): string | null {
  const cleaned = value.trim().toUpperCase().replace(/[\s-]/g, "");
  const body = cleaned.startsWith("BSCJ") ? cleaned.slice(4) : cleaned;
  const candidate = `${REFERENCE_PREFIX}${body}`;
  return isJobReference(candidate) ? candidate : null;
}
