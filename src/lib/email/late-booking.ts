import { escapeHtml } from "./escape";
import type { RenderedEmail } from "./booking-confirmation";
import { business } from "@/lib/business";
import { formatLongDate } from "@/lib/booking/time";
import type { DeadlineSource } from "@/lib/scheduling/deadline";

/**
 * Telling the agency, and BSCJ, that a tenant booked after the deadline.
 *
 * The one thing this email must never do is imply the deadline was met, or
 * that it has moved. It states the date that was asked for, the date the
 * certificate runs out, the appointment that was actually taken, and the fact
 * that the tenant was warned and accepted it. Nothing is softened and no new
 * date is promised.
 *
 * Both recipients get the same facts; only the framing differs, because the
 * agency is being told about their property and BSCJ is being told about their
 * diary.
 */

export type LateBookingFacts = {
  reference: string;
  /** The property, as the agency would recognise it. */
  address: string;
  postcode: string;
  productName: string;
  /** The agency that commissioned the work, where there is one. */
  organisationName: string | null;
  /** The cutoff that was missed, ISO date. */
  deadlineDate: string;
  deadlineSource: DeadlineSource;
  /** Both underlying dates, always, whichever produced the cutoff. */
  requestedBy: string | null;
  certificateDueBy: string | null;
  /** The appointment the tenant chose, already confirmed. */
  appointmentStart: Date;
  appointmentEnd: Date;
  /** When the tenant acknowledged the warning. */
  acknowledgedAt: Date;
  timeZone: string;
};

function sourceLine(facts: LateBookingFacts): string {
  if (facts.deadlineSource === "both") {
    return "The requested completion date and the certificate expiry fall on the same day.";
  }
  if (facts.deadlineSource === "requested") {
    return "The requested completion date was the earlier of the two.";
  }
  return "The certificate expiry was the earlier of the two.";
}

function when(instant: Date, timeZone: string): string {
  return instant.toLocaleString("en-GB", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  });
}

function dateOrNone(value: string | null, timeZone: string): string {
  return value ? formatLongDate(value, timeZone) : "not given";
}

/** The shared body. Identical facts, so the two versions cannot disagree. */
function lines(facts: LateBookingFacts): string[] {
  return [
    `Reference: ${facts.reference}`,
    `Service: ${facts.productName}`,
    `Property: ${facts.address}, ${facts.postcode}`,
    "",
    `Deadline: ${formatLongDate(facts.deadlineDate, facts.timeZone)}`,
    sourceLine(facts),
    `Requested completion date: ${dateOrNone(facts.requestedBy, facts.timeZone)}`,
    `Certificate due: ${dateOrNone(facts.certificateDueBy, facts.timeZone)}`,
    "",
    `Appointment booked: ${when(facts.appointmentStart, facts.timeZone)}`,
    `Appointment ends: ${when(facts.appointmentEnd, facts.timeZone)}`,
    "",
    "This appointment is AFTER the deadline above.",
    `The tenant was shown a warning and accepted it on ${when(facts.acknowledgedAt, facts.timeZone)}.`,
    "",
    "The deadline has not changed and the certificate expiry has not been extended.",
  ];
}

function render(
  subject: string,
  preheader: string,
  opening: string,
  facts: LateBookingFacts,
  closing: string,
): RenderedEmail {
  const body = lines(facts);
  const text = [opening, "", ...body, "", closing].join("\n");

  const html = [
    `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>`,
    `<p>${escapeHtml(opening)}</p>`,
    `<p style="font-weight:bold;color:#b4460a">This appointment is after the deadline.</p>`,
    "<dl>",
    row("Reference", facts.reference),
    row("Service", facts.productName),
    row("Property", `${facts.address}, ${facts.postcode}`),
    row("Deadline", formatLongDate(facts.deadlineDate, facts.timeZone)),
    row("Requested completion date", dateOrNone(facts.requestedBy, facts.timeZone)),
    row("Certificate due", dateOrNone(facts.certificateDueBy, facts.timeZone)),
    row("Appointment booked", when(facts.appointmentStart, facts.timeZone)),
    row("Appointment ends", when(facts.appointmentEnd, facts.timeZone)),
    row(
      "Tenant acknowledged",
      when(facts.acknowledgedAt, facts.timeZone),
    ),
    "</dl>",
    `<p>${escapeHtml(sourceLine(facts))}</p>`,
    `<p>${escapeHtml("The deadline has not changed and the certificate expiry has not been extended.")}</p>`,
    `<p>${escapeHtml(closing)}</p>`,
  ].join("");

  return { subject, preheader, html, text };
}

function row(label: string, value: string): string {
  return `<dt style="font-weight:bold">${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
}

/** To the agency that commissioned the work. */
export function renderLateBookingAgentEmail(
  facts: LateBookingFacts,
): RenderedEmail {
  return render(
    `Booked after the deadline — ${facts.reference}`,
    `${facts.reference}: the tenant chose a time after the deadline.`,
    facts.organisationName
      ? `${facts.organisationName} — a tenant has booked an appointment at one of your properties, and the time they chose is after the deadline on the job.`
      : "A tenant has booked an appointment at one of your properties, and the time they chose is after the deadline on the job.",
    facts,
    `If this needs to be brought forward, call or WhatsApp ${business.phoneDisplay} and quote the reference.`,
  );
}

/** To BSCJ. Same facts; this one is an operational alert. */
export function renderLateBookingInternalEmail(
  facts: LateBookingFacts,
): RenderedEmail {
  return render(
    `Late booking recorded — ${facts.reference}`,
    `${facts.reference}: appointment accepted after the deadline.`,
    facts.organisationName
      ? `A tenant of ${facts.organisationName} has accepted an appointment after the job's deadline.`
      : "A tenant has accepted an appointment after the job's deadline.",
    facts,
    "The job carries a needs-attention flag until somebody clears it.",
  );
}
