import { availability, business, cp12, legal } from "@/lib/business";

/**
 * Booking confirmation email.
 *
 * Pure: takes already-derived, already-trusted booking values and returns the
 * subject, preheader, HTML and plain text. No I/O, no dates recalculated, no
 * prices recalculated — everything here is rendered from what the booking API
 * decided, so the email can never disagree with the calendar entry.
 *
 * Written as tables with inline styles because that is what Outlook and Gmail
 * render reliably. The palette is lifted from the site's own tokens in
 * globals.css rather than invented.
 */

const NAVY_900 = "#0b1b30";
const NAVY_800 = "#112643";
const NAVY_600 = "#1c3a63";
const NAVY_200 = "#c2d5ec";
const NAVY_100 = "#e3ecf7";
const NAVY_50 = "#f2f6fb";
/**
 * The darker brand orange, for the appointment time. The lighter #f78d09 sits
 * at 2.39:1 on white, failing even the large-text contrast threshold, while
 * this reaches 3.25:1. Both are existing tokens from globals.css.
 */
const FLAME_600 = "#db7304";
const FLAME_400 = "#ffab2e";
const TRUST_600 = "#0f7a52";
const TRUST_50 = "#eaf6f1";
const WHITE = "#ffffff";

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export type BookingEmailInput = {
  reference: string;
  customerName: string;
  /** "Thursday, 20 August 2026" — already formatted in Europe/London. */
  dateLabel: string;
  /** "17:00" — already formatted in Europe/London. */
  startLabel: string;
  /** "17:45" — already formatted in Europe/London. */
  endLabel: string;
  /** "Thursday 20 August" — short form for the subject line. */
  subjectDateLabel: string;
  propertyAddress: string;
  postcode: string;
  applianceCount: number;
  /** Server-derived total. Never a client-submitted figure. */
  priceTotal: number;
};

export type RenderedEmail = {
  subject: string;
  preheader: string;
  html: string;
  text: string;
};

/** Escapes text before it is placed into the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function appliancesLabel(count: number): string {
  return `${count} ${count === 1 ? "appliance" : "appliances"}`;
}

/** A button that still reads as a link if the styling is stripped. */
function button(href: string, label: string, background: string): string {
  return `<a href="${href}" class="m-btn" style="display:inline-block;padding:14px 24px;background:${background};color:${WHITE};font-family:${FONT_STACK};font-size:16px;font-weight:bold;text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>`;
}

function sectionLabel(text: string): string {
  return `<p style="margin:0 0 6px;font-family:${FONT_STACK};font-size:12px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${NAVY_600};">${escapeHtml(text)}</p>`;
}

export function renderBookingConfirmationEmail(
  input: BookingEmailInput,
): RenderedEmail {
  const subject = `Your BSCJ Gas CP12 booking — ${input.subjectDateLabel}`;

  // Deliberately not a repeat of the subject: it adds the time and the fact of
  // confirmation, which is what the inbox preview line is worth spending on.
  const preheader = `Your Gas Safety Certificate appointment is confirmed for ${input.startLabel} on ${input.subjectDateLabel}. Reference ${input.reference}.`;

  const html = buildHtml(input, preheader);
  const text = buildText(input);

  return { subject, preheader, html, text };
}

