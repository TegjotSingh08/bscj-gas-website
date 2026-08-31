/**
 * Client-side validation for the details step.
 *
 * Deliberately built from the same primitives the server uses — `normaliseEmail`
 * and `normaliseUkMobile` from `contact.ts`, the `customerTypes` enum, and the
 * postcode shape check — so the form and `bookingSchema` cannot disagree about
 * what "valid" means. No new regexes.
 *
 * This does **not** replace server validation. It exists because the Continue
 * button used to gate only on the address being ready, which let a customer
 * reach Review with their name, email and mobile blank. The server always
 * rejected those, but not until Confirm — after they had picked a slot, filled
 * in an address and read the terms.
 *
 * Pure and dependency-free, so every rule is directly testable.
 */

import {
  emailProblemMessage,
  normaliseEmail,
  normaliseUkMobile,
  phoneProblemMessage,
} from "./contact";
import { customerTypes } from "./schema";
import { looksLikePostcode, normalisePostcode } from "@/lib/address/format";

/** Mirrors the lengths in `bookingSchema`. */
const NAME_MIN = 2;
const NAME_MAX = 80;
const STREET_MIN = 2;
const STREET_MAX = 120;
const HOUSE_MAX = 60;

/**
 * The fields this step is responsible for, in the order they appear on screen.
 * A failed submit focuses the first of these that is invalid.
 */
export const DETAILS_FIELD_ORDER = [
  "fullName",
  "email",
  "phone",
  "postcode",
  "houseOrName",
  "street",
  "customerType",
  "applianceCount",
  "tenantPhone",
] as const;

export type DetailsField = (typeof DETAILS_FIELD_ORDER)[number];
export type DetailsErrors = Partial<Record<DetailsField, string>>;

/** Only the parts of the form this module judges. */
export type ValidatableDetails = {
  fullName: string;
  email: string;
  phone: string;
  houseOrName: string;
  street: string;
  postcode: string;
  customerType: string;
  applianceCount: number;
  /** Optional, but held to the same standard when supplied. */
  tenantPhone?: string;
};

export function validateDetails(values: ValidatableDetails): DetailsErrors {
  const errors: DetailsErrors = {};

  const name = values.fullName.trim();
  if (name.length < NAME_MIN) {
    // Covers blank and whitespace-only alike, because it trims first.
    errors.fullName = "Please enter your full name.";
  } else if (name.length > NAME_MAX) {
    errors.fullName = "That name is too long.";
  }

  const email = normaliseEmail(values.email);
  if (!email.ok) errors.email = emailProblemMessage(email.reason);

  const phone = normaliseUkMobile(values.phone);
  if (!phone.ok) errors.phone = phoneProblemMessage(phone.reason);

  // Optional, so blank passes — but anything typed must be a real mobile.
  if (values.tenantPhone && values.tenantPhone.trim()) {
    const tenant = normaliseUkMobile(values.tenantPhone);
    if (!tenant.ok) errors.tenantPhone = phoneProblemMessage(tenant.reason);
  }

  if (!looksLikePostcode(normalisePostcode(values.postcode))) {
    errors.postcode = "Please enter a valid UK postcode.";
  }

  const house = values.houseOrName.trim();
  if (!house) {
    errors.houseOrName = "Please enter the house number or property name.";
  } else if (house.length > HOUSE_MAX) {
    errors.houseOrName = "That is too long.";
  }

  const street = values.street.trim();
  if (street.length < STREET_MIN) {
    errors.street = "Please enter the street.";
  } else if (street.length > STREET_MAX) {
    errors.street = "That street name is too long.";
  }

  if (!(customerTypes as readonly string[]).includes(values.customerType)) {
    errors.customerType =
      "Please choose whether you are a landlord, agent, tenant or homeowner.";
  }

  const appliances = Number(values.applianceCount);
  if (!Number.isInteger(appliances) || appliances < 1) {
    errors.applianceCount = "Please choose a number of appliances.";
  }

  return errors;
}

/** The first invalid field on screen, so focus can be sent to it. */
export function firstInvalidField(errors: DetailsErrors): DetailsField | null {
  return DETAILS_FIELD_ORDER.find((field) => errors[field]) ?? null;
}

export function hasErrors(errors: DetailsErrors): boolean {
  return Object.keys(errors).length > 0;
}
