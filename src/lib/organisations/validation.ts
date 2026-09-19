/**
 * What an administrator is allowed to type when opening an agency account.
 *
 * Pure, so every rule is testable without a form, a request or a database. The
 * server action calls this and refuses anything it rejects — a browser that
 * skips the HTML validation gets exactly the same answers.
 *
 * Nothing here invents a value. A field the administrator left blank stays
 * blank; it never becomes a plausible default that later appears on an
 * invoice.
 */

import { normaliseEmail } from "@/lib/booking/contact";
import { normaliseUkMobile } from "@/lib/booking/contact";
import { normalisePostcode } from "@/lib/address/format";

export type FieldErrors = Record<string, string>;

const MAX = { name: 120, legalName: 120, companyNumber: 20, line: 120, notes: 2000 };

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Collapses runs of whitespace, so "Acme   Lettings" is one name not two. */
function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export type OrganisationInput = {
  name: string;
  legalName: string | null;
  companyNumber: string | null;
  email: string;
  phone: string | null;
  billingLine1: string | null;
  billingLine2: string | null;
  billingTown: string | null;
  billingPostcode: string | null;
  notes: string | null;
};

export type ParsedOrganisation =
  | { ok: true; value: OrganisationInput }
  | { ok: false; errors: FieldErrors };

/**
 * Validates and normalises a new agency.
 *
 * Only the trading name and a contact email are required. An agency is opened
 * from a phone call, and refusing to record one until somebody has found its
 * company number is how the record ends up in a spreadsheet instead.
 */
export function parseOrganisation(form: FormData): ParsedOrganisation {
  const errors: FieldErrors = {};

  const name = tidy(text(form.get("name")));
  if (name.length < 2) errors.name = "Enter the agency's name.";
  else if (name.length > MAX.name) errors.name = "That name is too long.";

  const emailRaw = text(form.get("email"));
  const email = normaliseEmail(emailRaw);
  if (!email.ok) errors.email = "Enter a valid email address.";

  const phoneRaw = text(form.get("phone"));
  let phone: string | null = null;
  if (phoneRaw) {
    const parsed = normaliseUkMobile(phoneRaw);
    // An agency's number is often a landline, which the mobile rule refuses.
    // Keeping what was typed is better than rejecting a real office number.
    phone = parsed.ok ? parsed.e164 : phoneRaw;
  }

  const legalName = tidy(text(form.get("legalName")));
  if (legalName.length > MAX.legalName) errors.legalName = "That name is too long.";

  const companyNumber = tidy(text(form.get("companyNumber"))).toUpperCase();
  if (companyNumber.length > MAX.companyNumber) {
    errors.companyNumber = "That company number is too long.";
  }

  const billingPostcodeRaw = text(form.get("billingPostcode"));
  const billingPostcode = billingPostcodeRaw
    ? normalisePostcode(billingPostcodeRaw)
    : "";

  const notes = text(form.get("notes"));
  if (notes.length > MAX.notes) errors.notes = "Those notes are too long.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name,
      legalName: legalName || null,
      companyNumber: companyNumber || null,
      email: email.ok ? email.email : "",
      phone,
      billingLine1: tidy(text(form.get("billingLine1"))) || null,
      billingLine2: tidy(text(form.get("billingLine2"))) || null,
      billingTown: tidy(text(form.get("billingTown"))) || null,
      billingPostcode: billingPostcode || null,
      notes: notes || null,
    },
  };
}

export type OwnerInput = { name: string; email: string };

export type ParsedOwner =
  | { ok: true; value: OwnerInput }
  | { ok: false; errors: FieldErrors };

/**
 * Validates the agency's first user.
 *
 * **No password.** It used to take one, typed by the administrator, who then
 * had to communicate it somehow — and "somehow" is a text message, a phone
 * call or an email with a password in it. The account is now created without
 * one and an invitation is sent; the person sets their own, and nobody at BSCJ
 * ever knows it.
 *
 * That also means there is no strength rule to apply here. It applies where
 * the password is actually chosen — see `lib/auth/password.ts`, called from
 * the invitation form — which is the only place a password now exists.
 */
export function parseOwner(form: FormData): ParsedOwner {
  const errors: FieldErrors = {};

  const name = tidy(text(form.get("name")));
  if (name.length < 2) errors.name = "Enter the person's name.";

  const email = normaliseEmail(text(form.get("email")));
  if (!email.ok) errors.email = "Enter a valid email address.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return { ok: true, value: { name, email: email.ok ? email.email : "" } };
}
