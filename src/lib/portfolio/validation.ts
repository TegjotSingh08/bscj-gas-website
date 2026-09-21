/**
 * What an agency is allowed to submit.
 *
 * Pure, so every rule is testable without a form, a request or a database.
 * Each mutation calls the matching parser and refuses anything it rejects — a
 * browser that skips the HTML validation gets exactly the same answers.
 *
 * **No parser here reads an organisation id.** Which agency a record belongs
 * to is never a submitted field; it comes from `requireAgent()` at the call
 * site. A parser that accepted one would be the shape of the bug this whole
 * design exists to prevent.
 */

import { normaliseEmail, normaliseUkMobile } from "@/lib/booking/contact";
import { normalisePostcode, looksLikePostcode } from "@/lib/address/format";

export type FieldErrors = Record<string, string>;

const LIMITS = {
  name: 120,
  line: 120,
  notes: 2000,
  reference: 60,
};

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Collapses runs of whitespace, so "Rose   Cottage" is one name not two.
 *
 * Exported because the write path applies it as well as the parser. The
 * database index compares `lower(house_or_name)` and does not trim, so an
 * untidied value would slip past both the duplicate check and the index —
 * normalising once, at the point of writing, is what makes the guarantee hold
 * however the mutation was reached.
 */
export function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Landlords
// ---------------------------------------------------------------------------

export type LandlordInput = {
  name: string;
  company: string | null;
  /** Null when not yet known. Never a placeholder. */
  email: string | null;
  /** Null when not yet known. Never a placeholder. */
  phone: string | null;
};

export type ParsedLandlord =
  | { ok: true; value: LandlordInput }
  | { ok: false; errors: FieldErrors };

/**
 * A landlord, as an agency knows one.
 *
 * **The name identifies them; the contact details are how we reach them, and
 * an agency often has the first without the second.** A portfolio export names
 * the owner of every property and frequently carries no address or number for
 * them. Refusing to record the property until somebody finds one is how the
 * portfolio stays in a spreadsheet, and inventing one puts a fiction in front
 * of a landlord and eventually onto an invoice.
 *
 * So both are optional here and the requirement moves to the operation that
 * actually needs it: emailing a certificate needs an address for the recipient
 * it chose, and says so by name when there is none. Recording a property does
 * not.
 *
 * A supplied value is still validated — "not known" and "wrong" are different
 * answers, and accepting a malformed address would produce a contact that
 * silently never works.
 *
 * The phone is normalised with the same helper the booking form uses, but a
 * value it refuses is kept rather than rejected: a landlord's number is often
 * a landline, and refusing a real one to satisfy a mobile rule written for
 * consumers would stop an agency recording their own client.
 */
