/**
 * UK phone and email handling.
 *
 * One implementation, used by the form, the Zod schema and the booking route,
 * so the browser and the server can never disagree about what a valid number
 * is. Pure and dependency-free, so every rule is directly testable.
 */

/** Digits only, with any +44 / 0044 / leading-zero prefix resolved. */
function digitsOf(input: string): string {
  const trimmed = input.trim().replace(/[\s().-]/g, "");

  if (trimmed.startsWith("+44")) return trimmed.slice(3);
  if (trimmed.startsWith("0044")) return trimmed.slice(4);
  if (trimmed.startsWith("44") && trimmed.length === 12) return trimmed.slice(2);
  if (trimmed.startsWith("0")) return trimmed.slice(1);
  return trimmed;
}

/**
 * A UK mobile in national form: 7, then nine more digits.
 *
 * Deliberately mobiles only. The field asks for a mobile because the engineer
 * needs to reach someone on the day, and accepting a landline here would be a
 * silent downgrade of that.
 */
const UK_MOBILE = /^7\d{9}$/;

export type PhoneResult =
  | { ok: true; e164: string; national: string }
  | { ok: false; reason: PhoneProblem };

export type PhoneProblem =
  | "empty"
  | "not_numeric"
  | "too_short"
  | "too_long"
  | "not_uk_mobile";

/**
 * Normalises a UK mobile to +447XXXXXXXXX.
 *
 * Forgiving about how people write numbers — spaces, brackets, dashes, a
 * leading zero, a pasted +44 — and strict about what the number actually is.
 */
export function normaliseUkMobile(input: string): PhoneResult {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "empty" };

  // Letters are never a typo worth guessing at.
  if (/[a-z]/i.test(raw)) return { ok: false, reason: "not_numeric" };

  const digits = digitsOf(raw);
  if (!/^\d+$/.test(digits)) return { ok: false, reason: "not_numeric" };

  if (digits.length < 10) return { ok: false, reason: "too_short" };
  if (digits.length > 10) return { ok: false, reason: "too_long" };
  if (!UK_MOBILE.test(digits)) return { ok: false, reason: "not_uk_mobile" };

  return {
    ok: true,
    e164: `+44${digits}`,
    national: `0${digits}`,
  };
}

/** What to tell the customer. Never blames them for our formatting rules. */
export function phoneProblemMessage(reason: PhoneProblem): string {
  switch (reason) {
    case "empty":
      return "Please enter a mobile number.";
    case "not_numeric":
      return "Please enter numbers only.";
    case "too_short":
      return "That number is too short for a UK mobile.";
    case "too_long":
      return "That number is too long for a UK mobile.";
    case "not_uk_mobile":
      return "Please enter a UK mobile number, starting 07.";
  }
}

/** "+447700900123" reads as "07700 900123" for people. */
export function formatUkMobileForDisplay(e164: string): string {
  const digits = digitsOf(e164);
  if (!UK_MOBILE.test(digits)) return e164;
  return `0${digits.slice(0, 4)} ${digits.slice(4)}`;
}

/**
 * Email validation.
 *
 * Deliberately shape-only. Nothing here queries a mailbox, probes SMTP or
 * sends anything — the aim is to catch a mistyped address, not to prove one
 * receives mail.
 */
const EMAIL =
  /^[^\s@,;:<>"'\\]+@[^\s@.,;:<>"'\\]+(\.[^\s@.,;:<>"'\\]+)+$/;

export type EmailResult =
  | { ok: true; email: string }
  | { ok: false; reason: "empty" | "malformed" | "too_long" };

export function normaliseEmail(input: string): EmailResult {
  const email = input.trim().toLowerCase();
  if (!email) return { ok: false, reason: "empty" };
  // Well beyond any real address, and short enough to keep headers sane.
  if (email.length > 254) return { ok: false, reason: "too_long" };
  if (!EMAIL.test(email)) return { ok: false, reason: "malformed" };
  return { ok: true, email };
}

export function emailProblemMessage(
  reason: "empty" | "malformed" | "too_long",
): string {
  switch (reason) {
    case "empty":
      return "Please enter an email address.";
    case "too_long":
      return "That email address is too long.";
    case "malformed":
      return "Please enter a valid email address.";
  }
}
