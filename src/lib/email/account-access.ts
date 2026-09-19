import { escapeHtml } from "./escape";
import type { RenderedEmail } from "./booking-confirmation";
import { business } from "@/lib/business";

/**
 * The two messages that let somebody into an account: an invitation, and a
 * password reset.
 *
 * One rule shapes both: **the message says as little as it can while still
 * being trustworthy.** No role, no organisation id, no list of what the
 * account can reach, no indication of whether an account already existed. A
 * reset message that says "your agency portal account for Acme Lettings" is a
 * free confirmation, to whoever is reading that inbox, that the address is
 * worth attacking.
 *
 * The link is the whole message. It carries a token minted for this send that
 * exists nowhere else — the database holds only its hash, and nothing logs it.
 */

function shell(
  preheader: string,
  paragraphs: string[],
  action: { label: string; href: string },
  footer: string[],
): { html: string; text: string } {
  const html = [
    `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>`,
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    `<p><a href="${escapeHtml(action.href)}" style="display:inline-block;background:#e2680f;color:#ffffff;padding:14px 24px;border-radius:12px;font-weight:bold;text-decoration:none">${escapeHtml(action.label)}</a></p>`,
    `<p style="font-size:12px;color:#55607a">If the button does not work, copy this into your browser:<br>${escapeHtml(action.href)}</p>`,
    ...footer.map((p) => `<p style="font-size:12px;color:#55607a">${escapeHtml(p)}</p>`),
  ].join("");

  const text = [...paragraphs, "", action.href, "", ...footer].join("\n");

  return { html, text };
}

/**
 * How long the link lasts, said in words rather than as a timestamp.
 *
 * A date and time in an email is read in whatever timezone the reader's client
 * decides, and "expires at 14:00" an hour after it arrives reads as a fault.
 * "Within the next hour" cannot be misread and needs no timezone.
 */
function validFor(hours: number): string {
  if (hours <= 1) return "This link works for one hour.";
  if (hours < 48) return `This link works for ${hours} hours.`;
  return `This link works for ${Math.round(hours / 24)} days.`;
}

export type AccountAccessFacts = {
  /** The person's name, so the message is addressed rather than generic. */
  name: string;
  /** The full URL. Built by the caller; never logged, never stored. */
  link: string;
  /** How long the credential lives, for the sentence above. */
  lifetimeHours: number;
};

/**
 * "Set up your BSCJ account."
 *
 * Sent once BSCJ has opened an account and invited its first user. It does
 * **not** contain a password, because no password was ever chosen — that is
 * the entire point of replacing the old flow, in which an administrator typed
 * one and then had to communicate it somehow.
 */
export function renderAccountInvitationEmail(
  facts: AccountAccessFacts,
): RenderedEmail {
  const subject = `Set up your ${business.name} account`;
  const preheader = "Choose a password to finish setting up your account.";

  const { html, text } = shell(
    preheader,
    [
      `Hello ${facts.name},`,
      `${business.name} has set up an account for you.`,
      "Choose a password to finish, and you are in. Nobody has set one for you and nobody at BSCJ can see the one you choose.",
    ],
    { label: "Choose your password", href: facts.link },
    [
      `${validFor(facts.lifetimeHours)} If it has run out by the time you get to it, ask us for another — no harm done.`,
      `This link is just for you. Please do not forward it.`,
      `Not expecting this? Ignore it and nothing happens. If you would rather check first, call ${business.phoneDisplay}.`,
    ],
  );

  return { subject, preheader, html, text };
}

/**
 * "Reset your password."
 *
 * Sent only to an address that actually has a live account — but the *form*
 * that requests it answers identically either way, so this message's existence
 * is never something a stranger can infer.
 *
 * The last line matters: somebody who did not ask for this needs to know that
 * ignoring it is safe and that nothing has already changed.
 */
export function renderPasswordResetEmail(
  facts: AccountAccessFacts,
): RenderedEmail {
  const subject = `Reset your ${business.name} password`;
  const preheader = "Choose a new password.";

  const { html, text } = shell(
    preheader,
    [
      `Hello ${facts.name},`,
      "Somebody asked to reset the password on this account.",
      "Choose a new one using the link below. Your current password keeps working until you do.",
    ],
    { label: "Choose a new password", href: facts.link },
    [
      `${validFor(facts.lifetimeHours)}`,
      "Setting a new password signs out anybody already using the account, on every device.",
      `Did not ask for this? Ignore this message — nothing has changed and nothing will. If it keeps happening, call ${business.phoneDisplay}.`,
    ],
  );

  return { subject, preheader, html, text };
}
