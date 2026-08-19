/**
 * Single source of truth for every business fact shown on the site.
 *
 * Mirrors docs/business-details.md. Nothing here may be invented — if a fact is
 * not in that file, it does not belong on the website. Change it here and it
 * changes everywhere.
 */

export const business = {
  name: "BSCJ Gas & Heating",
  legalName: "Supreme Gas Ltd",
  domain: "www.bscj-solutions.com",
  url: "https://www.bscj-solutions.com",

  phone: "07494949648",
  phoneDisplay: "07494 949648",
  phoneHref: "tel:+447494949648",
  whatsappHref: "https://wa.me/447494949648",

  emailGeneral: "hello@bscj-solutions.com",
  emailBooking: "admin@bscj-solutions.com",

  gasSafeNumber: "632741",
  engineerName: "Jagjeet Singh",
  yearsExperience: 10,
  familyRun: true,
  insured: true,
} as const;

export const cp12 = {
  price: 45,
  priceDisplay: "£45",
  /** What the headline price covers. Never show the price without this. */
  includes: "one boiler and two additional appliances",
  extraAppliancePrice: 15,
  extraApplianceDisplay: "£15",
  /**
   * Public price presentation. The price is shown as a plain fixed total —
   * deliberately no VAT wording anywhere customer-facing.
   */
  priceTotalDisplay: "£45 total",
  totalNote: "total",
  priceSentence:
    "That is the total price for the certificate. There is no separate callout fee and nothing else is added on the day.",
  durationMinutes: 45,
  payment: "Pay after completion",
  certificateDelivery:
    "Physical certificate completed at your property, with a digital copy emailed the same day free of charge",
} as const;

export const availability = {
  workingDays: "Monday to Friday, plus Sunday",
  workingHours: "10:00 – 20:00",
  minimumNoticeHours: 12,
  maximumAdvanceDays: 30,
  cancellationNoticeHours: 48,
  rescheduleNoticeHours: 24,
} as const;

/**
 * Same-day messaging — Option C, decided 19 August 2026.
 * See "Availability Messaging" in docs/business-details.md.
 *
 * Kept in one place so switching to Option A (next-day wording) or Option B
 * (genuine same-day online) is a change to these three strings only.
 */
export const sameDayMessaging = {
  short: "Same-day often available",
  long: "Same-day appointments are often available — call or WhatsApp to arrange. Online booking needs 12 hours' notice.",
  bookingNote: `Online slots need at least ${availability.minimumNoticeHours} hours' notice. Need someone sooner? Call or WhatsApp and we will do our best to fit you in today.`,
} as const;

export const serviceAreas = [
  "Wolverhampton",
  "Bilston",
  "Wednesfield",
  "Willenhall",
] as const;

const calendarScheduleId =
  "AcZssZ12vkB90RMVqx2c9U0XF2RyD2UYpvhp4HzPD07IOlCEgJJT_5_mzGGO9jw8u2nLW8mVnrzM5vwS";

/** Embedded inside /book. */
export const calendarEmbedUrl = `https://calendar.google.com/calendar/appointments/schedules/${calendarScheduleId}?gv=true`;

/** Standalone Google booking page — the fallback if the embed fails to load. */
export const calendarDirectUrl = `https://calendar.google.com/calendar/appointments/schedules/${calendarScheduleId}`;

/**
 * Details required for the legal pages that are NOT yet in
 * docs/business-details.md. These must be filled in before launch — leave them
 * as null and the site renders a visible "to be confirmed" marker rather than
 * inventing a value.
 */
export const legal: {
  companyNumber: string | null;
  registeredAddress: string | null;
  icoRegistrationNumber: string | null;
} = {
  companyNumber: "12212412",
  registeredAddress:
    "Marshall Industrial Estate, Unit 11b, Sedgley Street, Wolverhampton, England, WV2 3AJ",
  // Not yet confirmed. Stays null until verified — never invent it.
  icoRegistrationNumber: null,
};

/** Registered office, split for structured data. Verified at Companies House. */
export const registeredOffice = {
  streetAddress: "Marshall Industrial Estate, Unit 11b, Sedgley Street",
  addressLocality: "Wolverhampton",
  addressRegion: "West Midlands",
  postalCode: "WV2 3AJ",
  addressCountry: "GB",
} as const;

export const lastUpdated = "19 August 2026";
