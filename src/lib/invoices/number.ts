/**
 * Invoice numbers.
 *
 * V2 runs its own series, `BSCJ-001000` upwards, confirmed 17 September 2026.
 * The old hand-maintained `D-…` series belonging to the standalone invoice
 * generator is **not** continued: two systems incrementing one sequence is how
 * two invoices end up with the same number, and an accountant cannot tell
 * which of them is real.
 *
 * The series starts at 1000 so the first invoice is not obviously the first.
 * The starting point lives in the migration, not here — this module formats
 * whatever the sequence hands it, which is why moving the start is a one-line
 * change to a file nothing has applied yet.
 *
 * Numbers come from a Postgres sequence. Every alternative is wrong under
 * concurrency: counting existing rows races, a "last number" column races
 * unless every reader takes a lock, and a timestamp is not a number a business
 * can account for. A sequence is atomic by construction and never reissues a
 * value, even when the transaction that drew one rolls back — which is why
 * gaps are expected and are not a fault.
 *
 * This module is the format. `allocate.ts` draws from the sequence.
 */

export const INVOICE_PREFIX = "BSCJ-";

/** Six digits: a million invoices before the format has to be revisited. */
export const INVOICE_DIGITS = 6;

const INVOICE_NUMBER = new RegExp(`^${INVOICE_PREFIX}\\d{${INVOICE_DIGITS}}$`);

/**
 * Formats a sequence value.
 *
 * A value too large for six digits is rendered in full rather than truncated.
 * Silently wrapping to `BSCJ-000000` would reissue numbers, which is the one
 * thing this format exists to prevent.
 */
export function formatInvoiceNumber(sequenceValue: number): string {
  if (!Number.isInteger(sequenceValue) || sequenceValue < 1) {
    throw new RangeError(`Not a sequence value: ${sequenceValue}`);
  }
  return `${INVOICE_PREFIX}${String(sequenceValue).padStart(INVOICE_DIGITS, "0")}`;
}

/**
 * Shape check.
 *
 * Digits only, deliberately. A job reference uses the same `BSCJ-` prefix but
 * a letter-bearing alphabet, and `generateJobReference` refuses to emit an
 * all-digit reference for exactly this reason — so the two formats can never
 * be mistaken for one another, in a database lookup or on the phone.
 */
export function isInvoiceNumber(value: string): boolean {
  return INVOICE_NUMBER.test(value);
}

/** The sequence value behind a number, or null when it is not one. */
export function parseInvoiceNumber(value: string): number | null {
  const cleaned = normaliseInvoiceNumber(value);
  if (!cleaned) return null;
  return Number(cleaned.slice(INVOICE_PREFIX.length));
}

/**
 * Tidies what someone typed, before it is looked up.
 *
 * Accepts lower case, a missing prefix and stray spaces or hyphens, because
 * all three are what actually arrives when a number is read off a PDF or
 * quoted over the phone. Returns null when the result is still not a number,
 * so a search never runs on nonsense.
 */
export function normaliseInvoiceNumber(value: string): string | null {
  const cleaned = value.trim().toUpperCase().replace(/[\s-]/g, "");
  const body = cleaned.startsWith("BSCJ") ? cleaned.slice(4) : cleaned;
  if (!/^\d+$/.test(body)) return null;

  const candidate = `${INVOICE_PREFIX}${body.padStart(INVOICE_DIGITS, "0")}`;
  return isInvoiceNumber(candidate) ? candidate : null;
}
