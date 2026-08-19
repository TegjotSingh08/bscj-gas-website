import { availability, cp12, sameDayMessaging, serviceAreas } from "./business";

export type Faq = { question: string; answer: string };

/**
 * Answers must stay within what docs/business-details.md confirms, plus the
 * legal facts of the Gas Safety (Installation and Use) Regulations 1998.
 * No guarantees, timescales or claims beyond that.
 */
export const faqs: Faq[] = [
  {
    question: "What is a CP12 gas safety certificate?",
    answer:
      "CP12 is the common name for a Landlord Gas Safety Record. It is the document a Gas Safe registered engineer issues after checking that the gas appliances, pipework and flues at a property are safe to use. It lists every appliance checked and whether each one passed.",
  },
  {
    question: "Do I legally need one?",
    answer:
      "If you let out a property, yes. Under the Gas Safety (Installation and Use) Regulations 1998, landlords must have every gas appliance and flue they are responsible for checked by a Gas Safe registered engineer every 12 months, and must give tenants a copy of the record. Homeowners are not legally required to have one, though many arrange an annual check for peace of mind or when selling.",
  },
  {
    question: "How much does it cost?",
    answer: `${cp12.priceTotalDisplay} covers ${cp12.includes}. Each additional appliance is ${cp12.extraApplianceDisplay}. That is the whole price — there is no separate callout fee, and you pay after the work is completed, so there is nothing to pay when you book.`,
  },
  {
    question: "How long does the appointment take?",
    answer: `Around ${cp12.durationMinutes} minutes for a standard property. It can take a little longer if there are extra appliances or if access to the boiler or meter is awkward.`,
  },
  {
    question: "When do I get the certificate?",
    answer: `${cp12.certificateDelivery}. You do not pay extra for the digital copy.`,
  },
  {
    question: "What happens if an appliance fails the check?",
    answer:
      "The engineer will explain exactly what the problem is and why it failed. If an appliance is unsafe it will be turned off with your permission, and you will be told what needs putting right. You are never left without an explanation of what was found.",
  },
  {
    question: "Can I get a same-day appointment?",
    answer: sameDayMessaging.long,
  },
  {
    question: "Which areas do you cover?",
    answer: `${serviceAreas.slice(0, -1).join(", ")} and ${serviceAreas[serviceAreas.length - 1]}. If you are just outside these areas, get in touch and we will let you know if we can reach you.`,
  },
  {
    question: "Does someone need to be at the property?",
    answer:
      "Yes — someone aged 18 or over needs to let the engineer in and give access to the boiler, meter and every gas appliance being checked. If your tenant will be the one letting us in, give us their contact details when you book so we can arrange the visit directly with them.",
  },
  {
    question: "What if I need to cancel or move my appointment?",
    answer: `You can reschedule free of charge as long as it is more than ${availability.rescheduleNoticeHours} hours before your slot. Cancellations need at least ${availability.cancellationNoticeHours} hours' notice.`,
  },
  {
    question: "How do I pay?",
    answer: `${cp12.payment}. You will not be asked for card details to make a booking.`,
  },
  {
    question: "Is a CP12 the same as a boiler service?",
    answer:
      "No. A CP12 is a safety check — it confirms your appliances are safe to use and produces the certificate a landlord needs. A boiler service is maintenance work to keep the boiler running efficiently, such as cleaning components. They are different jobs.",
  },
];
