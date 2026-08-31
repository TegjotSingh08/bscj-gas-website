import { cp12 } from "@/lib/business";
import { escapeHtml } from "./escape";
import type { RenderedEmail } from "./booking-confirmation";

/**
 * Internal booking notification.
 *
 * A new booking otherwise only appears quietly in Google Calendar, which is not
 * good enough when a customer can book a slot later the same day. This is the
 * operational alert: it goes to BSCJ, not to the customer.
 *
 * Written for someone glancing at a phone while working. The date, time and
 * property come first and biggest; everything else is a plain table underneath.
 * Deliberately much simpler markup than the customer email — nobody needs it to
 * look designed, they need to read it in three seconds.
 *
 * Pure: every value is already derived and trusted by the booking route. It
 * recalculates nothing, and it carries no token, key or terms evidence — see
 * the note on `BookingNotificationInput`.
 */

const NAVY_900 = "#0b1b30";
const NAVY_600 = "#1c3a63";
const NAVY_100 = "#e3ecf7";
const NAVY_50 = "#f2f6fb";
const FLAME_600 = "#db7304";
const URGENT_RED = "#b3261e";
const URGENT_BG = "#fdecea";
const WHITE = "#ffffff";

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * What the notification needs.
 *
 * Note what is absent: no hold token, no idempotency key, no Redis identifier,
 * no calendar event id, no terms version and no cancellation-period evidence.
 * None of it helps the engineer get to the job, and the contractual record
 * already lives on the calendar event. This email exists to get someone to an
 * address on time.
 */
export type BookingNotificationInput = {
  reference: string;
  /** "Thursday, 27 August 2026" — already formatted in Europe/London. */
  dateLabel: string;
  /** "Thursday 27 August" — short form, for the subject. */
  subjectDateLabel: string;
  /** "19:00" / "19:45" — already formatted in Europe/London. */
  startLabel: string;
  endLabel: string;
  /** The property address, from the single canonical formatter. */
  addressLines: string[];
  postcode: string;
  /** "Gas Safety Certificate (CP12)" / "CP12 + Annual Boiler Service". */
  productName: string;
  /** Short, upper-cased into the subject: "CP12" / "CP12 + boiler service". */
  productSubjectName: string;
  customerName: string;
  /** Canonical +447XXXXXXXXX, as normalised by the server. */
  customerPhone: string;
  customerEmail: string;
  /** "Landlord", "Letting agent", … — already a display label. */
  customerType: string;
  /** Null when the service does not price by appliance. */
  applianceCount: number | null;
  /** Server-derived total. Never a client-submitted figure. */
  priceTotal: number;
  /** True when the appointment falls on today's date in Europe/London. */
  sameDay: boolean;
  /** Free text the customer typed. Empty when they gave none. */
  accessNotes: string;
  /** Optional tenant details, when the customer supplied them. */
  tenantName: string;
  tenantPhone: string;
};

/**
 * Whether an appointment is today.
 *
 * Compares local calendar dates in the booking timezone rather than elapsed
 * hours, so a 23:30 booking for a 09:00 slot the next morning is correctly not
 * same-day, and an 00:30 booking for 19:00 that evening correctly is.
 */
