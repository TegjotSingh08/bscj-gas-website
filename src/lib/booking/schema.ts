/** Server-side validation for the booking form. */

import { z } from "zod";
import { MAX_APPLIANCES } from "./pricing";
import { DEFAULT_PRODUCT_ID, PRODUCT_IDS } from "./products";
import {
  emailProblemMessage,
  normaliseEmail,
  normaliseUkMobile,
  phoneProblemMessage,
} from "./contact";

const trimmed = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `Please enter ${label}.`)
    .max(max, `${label} is too long.`);

/**
 * UK mobile, normalised to +447XXXXXXXXX by the one shared implementation.
 * The stored value is always canonical, whatever the customer typed.
 */
const ukMobile = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const result = normaliseUkMobile(value);
    if (!result.ok) {
      ctx.addIssue({
        code: "custom",
        message: phoneProblemMessage(result.reason),
      });
      return z.NEVER;
    }
    return result.e164;
  });

/** The same rules, but blank is allowed because the tenant number is optional. */
const optionalUkMobile = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (!value) return "";
    const result = normaliseUkMobile(value);
    if (!result.ok) {
      ctx.addIssue({
        code: "custom",
        message: phoneProblemMessage(result.reason),
      });
      return z.NEVER;
    }
    return result.e164;
  })
  .optional();

const ukPostcode = z
  .string()
  .trim()
  .toUpperCase()
  .refine(
    (value) => /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/.test(value),
    "Please enter a valid UK postcode.",
  );

export const customerTypes = [
  "landlord",
  "letting-agent",
  "tenant",
  "homeowner",
] as const;

export const customerTypeLabels: Record<(typeof customerTypes)[number], string> =
  {
    landlord: "Landlord",
    "letting-agent": "Letting agent",
    tenant: "Tenant",
    homeowner: "Homeowner",
  };

export const bookingSchema = z.object({
  /** ISO instant of the chosen slot start. Re-validated against availability. */
  slotStart: z.string().datetime({ message: "Please choose an appointment." }),

  /**
   * Which service is being booked.
   *
   * An identifier and nothing more: the name, the price, the extra-appliance
   * rate and the appointment length are all read from the server's registry,
   * so a request cannot state its own total or its own duration. Anything
   * outside the registry is refused here; an absent value is the £45 CP12, so
   * a payload written before products existed still books exactly what it did.
   */
  productId: z.enum(PRODUCT_IDS, {
    message: "Please choose a service.",
  }).default(DEFAULT_PRODUCT_ID),

  fullName: trimmed(2, 80, "your full name"),
  email: z
    .string()
    .trim()
    .transform((value, ctx) => {
      const result = normaliseEmail(value);
      if (!result.ok) {
        ctx.addIssue({ code: "custom", message: emailProblemMessage(result.reason) });
        return z.NEVER;
      }
      return result.email;
    }),
  phone: ukMobile,

  /** Structured address. Assembled and re-validated server-side. */
  houseOrName: trimmed(1, 60, "the house number or property name"),
  street: trimmed(2, 120, "the street"),
  postcode: ukPostcode,

  /**
   * The customer read the assembled address back and confirmed it. Required:
   * no free service can prove a house exists at a postcode, so the customer
   * is the only reliable check on their own address.
   */
  addressConfirmedByCustomer: z.literal(true, {
    message: "Please confirm the property address is correct.",
  }),

  /**
   * The customer read and accepted the terms. Required as a literal true, so
   * a truthy value like "yes" or 1 will not pass.
   */
  termsAccepted: z.literal(true, {
    message: "Please read and accept the Terms & Conditions.",
  }),

  /**
   * The version of the terms the browser displayed. Checked against the
   * server's current version, so a stale tab cannot record acceptance of
   * wording the customer never saw.
   */
  termsVersion: z
    .string()
    .trim()
    .min(1, "Please refresh the page and read the Terms & Conditions again."),

  /**
   * Regulation 36(1) express request, needed only when the appointment falls
   * inside the statutory cancellation period.
   *
   * Deliberately a plain boolean here: whether it is *required* depends on the
   * slot and the moment of booking, which is the server's decision alone. The
   * route enforces it — see `checkTermsAcceptance`.
   */
  earlyPerformanceRequested: z.boolean().optional().default(false),

  customerType: z.enum(customerTypes, {
    message: "Please choose whether you are a landlord, agent, tenant or homeowner.",
  }),
  applianceCount: z.coerce
    .number()
    .int("Please choose a number of appliances.")
    .min(1, "There must be at least one appliance.")
    .max(MAX_APPLIANCES, `Please call us for more than ${MAX_APPLIANCES} appliances.`),

  tenantName: z.string().trim().max(80).optional().or(z.literal("")),
  tenantPhone: optionalUkMobile,
  accessNotes: z.string().trim().max(500).optional().or(z.literal("")),

  /**
   * Opaque reservation token. Optional: when the reservation store is
   * unavailable the customer still books, and Google Calendar decides.
   */
  holdToken: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "Please choose your appointment time again.")
    .optional(),

  /** Stable per-attempt id so a double click cannot create two bookings. */
  idempotencyKey: z
    .string()
    .trim()
    .min(8, "Please refresh the page and try again.")
    .max(64, "Please refresh the page and try again."),

  /** Honeypot — real customers never fill this in. */
  company: z
    .string()
    .max(0, "Please refresh the page and try again.")
    .optional()
    .or(z.literal("")),
});

export type BookingInput = z.infer<typeof bookingSchema>;

/**
 * Booking payload shape. Deliberately carries the fields a future landlord /
 * letting-agent portfolio would need (source, customer type, property
 * reference) without introducing a database for them now.
 */
export type BookingRecord = BookingInput & {
  source: "website";
  propertyReference: string;
};
