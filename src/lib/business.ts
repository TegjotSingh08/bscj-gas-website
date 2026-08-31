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
  /**
   * The engineer's personal name is deliberately NOT held here.
   *
   * It must not appear on any customer-facing surface — page copy, metadata,
   * structured data, the confirmation page or the confirmation email. Work is
   * described at business level, or as "a Gas Safe registered engineer".
   * The name stays in docs/business-details.md as an internal record only.
   * See the assertion in src/lib/public-content.test.ts.
   */
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
  /**
   * The old wording ended "and nothing else is added on the day", which was not
   * true: the extra-appliance charge applies if the property turns out to have
   * more appliances than we were told about, and remedial work is separate.
   * Saying otherwise was a misleading omission, and it contradicted /terms.
   */
  priceSentence:
    "That is the total price for the inspection and your certificate, and there is no separate call-out fee. If we find more gas appliances than you told us about, or anything that needs repair, we will explain the cost and agree it with you before doing any extra work.",
  durationMinutes: 45,
  payment: "Pay after completion",
  certificateDelivery:
    "Physical certificate completed at your property, with a digital copy emailed the same day free of charge",
} as const;

/**
 * The standalone annual boiler service, confirmed 31 August 2026.
 *
 * Only the name and the price are verified. **What the service includes has
 * never been specified**, so nothing here or anywhere else describes its
 * checks, steps or parts.
 *
 * The 60 minutes is a **calendar allocation, not a claim about how long the
 * work takes**. No standalone duration has ever been confirmed, and the
 * combined visit allocates 60 minutes for a 45-minute CP12 plus the service —
 * which implies the service element is far shorter than an hour when the two
 * are done together. Sixty is deliberately the generous end: over-allocating
 * protects the diary, under-allocating oversells it. See
 * docs/business-details.md.
 */
export const boilerService = {
  price: 60,
  priceDisplay: "£60",
  priceTotalDisplay: "£60 total",
  /** A calendar allocation. Never presented as how long the work takes. */
  durationMinutes: 60,
  payment: cp12.payment,
  priceSentence:
    "That is the total price for the annual boiler service, and there is no separate call-out fee. If we find anything that needs repair, we will explain the cost and agree it with you before doing any extra work.",
} as const;

/**
 * The second bookable product, confirmed 31 August 2026.
 *
 * Only the name, the price and the appointment length are verified. **What the
 * annual boiler service actually includes has never been specified**, so
 * nothing here — and nothing anywhere else on the site — describes its checks,
 * steps or parts. The site says the customer has booked a CP12 plus an annual
 * boiler service, and stops there. See docs/business-details.md.
 *
 * The appliance rule is deliberately not restated: it is the CP12 rule, shared
 * rather than copied, so the two products cannot drift apart.
 */
export const boilerServiceBundle = {
  price: 90,
  priceDisplay: "£90",
  priceTotalDisplay: "£90 total",
  durationMinutes: 60,
  /** Shared with the CP12, not a second copy of it. */
  includes: cp12.includes,
  extraAppliancePrice: cp12.extraAppliancePrice,
  extraApplianceDisplay: cp12.extraApplianceDisplay,
  payment: cp12.payment,
  priceSentence:
    "That is the total price for the gas safety inspection, your certificate and an annual boiler service, and there is no separate call-out fee. If we find more gas appliances than you told us about, or anything that needs repair, we will explain the cost and agree it with you before doing any extra work.",
} as const;

export const availability = {
  workingDays: "Monday to Friday, plus Sunday",
  workingHours: "10:00 – 20:00",
  minimumNoticeHours: 12,
  maximumAdvanceDays: 30,
  /**
   * A request, not a condition. There is no cancellation charge and no
   * deadline after which an appointment "cannot" be cancelled — the previous
   * 48-hour wording was withdrawn on 22 August 2026 because it read as though
   * it removed a statutory right. See `lib/booking/terms.ts`.
   */
  preferredNoticeHours: 24,
} as const;

/**
 * Cancellation, rescheduling and failed-access policy.
 *
 * Deliberately one place, because it has to read identically on /terms, in the
 * FAQs, on /book and in the confirmation email. See docs/CONSUMER_RIGHTS.md
 * for the legal reasoning; none of this has been reviewed by a solicitor.
 */