export function isSameDay(
  slotStart: Date,
  now: Date,
  timeZone: string,
): boolean {
  const asDate = (instant: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  return asDate(slotStart) === asDate(now);
}

export function notificationSubject(input: BookingNotificationInput): string {
  // Shouted, because it has to survive a glance at a lock screen.
  const service = input.productSubjectName.toUpperCase();
  return input.sameDay
    ? `URGENT — SAME-DAY ${service} BOOKING — ${input.startLabel} — ${input.postcode}`
    : `NEW ${service} BOOKING — ${input.subjectDateLabel} ${input.startLabel} — ${input.postcode}`;
}

export function renderBookingNotificationEmail(
  input: BookingNotificationInput,
): RenderedEmail {
  const subject = notificationSubject(input);
  const preheader = input.sameDay
    ? `TODAY at ${input.startLabel} — ${input.addressLines.join(", ")}`
    : `${input.dateLabel} at ${input.startLabel} — ${input.addressLines.join(", ")}`;

  return {
    subject,
    preheader,
    html: buildHtml(input, preheader),
    text: buildText(input),
  };
}

/** A label/value row in the details table. */
function row(label: string, value: string): string {
  return `
  <tr>
    <td style="padding:9px 0;border-bottom:1px solid ${NAVY_100};font-family:${FONT_STACK};font-size:14px;color:${NAVY_600};white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:9px 0 9px 16px;border-bottom:1px solid ${NAVY_100};font-family:${FONT_STACK};font-size:15px;font-weight:bold;color:${NAVY_900};">${escapeHtml(value)}</td>
  </tr>`;
}

function buildHtml(
  input: BookingNotificationInput,
  preheader: string,
): string {
  const rows: string[] = [];

  if (input.sameDay) {
    rows.push(`
    <tr>
      <td style="padding:16px 24px;background:${URGENT_BG};border-bottom:3px solid ${URGENT_RED};">
        <p style="margin:0;font-family:${FONT_STACK};font-size:18px;font-weight:bold;color:${URGENT_RED};letter-spacing:0.02em;">
          SAME-DAY BOOKING &mdash; TODAY
        </p>
      </td>
    </tr>`);
  }

  // The two things that matter: when, and where.
  rows.push(`
  <tr>
    <td style="padding:24px;background:${NAVY_900};">
      <p style="margin:0;font-family:${FONT_STACK};font-size:12px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${NAVY_100};">
        ${input.sameDay ? "Today" : "Appointment"}
      </p>
      <p style="margin:6px 0 0;font-family:${FONT_STACK};font-size:24px;line-height:30px;font-weight:bold;color:${WHITE};">
        ${escapeHtml(input.dateLabel)}
      </p>
      <p style="margin:4px 0 0;font-family:${FONT_STACK};font-size:32px;line-height:38px;font-weight:bold;color:#ffab2e;">
        ${escapeHtml(input.startLabel)}&ndash;${escapeHtml(input.endLabel)}
      </p>
    </td>
  </tr>`);

  rows.push(`
  <tr>
    <td style="padding:20px 24px;background:${NAVY_50};border-bottom:1px solid ${NAVY_100};">
      <p style="margin:0;font-family:${FONT_STACK};font-size:12px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${NAVY_600};">
        Property
      </p>
      <p style="margin:6px 0 0;font-family:${FONT_STACK};font-size:22px;line-height:30px;font-weight:bold;color:${NAVY_900};">
        ${input.addressLines.map(escapeHtml).join("<br />")}
      </p>
      <p style="margin:10px 0 0;font-family:${FONT_STACK};font-size:14px;">
        <a href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(input.addressLines.join(", "))}" style="color:${FLAME_600};font-weight:bold;">Open in Maps</a>
      </p>
    </td>
  </tr>`);

  const details = [
    row("Reference", input.reference),
    row("Customer", input.customerName),
    row("Mobile", input.customerPhone),
    row("Email", input.customerEmail),
    row("Service", input.productName),
    row("Customer type", input.customerType),
    row("Postcode", input.postcode),
    input.applianceCount === null
      ? ""
      : row(
          "Appliances",
          `${input.applianceCount} ${input.applianceCount === 1 ? "appliance" : "appliances"}`,
        ),
    row("Total", `£${input.priceTotal} — ${cp12.payment.toLowerCase()}`),
    input.tenantName || input.tenantPhone
      ? row(
          "Tenant",
          [input.tenantName || "name not given", input.tenantPhone || "no number"].join(
            " — ",
          ),
        )
      : "",
    input.accessNotes ? row("Access notes", input.accessNotes) : "",
  ].join("");

  rows.push(`
  <tr>
    <td style="padding:8px 24px 24px;background:${WHITE};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        ${details}
      </table>
      <p style="margin:16px 0 0;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${NAVY_600};">
        Booked online. ${escapeHtml(cp12.payment)} — no payment has been taken.
        Reply to this email to reach the customer directly.
      </p>
    </td>
  </tr>`);

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(notificationSubject(input))}</title>
</head>
<body style="margin:0;padding:0;background:${NAVY_100};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${NAVY_100};">
  <tr>
    <td align="center" style="padding:16px 10px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background:${WHITE};border-radius:12px;overflow:hidden;">
        ${rows.join("")}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function buildText(input: BookingNotificationInput): string {
  return [
    input.sameDay
      ? "*** SAME-DAY BOOKING - TODAY ***"
      : `NEW ${input.productSubjectName.toUpperCase()} BOOKING`,
    "",
    input.dateLabel,
    `${input.startLabel}-${input.endLabel}`,
    "",
    "PROPERTY",
    ...input.addressLines,
    "",
    `Reference:     ${input.reference}`,
    `Customer:      ${input.customerName}`,
    `Mobile:        ${input.customerPhone}`,
    `Email:         ${input.customerEmail}`,
    `Service:       ${input.productName}`,
    `Customer type: ${input.customerType}`,
    `Postcode:      ${input.postcode}`,
    ...(input.applianceCount === null
      ? []
      : [`Appliances:    ${input.applianceCount}`]),
    `Total:         £${input.priceTotal} - ${cp12.payment.toLowerCase()}`,
    ...(input.tenantName || input.tenantPhone
      ? [
          `Tenant:        ${input.tenantName || "name not given"} - ${input.tenantPhone || "no number"}`,
        ]
      : []),
    ...(input.accessNotes ? [`Access notes:  ${input.accessNotes}`] : []),
    "",
    `Booked online. ${cp12.payment} - no payment has been taken.`,
    "Reply to this email to reach the customer directly.",
  ].join("\n");
}
