import { escapeHtml } from "./escape";
import type { RenderedEmail } from "./booking-confirmation";
import { business } from "@/lib/business";
import { formatLongDate } from "@/lib/booking/time";

/**
 * What a tenant is sent.
 *
 * Two messages, one rule above all others: **a tenant sees no money.** Not the
 * price, not the appliance count it was derived from, not who is being
 * invoiced, not the agency's terms. They are not paying and what their
 * landlord's agent is charged is nobody's business but the agency's — the same
 * rule the scheduling page itself follows.
 *
 * What they do see is the minimum needed to trust the message and act on it:
 * who asked for the work, which property, what service, and one link.
 */

export type InvitationFacts = {
  reference: string;
  /** The property, as the tenant would recognise it. */
  address: string;
  postcode: string;
  productName: string;
  appointmentMinutes: number;
  /** Who commissioned the work, where naming them helps the tenant trust it. */
  organisationName: string | null;
  /** The full URL. Built by the caller; never logged, never stored. */
  link: string;
  /** When the link stops working, so the tenant knows not to sit on it. */
  expiresAt: Date;
  timeZone: string;
};

function shell(
  preheader: string,
  paragraphs: string[],
  action: { label: string; href: string } | null,
  footer: string[],
): { html: string; text: string } {
  const html = [
    `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>`,
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    action
      ? `<p><a href="${escapeHtml(action.href)}" style="display:inline-block;background:#e2680f;color:#ffffff;padding:14px 24px;border-radius:12px;font-weight:bold;text-decoration:none">${escapeHtml(action.label)}</a></p>` +
        `<p style="font-size:12px;color:#55607a">If the button does not work, copy this into your browser:<br>${escapeHtml(action.href)}</p>`
      : "",
    ...footer.map((p) => `<p style="font-size:12px;color:#55607a">${escapeHtml(p)}</p>`),
  ].join("");

  const text = [
    ...paragraphs,
    ...(action ? ["", action.href] : []),
    "",
    ...footer,
  ].join("\n");

  return { html, text };
}

/**
 * "Choose a time for your gas safety appointment."
 *
 * The link is the whole message. It carries a token that was minted for this
 * send and exists nowhere else — not in the database, which holds only its
 * hash, and not in any log.
 */
export function renderTenantInvitationEmail(
  facts: InvitationFacts,
): RenderedEmail {
  /*
    The product name is not lower-cased: "Gas Safety Certificate (CP12)"
    becomes "(cp12)" if it is, and a tenant reading an unfamiliar acronym in
    the wrong case has one more reason to think the message is not genuine.
  */
  const who = facts.organisationName
    ? `${facts.organisationName} has arranged for us to carry out work at your home.`
    : "We have been asked to carry out work at your home.";

  const subject = "Choose a time for your gas safety appointment";
  const preheader = `${facts.address} — pick a time that suits you.`;

  const { html, text } = shell(
    preheader,
    [
      who,
      `Service: ${facts.productName}`,
      `Property: ${facts.address}, ${facts.postcode}`,
      "Choose a time that suits you. It takes about a minute, and there is nothing for you to pay.",
      `The appointment takes about ${facts.appointmentMinutes} minutes, and someone over 18 needs to be home.`,
    ],
    { label: "Choose your appointment", href: facts.link },
    [
      `This link is just for you — please do not forward it. It stops working on ${formatLongDate(
        facts.expiresAt.toISOString().slice(0, 10),
        facts.timeZone,
      )}.`,
      `Reference ${facts.reference}. If you would rather book by phone, call or WhatsApp ${business.phoneDisplay}.`,
    ],
  );

  return { subject, preheader, html, text };
}

export type TenantAppointmentFacts = {
  reference: string;
  address: string;
  postcode: string;
  productName: string;
  appointmentStart: Date;
  appointmentEnd: Date;
  appointmentMinutes: number;
  organisationName: string | null;
  timeZone: string;
};

/**
 * "Your appointment is booked."
 *
 * Sent after the tenant has chosen, and only once the calendar actually holds
 * the appointment — see the worker. Confirming a time that is not in the diary
 * would be the one failure this whole outbox exists to avoid.
 */
export function renderTenantAppointmentEmail(
  facts: TenantAppointmentFacts,
): RenderedEmail {
  const when = facts.appointmentStart.toLocaleString("en-GB", {
    timeZone: facts.timeZone,
    dateStyle: "full",
    timeStyle: "short",
  });

  const subject = `Your appointment is booked — ${when}`;
  const preheader = `${facts.productName} at ${facts.address}.`;

  const { html, text } = shell(
    preheader,
    [
      "Your appointment is booked.",
      when,
      `${facts.productName} at ${facts.address}, ${facts.postcode}.`,
      `A Gas Safe registered engineer will call at that time. Please make sure someone over 18 is home and that the boiler and any other gas appliances can be reached. It takes about ${facts.appointmentMinutes} minutes.`,
      "There is nothing for you to pay.",
    ],
    null,
    [
      `Reference ${facts.reference}. Need to change it? Call or WhatsApp ${business.phoneDisplay} and quote the reference.`,
    ],
  );

  return { subject, preheader, html, text };
}