function buildHtml(input: BookingEmailInput, preheader: string): string {
  const {
    reference,
    customerName,
    dateLabel,
    startLabel,
    endLabel,
    propertyAddress,
    postcode,
    applianceCount,
    priceTotal,
  } = input;

  // Split for a natural two-line date: "Thursday" above "20 August 2026".
  const [weekday, ...restOfDate] = dateLabel.split(", ");
  const dayAndMonth = restOfDate.join(", ") || dateLabel;

  const rows: string[] = [];

  rows.push(`
  <tr>
    <td class="m-head" style="padding:24px 28px;background:${NAVY_900};border-radius:12px 12px 0 0;">
      <p style="margin:0;font-family:${FONT_STACK};font-size:20px;font-weight:bold;color:${WHITE};letter-spacing:0.01em;">
        BSCJ <span style="color:${FLAME_400};">Gas &amp; Heating</span>
      </p>
      <p style="margin:4px 0 0;font-family:${FONT_STACK};font-size:13px;color:${NAVY_100};">
        Gas Safe Registered &middot; Wolverhampton
      </p>
    </td>
  </tr>`);

  rows.push(`
  <tr>
    <td class="m-sec m-sec-top" style="padding:28px 28px 8px;background:${WHITE};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td class="m-hero" style="padding:14px 18px;background:${TRUST_50};border-left:4px solid ${TRUST_600};border-radius:8px;">
            <p style="margin:0;font-family:${FONT_STACK};font-size:22px;font-weight:bold;color:${NAVY_900};">
              You&rsquo;re booked.
            </p>
            <p style="margin:6px 0 0;font-family:${FONT_STACK};font-size:15px;line-height:22px;color:${NAVY_800};">
              Your Gas Safety Certificate appointment has been confirmed.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>`);

  rows.push(`
  <tr>
    <td class="m-sec" style="padding:20px 28px 0;background:${WHITE};">
      <p style="margin:0;font-family:${FONT_STACK};font-size:16px;line-height:24px;color:${NAVY_800};">
        Hello ${escapeHtml(customerName)},
      </p>
    </td>
  </tr>`);

  rows.push(`
  <tr>
    <td class="m-sec" style="padding:20px 28px 0;background:${WHITE};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:2px solid ${NAVY_900};border-radius:12px;">
        <tr>
          <td class="m-card" style="padding:22px 24px;">
            ${sectionLabel("Appointment")}
            <p style="margin:0;font-family:${FONT_STACK};font-size:18px;font-weight:bold;color:${NAVY_800};">
              ${escapeHtml(weekday)}
            </p>
            <p class="m-date" style="margin:2px 0 0;font-family:${FONT_STACK};font-size:26px;line-height:32px;font-weight:bold;color:${NAVY_900};">
              ${escapeHtml(dayAndMonth)}
            </p>
            <p class="m-time" style="margin:8px 0 0;font-family:${FONT_STACK};font-size:22px;font-weight:bold;color:${FLAME_600};">
              ${escapeHtml(startLabel)}&ndash;${escapeHtml(endLabel)}
            </p>
            <p style="margin:12px 0 0;font-family:${FONT_STACK};font-size:15px;color:${NAVY_800};">
              Gas Safety Certificate (CP12)
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>`);

  rows.push(`
  <tr>
    <td class="m-sec" style="padding:20px 28px 0;background:${WHITE};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${NAVY_50};border:1px solid ${NAVY_200};border-radius:12px;">
        <tr>
          <td class="m-card" style="padding:20px 24px;">
            ${sectionLabel("Property")}
            <p style="margin:0;font-family:${FONT_STACK};font-size:16px;line-height:24px;color:${NAVY_900};font-weight:bold;">
              ${escapeHtml(propertyAddress)}<br />${escapeHtml(postcode)}
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>`);

  rows.push(`
  <tr>
    <td class="m-sec" style="padding:20px 28px 0;background:${WHITE};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:0 0 10px;border-bottom:1px solid ${NAVY_100};font-family:${FONT_STACK};font-size:14px;color:${NAVY_600};">Service</td>
          <td align="right" style="padding:0 0 10px;border-bottom:1px solid ${NAVY_100};font-family:${FONT_STACK};font-size:14px;font-weight:bold;color:${NAVY_900};">Gas Safety Certificate (CP12)</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid ${NAVY_100};font-family:${FONT_STACK};font-size:14px;color:${NAVY_600};">Appliances</td>
          <td align="right" style="padding:10px 0;border-bottom:1px solid ${NAVY_100};font-family:${FONT_STACK};font-size:14px;font-weight:bold;color:${NAVY_900};">${escapeHtml(appliancesLabel(applianceCount))}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid ${NAVY_100};font-family:${FONT_STACK};font-size:14px;color:${NAVY_600};">Total</td>
          <td align="right" style="padding:10px 0;border-bottom:1px solid ${NAVY_100};font-family:${FONT_STACK};font-size:18px;font-weight:bold;color:${NAVY_900};">&pound;${priceTotal} total</td>
        </tr>
        <tr>
          <td style="padding:10px 0;font-family:${FONT_STACK};font-size:14px;color:${NAVY_600};">Payment</td>
          <td align="right" style="padding:10px 0;font-family:${FONT_STACK};font-size:14px;font-weight:bold;color:${NAVY_900};">${escapeHtml(cp12.payment)}</td>
        </tr>
      </table>
    </td>
  </tr>`);

  rows.push(`
  <tr>
    <td class="m-sec" style="padding:24px 28px 0;background:${WHITE};">
      <p style="margin:0 0 10px;font-family:${FONT_STACK};font-size:17px;font-weight:bold;color:${NAVY_900};">
        What happens next
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr><td class="m-step" style="padding:0 0 7px;font-family:${FONT_STACK};font-size:15px;line-height:22px;color:${NAVY_800};">1. Your appointment is now in our engineer&rsquo;s schedule.</td></tr>
        <tr><td class="m-step" style="padding:0 0 7px;font-family:${FONT_STACK};font-size:15px;line-height:22px;color:${NAVY_800};">2. Someone aged 18 or over needs to let the engineer in and give access to the boiler, the gas meter and every gas appliance being checked.</td></tr>
        <tr><td class="m-step" style="padding:0 0 7px;font-family:${FONT_STACK};font-size:15px;line-height:22px;color:${NAVY_800};">3. The appointment usually takes about ${cp12.durationMinutes} minutes.</td></tr>
        <tr><td style="font-family:${FONT_STACK};font-size:15px;line-height:22px;color:${NAVY_800};">4. ${escapeHtml(cp12.payment)} &mdash; there is nothing to pay before the visit.</td></tr>
      </table>
    </td>
  </tr>`);

  rows.push(`
  <tr>
    <td class="m-sec" style="padding:24px 28px 0;background:${WHITE};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px dashed ${NAVY_200};border-radius:10px;">
        <tr>
          <td align="center" class="m-ref" style="padding:16px 20px;">
            ${sectionLabel("Booking reference")}
            <p style="margin:0;font-family:${FONT_STACK};font-size:22px;font-weight:bold;letter-spacing:0.06em;color:${NAVY_900};">
              ${escapeHtml(reference)}
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>`);

  rows.push(`
  <tr>
    <td class="m-sec" style="padding:24px 28px 0;background:${WHITE};">
      <p style="margin:0 0 6px;font-family:${FONT_STACK};font-size:17px;font-weight:bold;color:${NAVY_900};">
        Need to change something?
      </p>
      <p class="m-body" style="margin:0 0 14px;font-family:${FONT_STACK};font-size:15px;line-height:22px;color:${NAVY_800};">
        Contact us and quote your booking reference. Rescheduling is free more
        than ${availability.rescheduleNoticeHours} hours before your appointment,
        and cancellations need at least ${availability.cancellationNoticeHours} hours&rsquo; notice.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr class="m-btnrow">
          <td class="m-btncell" style="padding:0 10px 10px 0;">${button(business.phoneHref, `Call ${business.phoneDisplay}`, NAVY_800)}</td>
          <td class="m-btncell" style="padding:0 0 10px;">${button(business.whatsappHref, "WhatsApp BSCJ", TRUST_600)}</td>
        </tr>
      </table>
      <p class="m-body" style="margin:4px 0 0;font-family:${FONT_STACK};font-size:14px;line-height:21px;color:${NAVY_600};">
        Or email <a href="mailto:${business.emailBooking}" style="color:${NAVY_800};">${business.emailBooking}</a>.
      </p>
      <p class="m-body" style="margin:12px 0 0;font-family:${FONT_STACK};font-size:14px;line-height:21px;color:${NAVY_600};">
        Keep this email for your appointment details and booking reference.
      </p>
    </td>
  </tr>`);

  rows.push(`
  <tr>
    <td class="m-foot" style="padding:28px;background:${WHITE};border-radius:0 0 12px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid ${NAVY_100};">
        <tr>
          <td class="m-foot-text" style="padding:18px 0 0;font-family:${FONT_STACK};font-size:12px;line-height:20px;color:${NAVY_600};">
            <strong style="color:${NAVY_800};">${escapeHtml(business.name)}</strong><br />
            A trading name of ${escapeHtml(business.legalName)}${
              legal.companyNumber
                ? `, registered in England and Wales, company number ${escapeHtml(legal.companyNumber)}`
                : ""
            }.<br />
            ${legal.registeredAddress ? `${escapeHtml(legal.registeredAddress)}<br />` : ""}
            Gas Safe Register No. ${escapeHtml(business.gasSafeNumber)}<br />
            ${escapeHtml(business.phoneDisplay)} &middot; <a href="mailto:${business.emailGeneral}" style="color:${NAVY_600};">${business.emailGeneral}</a> &middot; <a href="${business.url}" style="color:${NAVY_600};">${escapeHtml(business.domain)}</a><br /><br />
            You are receiving this because you booked an appointment with us.
          </td>
        </tr>
      </table>
    </td>
  </tr>`);

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(`Booking confirmed — ${reference}`)}</title>
<style type="text/css">
/*
  Mobile refinements only. Every desktop value stays inline on the element, so
  Outlook desktop — which ignores media queries entirely — renders exactly as
  it did before. These rules apply in Apple Mail, iPhone Mail, Gmail and
  Outlook mobile, which all support media queries.
*/
@media screen and (max-width: 600px) {
  .m-wrap { padding: 12px 10px !important; }
  .m-head { padding: 18px 16px !important; }
  /* Vertical padding is where the height goes, so the shorthand is replaced
     rather than only the left and right values. */
  .m-sec { padding: 14px 16px 0 !important; }
  .m-sec-top { padding: 18px 16px 4px !important; }
  .m-card { padding: 15px 16px !important; }
  .m-hero { padding: 13px 15px !important; }
  .m-weekday { font-size: 16px !important; }
  .m-date { font-size: 22px !important; line-height: 28px !important; }
  .m-time { font-size: 20px !important; }
  .m-ref { padding: 14px 16px !important; }
  .m-foot { padding: 20px 16px !important; }
  .m-step { padding-bottom: 6px !important; }

  /* Contact actions become full-width stacked buttons: two side-by-side
     buttons crowd a 375px screen and leave the labels cramped. */
  .m-btnrow, .m-btncell { display: block !important; width: 100% !important; }
  .m-btncell { padding: 0 0 8px 0 !important; }
  .m-btn { display: block !important; width: 100% !important; text-align: center !important; box-sizing: border-box !important; padding: 12px !important; }

  /* The three tallest blocks on a phone: the contact section, the numbered
     steps and the legal footer. Tightened by line height and spacing rather
     than by shrinking type or dropping content. */
  .m-step { line-height: 20px !important; }
  .m-body { line-height: 20px !important; }
  .m-foot-text { line-height: 18px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${NAVY_50};">
<div style="display:none;font-size:1px;color:${NAVY_50};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
${escapeHtml(preheader)}
</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${NAVY_50};">
  <tr>
    <td align="center" class="m-wrap" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;background:${WHITE};border-radius:12px;">
${rows.join("\n")}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function buildText(input: BookingEmailInput): string {
  return [
    "BSCJ GAS & HEATING",
    "Gas Safe Registered · Wolverhampton",
    "",
    "YOU'RE BOOKED",
    "Your Gas Safety Certificate appointment has been confirmed.",
    "",
    `Hello ${input.customerName},`,
    "",
    "APPOINTMENT",
    input.dateLabel,
    `${input.startLabel}-${input.endLabel}`,
    "Gas Safety Certificate (CP12)",
    "",
    "PROPERTY",
    input.propertyAddress,
    input.postcode,
    "",
    "SERVICE",
    "Gas Safety Certificate (CP12)",
    "",
    "APPLIANCES",
    appliancesLabel(input.applianceCount),
    "",
    "TOTAL",
    `£${input.priceTotal} total`,
    "",
    "PAYMENT",
    cp12.payment,
    "",
    "BOOKING REFERENCE",
    input.reference,
    "",
    "WHAT HAPPENS NEXT",
    "1. Your appointment is now in our engineer's schedule.",
    "2. Someone aged 18 or over needs to let the engineer in and give access to",
    "   the boiler, the gas meter and every gas appliance being checked.",
    `3. The appointment usually takes about ${cp12.durationMinutes} minutes.`,
    `4. ${cp12.payment} - there is nothing to pay before the visit.`,
    "",
    "NEED TO CHANGE SOMETHING?",
    "Contact us and quote your booking reference.",
    `Rescheduling is free more than ${availability.rescheduleNoticeHours} hours before your appointment,`,
    `and cancellations need at least ${availability.cancellationNoticeHours} hours' notice.`,
    "",
    `Call: ${business.phoneDisplay}`,
    `WhatsApp: ${business.whatsappHref}`,
    `Email: ${business.emailBooking}`,
    "",
    "Keep this email for your appointment details and booking reference.",
    "",
    "---",
    business.name,
    `A trading name of ${business.legalName}${
      legal.companyNumber
        ? `, registered in England and Wales, company number ${legal.companyNumber}`
        : ""
    }.`,
    legal.registeredAddress ?? "",
    `Gas Safe Register No. ${business.gasSafeNumber}`,
    `${business.phoneDisplay} · ${business.emailGeneral} · ${business.domain}`,
    "",
    "You are receiving this because you booked an appointment with us.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
