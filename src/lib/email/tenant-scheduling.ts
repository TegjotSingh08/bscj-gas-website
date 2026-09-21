import { escapeHtml } from "./escape";
import {
  button,
  detailPanel,
  divider,
  fallbackLink,
  heading,
  note,
  paragraph,
  shell,
} from "./theme";
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
    ? `${escapeHtml(facts.organisationName)} has arranged for us to carry out work at your home.`
    : "We have been asked to carry out work at your home.";

  const subject = "Choose a time for your gas safety appointment";
  const preheader = `${facts.address} — pick a time that suits you.`;

  /*
    The detail panel carries what a tenant needs to recognise the message as
    genuine — their address, the service, how long it takes — and nothing else.
    **No price, no landlord, no agency contact.** They are not paying, and what
    their landlord's agent is charged is nobody's business but the agency's.
  */
  const body = [
    heading("Choose a time that suits you"),
    paragraph(who),
    detailPanel([
      { label: "Property", value: `${escapeHtml(facts.address)}<br />${escapeHtml(facts.postcode)}` },
      { label: "Service", value: escapeHtml(facts.productName) },
      { label: "How long", value: `About ${facts.appointmentMinutes} minutes` },
    ]),
    paragraph(
      "It takes about a minute to book, and there is nothing for you to pay. Someone over 18 needs to be home.",
    ),
    button("Choose your time", escapeHtml(facts.link)),
    fallbackLink(escapeHtml(facts.link)),
    divider(),
    note(
      `This link is just for you — please do not forward it. It stops working on ${escapeHtml(
        formatLongDate(facts.expiresAt.toISOString().slice(0, 10), facts.timeZone),
      )}.`,
    ),
  ].join("");

  const footer = note(
    `Reference ${escapeHtml(facts.reference)}. Would rather book by phone? Call or WhatsApp ${business.phoneDisplay}.`,
  );

  const text = [
    "Choose a time that suits you",
    "",
    facts.organisationName
      ? `${facts.organisationName} has arranged for us to carry out work at your home.`
      : "We have been asked to carry out work at your home.",
    "",
    `Property: ${facts.address}, ${facts.postcode}`,
    `Service:  ${facts.productName}`,
    `How long: about ${facts.appointmentMinutes} minutes`,
    "",
    "There is nothing for you to pay. Someone over 18 needs to be home.",
    "",
    facts.link,
    "",
    `This link is just for you. It stops working on ${formatLongDate(
      facts.expiresAt.toISOString().slice(0, 10),
      facts.timeZone,
    )}.`,
    `Reference ${facts.reference}. To book by phone, call or WhatsApp ${business.phoneDisplay}.`,
  ].join("\n");

  return { subject, preheader, html: shell({ preheader, body, footer }), text };
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

  /*
    The time is the message. It leads, it is in the panel, and it is in the
    subject line — this is the one somebody re-opens the morning of the visit,
    and it must answer "when" without being read.

    **No change or cancel button.** Nothing in the product supports a tenant
    doing either from a link, and a button that turns out not to work is worse
    than a phone number that does.
  */
  const body = [
    heading("Your appointment is booked"),
    detailPanel([
      { label: "When", value: escapeHtml(when) },
      { label: "Property", value: `${escapeHtml(facts.address)}<br />${escapeHtml(facts.postcode)}` },
      { label: "Service", value: escapeHtml(facts.productName) },
      { label: "How long", value: `About ${facts.appointmentMinutes} minutes` },
    ]),
    paragraph(
      "A Gas Safe registered engineer will call at that time. Please make sure someone over 18 is home and that the boiler and any other gas appliances can be reached.",
    ),
    paragraph("There is nothing for you to pay."),
  ].join("");

  const footer = note(
    `Reference ${escapeHtml(facts.reference)}. Need to change it? Call or WhatsApp ${business.phoneDisplay} and quote the reference.`,
  );

  const text = [
    "Your appointment is booked",
    "",
    `When:     ${when}`,
    `Property: ${facts.address}, ${facts.postcode}`,
    `Service:  ${facts.productName}`,
    `How long: about ${facts.appointmentMinutes} minutes`,
    "",
    "A Gas Safe registered engineer will call at that time. Please make sure someone over 18 is home and that the boiler and any other gas appliances can be reached.",
    "",
    "There is nothing for you to pay.",
    "",
    `Reference ${facts.reference}. Need to change it? Call or WhatsApp ${business.phoneDisplay} and quote the reference.`,
  ].join("\n");

  return { subject, preheader, html: shell({ preheader, body, footer }), text };
}
