import { createHash } from "node:crypto";

/**
 * Customer-facing booking reference.
 *
 * Derived deterministically from the calendar event id, which is itself
 * derived from the slot and the booking attempt. That gives a reference which
 * is stable for a booking and identical on the confirmation page and in the
 * email, without introducing a database purely to allocate reference numbers.
 *
 * It is an opaque label, not a credential: it grants nothing, and it cannot be
 * reversed into the event id, the hold token or anything else internal.
 */

/**
 * Crockford-style alphabet: no I, L, O or U, so a reference read aloud over
 * the phone cannot be confused with 1, 0 or written back as a rude word.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 6;

export const REFERENCE_PREFIX = "BSCJ-";

export function bookingReference(eventId: string): string {
  const digest = createHash("sha256").update(`ref|${eventId}`).digest();

  let reference = "";
  for (let index = 0; index < LENGTH; index += 1) {
    reference += ALPHABET[digest[index] % ALPHABET.length];
  }
  return `${REFERENCE_PREFIX}${reference}`;
}

/** Shape check only — there is nothing to verify a reference against. */
export function isBookingReference(value: string): boolean {
  return new RegExp(`^${REFERENCE_PREFIX}[${ALPHABET}]{${LENGTH}}$`).test(value);
}