export const cancellationPolicy = {
  /** No cancellation charge exists. Not £5, not £45, not a sliding scale. */
  chargeApplies: false,
  cancelSummary:
    "You can cancel or move any appointment free of charge, whatever notice you give. We never charge a cancellation fee.",
  noticeRequest: `Please give us as much notice as you can — ideally ${availability.preferredNoticeHours} hours — so we can offer the slot to someone else.`,
  rescheduleSummary:
    "Rescheduling is free. Contact us and we will find you another time — there is no self-service rescheduling on this website yet.",
  /** One free reschedule on a failed visit. No automatic charge, ever. */
  failedAccessSummary:
    "If nobody is there to let the engineer in, or the appliances cannot be reached, we will offer you one further appointment free of charge. We do not make an automatic charge for a missed visit.",
  failedAccessRepeat:
    "If access fails more than once, we may ask you to arrange the work with us directly rather than booking online again.",
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

/**
 * What the £45 buys, and what it does not.
 *
 * One place, because it has to read identically on the pricing cards, the CP12
 * page, the FAQs and /terms. The distinction it draws is commercial, not
 * decorative: the charge is for **carrying out the inspection**, so it is
 * payable whether or not the property passes. Leaving that unsaid until the
 * engineer is standing in the kitchen would be a misleading omission, and the
 * kind of thing that turns into a dispute rather than a repeat customer.
 *
 * Presented as clarity, never as a warning. Repairs are a separate service the
 * customer is free to decline — see `noObligation`.
 */
export const inspectionScope = {
  /** The headline, for a pricing block. */
  covers: `The ${cp12.priceDisplay} covers the gas safety inspection and your certificate — whatever the inspection finds.`,

  /**
   * The point the site previously never made. Deliberately phrased around the
   * work done rather than around the customer's misfortune.
   */
  chargeAppliesRegardless:
    "The price is for carrying out the inspection, so it applies whether everything passes or we find something that needs attention. Either way you get the engineer's time and a completed record.",

  repairsExcluded:
    "Repairs, replacement parts and remedial work are not included in the inspection price.",

  /** The secondary commercial opportunity, offered as convenience. */
  remedialOffer:
    "If we do find something, we will explain it in plain terms. Where it is work we can do, we can quote you for it separately at a competitive price — agreed with you before we start.",

  /** Trust matters more here than the upsell. */
  noObligation:
    "There is no obligation to use us for any repair. You are free to use any Gas Safe registered engineer, and your certificate does not depend on giving us the work.",

  /** Matches the actual process: no card on file, invoiced separately. */
  separateInvoice:
    "Any additional work you agree to is quoted and invoiced separately from the inspection.",
} as const;

/**
 * The standard online booking radius, in miles.
 *
 * `SERVICE_AREA_RADIUS_MILES` overrides it in server-side configuration, and
 * `lib/address/service-area.ts` uses this as its default so the advertised
 * figure and the enforced rule cannot drift apart.
 *
 * Straight-line distance from a configured operating centre. **Never a
 * driving distance and never a travel time** — no journey time may be
 * advertised on the back of it.
 */
export const serviceRadiusMiles = 12;

/**
 * Towns that currently fall inside the standard radius, for page copy and
 * `areaServed` structured data.
 *
 * Indicative only. Eligibility is decided at booking from the property's
 * postcode coordinates, never from a town name, so this list must never be
 * presented as a guarantee that a given town is accepted — nor does BSCJ have
 * premises in any of them.
 */
export const serviceAreas = [
  "Wolverhampton",
  "Bilston",
  "Wednesfield",
  "Willenhall",
  "Codsall",
  "Dudley",
  "Walsall",
  "West Bromwich",
  "Cannock",
  "Stourbridge",
] as const;

/**
 * Service-area wording, in one place so every page says the same thing.
 *
 * `outsideArea` deliberately never says "we do not serve your area" — work
 * beyond the standard online radius may still be accepted by arrangement.
 */
export const serviceAreaCopy = {
  headline: `${business.name} serves Wolverhampton and surrounding areas within our standard service area.`,
  radius: `Our standard online booking area is a ${serviceRadiusMiles} mile radius around Wolverhampton, which currently includes:`,
  postcodeNote:
    "Enter your postcode when booking to confirm whether your property is within our standard online booking area.",
  outsideArea:
    "This property is outside our standard online booking area. We may still be able to help — call or WhatsApp us and we'll confirm availability.",
} as const;

const calendarScheduleId =
  "AcZssZ12vkB90RMVqx2c9U0XF2RyD2UYpvhp4HzPD07IOlCEgJJT_5_mzGGO9jw8u2nLW8mVnrzM5vwS";

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