export function parseLandlord(form: FormData): ParsedLandlord {
  const errors: FieldErrors = {};

  const name = tidy(text(form, "name"));
  if (name.length < 2) errors.name = "Enter the landlord's name.";
  else if (name.length > LIMITS.name) errors.name = "That name is too long.";

  const company = tidy(text(form, "company"));
  if (company.length > LIMITS.name) errors.company = "That name is too long.";

  /*
    Absent is fine; present and malformed is not. Blank means "not known yet"
    and stays null — it never becomes an empty string, because an empty string
    in an email column is a value that looks like a contact and is not one.
  */
  const emailRaw = text(form, "email");
  let email: string | null = null;
  if (emailRaw) {
    const parsed = normaliseEmail(emailRaw);
    if (!parsed.ok) errors.email = "Enter a valid email address, or leave it blank.";
    else email = parsed.email;
  }

  const phoneRaw = text(form, "phone");
  let phone: string | null = null;
  if (phoneRaw) {
    const parsed = normaliseUkMobile(phoneRaw);
    phone = parsed.ok ? parsed.e164 : phoneRaw;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: { name, company: company || null, email, phone },
  };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

export type PropertyInput = {
  houseOrName: string;
  street: string;
  town: string | null;
  postcode: string;
  accessNotes: string | null;
};

export type ParsedProperty =
  | { ok: true; value: PropertyInput }
  | { ok: false; errors: FieldErrors };

/**
 * A property.
 *
 * The postcode is validated for shape here and against the provider in the
 * mutation; the town is filled in from the provider rather than typed, so the
 * agent enters only what the system cannot derive.
 *
 * **Coverage is deliberately not checked.** The twelve-mile radius is a rule
 * about what the public site will take an online booking for, not about what
 * BSCJ will agree to do for a managed agency — whose portfolio routinely
 * spans a wider area. Refusing a Birmingham property here would refuse real
 * work that the business already does.
 */
export function parseProperty(form: FormData): ParsedProperty {
  const errors: FieldErrors = {};

  const houseOrName = tidy(text(form, "houseOrName"));
  if (houseOrName.length < 1) {
    errors.houseOrName = "Enter the house number or property name.";
  } else if (houseOrName.length > 60) {
    errors.houseOrName = "That is too long.";
  }

  const street = tidy(text(form, "street"));
  if (street.length < 2) errors.street = "Enter the street.";
  else if (street.length > LIMITS.line) errors.street = "That is too long.";

  const postcodeRaw = text(form, "postcode");
  const postcode = normalisePostcode(postcodeRaw);
  if (!postcode || !looksLikePostcode(postcode)) {
    errors.postcode = "Enter a valid UK postcode.";
  }

  const accessNotes = text(form, "accessNotes");
  if (accessNotes.length > LIMITS.notes) {
    errors.accessNotes = "Those notes are too long.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      houseOrName,
      street,
      town: tidy(text(form, "town")) || null,
      postcode,
      accessNotes: accessNotes || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Tenancies
// ---------------------------------------------------------------------------

export type TenancyInput = {
  name: string | null;
  email: string | null;
  phone: string | null;
  startedOn: string | null;
  notes: string | null;
};

export type ParsedTenancy =
  | { ok: true; value: TenancyInput | null }
  | { ok: false; errors: FieldErrors };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A tenancy, or the honest absence of one.
 *
 * Every field is optional and a completely empty form returns `null` — not an
 * empty tenancy. A property between lets, or one whose tenant the agency has
 * not been told about yet, is a real and common state, and a blank row would
 * assert that somebody lives there and we know who.
 *
 * A tenant's number *is* held to the mobile rule, unlike a landlord's: it is
 * the number a scheduling link will be sent to, and a landline cannot receive
 * one.
 */
export function parseTenancy(form: FormData): ParsedTenancy {
  const errors: FieldErrors = {};

  const name = tidy(text(form, "tenantName"));
  const emailRaw = text(form, "tenantEmail");
  const phoneRaw = text(form, "tenantPhone");
  const startedOn = text(form, "tenancyStartedOn");
  const notes = text(form, "tenancyNotes");

  if (!name && !emailRaw && !phoneRaw && !startedOn && !notes) {
    return { ok: true, value: null };
  }

  let email: string | null = null;
  if (emailRaw) {
    const parsed = normaliseEmail(emailRaw);
    if (!parsed.ok) errors.tenantEmail = "Enter a valid email address.";
    else email = parsed.email;
  }

  let phone: string | null = null;
  if (phoneRaw) {
    const parsed = normaliseUkMobile(phoneRaw);
    if (!parsed.ok) {
      errors.tenantPhone = "Enter a valid UK mobile number.";
    } else {
      phone = parsed.e164;
    }
  }

  if (startedOn && !ISO_DATE.test(startedOn)) {
    errors.tenancyStartedOn = "Enter a valid date.";
  }

  if (name.length > LIMITS.name) errors.tenantName = "That name is too long.";
  if (notes.length > LIMITS.notes) errors.tenancyNotes = "Those notes are too long.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name: name || null,
      email,
      phone,
      startedOn: startedOn || null,
      notes: notes || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Existing compliance position
// ---------------------------------------------------------------------------

export type CompliancePositionInput = {
  /** When the property's current certificate expires. */
  dueDate: string;
  /** The inspection it came from, when the agency knows it. */
  inspectionDate: string | null;
};

export type ParsedCompliance =
  | { ok: true; value: CompliancePositionInput | null }
  | { ok: false; errors: FieldErrors };

/**
 * What the property already holds, if anything.
 *
 * Optional, and absent means *not known* — never "compliant" and never
 * "overdue". A portfolio arrives with patchy records, and inventing a position
 * for a property whose paperwork nobody has found would put a false date in
 * front of a landlord.
 *
 * Recorded as the due date rather than derived from an inspection date,
 * because the expiry is what an agency actually has written down. Where they
 * also know the inspection date it is kept, so the renewal engine can later
 * check the two agree.
 */
export function parseCompliance(form: FormData): ParsedCompliance {
  const dueDate = text(form, "certificateExpiry");
  const inspectionDate = text(form, "lastInspection");

  if (!dueDate && !inspectionDate) return { ok: true, value: null };

  const errors: FieldErrors = {};
  if (dueDate && !ISO_DATE.test(dueDate)) {
    errors.certificateExpiry = "Enter a valid date.";
  }
  if (inspectionDate && !ISO_DATE.test(inspectionDate)) {
    errors.lastInspection = "Enter a valid date.";
  }
  if (!dueDate) {
    errors.certificateExpiry = "Enter when the current certificate expires.";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: { dueDate, inspectionDate: inspectionDate || null },
  };
}

/** The address key a duplicate check compares on. */
export function propertyKey(postcode: string, houseOrName: string): string {
  return `${normalisePostcode(postcode)}|${tidy(houseOrName).toLowerCase()}`;
}
