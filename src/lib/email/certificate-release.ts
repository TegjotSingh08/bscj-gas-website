import { escapeHtml } from "./escape";
import type { RenderedEmail } from "./booking-confirmation";
import { business } from "@/lib/business";
import { formatLongDate } from "@/lib/booking/time";

/**
 * Telling somebody their gas safety record is ready.
 *
 * **The certificate is not attached.** It is a document about a property,
 * held privately, and email is not a place to put one: a forwarded message
 * carries it to whoever the recipient forwards to, a mailbox breach carries
 * it further, and neither is recoverable. The message says the record
 * exists, states the facts that are already on it, and points at the place
 * it can be read by somebody the application has authenticated.
 *
 * That also keeps this consistent with every other message here: nothing is
 * sent that a recipient could not already see, and the addresses are
 * resolved at send time rather than carried in a queue.
 *
 * No price appears. A certificate is a compliance record; what the work
 * cost belongs on an invoice, and there is no invoice.
 */

export type CertificateFacts = {
  reference: string;
  certificateNumber: string;
  address: string;
  postcode: string;
  /** `YYYY-MM-DD`. Both come from the record, never recomputed here. */
  inspectionDate: string;
  nextDueDate: string;
  /** Set when this replaces an earlier version. */
  correctionReason: string | null;
  version: number;
  /** Where an authenticated recipient can read it. Never a document URL. */
  portalLink: string | null;
  timeZone: string;
};

function shell(
  preheader: string,
  paragraphs: string[],
  rows: [string, string][],
  footer: string[],
): { html: string; text: string } {
  const html = `<!doctype html><html lang="en-GB"><body style="margin:0;padding:24px;background:#f2f6fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0b1b30;">
<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</div>
<div style="max-width:560px;margin:0 auto;background:#fff;border:2px solid #c2d5ec;border-radius:16px;padding:24px;">
<p style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#db7304;">${escapeHtml(business.name)}</p>
${paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;">${p}</p>`).join("")}
<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
${rows
  .map(
    ([label, value]) =>
      `<tr><td style="padding:6px 0;color:#1c3a63;">${escapeHtml(label)}</td><td style="padding:6px 0;font-weight:700;text-align:right;">${escapeHtml(value)}</td></tr>`,
  )
  .join("")}
</table>
${footer.map((f) => `<p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:#1c3a63;">${f}</p>`).join("")}
</div></body></html>`;

  const text = [
    business.name,
    "",
    ...paragraphs.map((p) => p.replace(/<[^>]+>/g, "")),
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    ...footer.map((f) => f.replace(/<[^>]+>/g, "")),
  ].join("\n");

  return { html, text };
}

export function renderCertificateReleaseEmail(
  facts: CertificateFacts,
): RenderedEmail {
  const corrected = facts.version > 1;
  const where = `${facts.address}, ${facts.postcode}`;

  const subject = corrected
    ? `Corrected gas safety record — ${facts.address} (${facts.certificateNumber})`
    : `Gas safety record — ${facts.address} (${facts.certificateNumber})`;

  const paragraphs = [
    corrected
      ? `A <strong>corrected</strong> gas safety record has been issued for ${escapeHtml(where)}. It replaces the version issued previously.`
      : `The gas safety record for ${escapeHtml(where)} has been issued.`,
  ];

  if (corrected && facts.correctionReason) {
    paragraphs.push(`What changed: ${escapeHtml(facts.correctionReason)}`);
  }

  const rows: [string, string][] = [
    ["Certificate number", facts.certificateNumber],
    ["Inspection carried out", formatLongDate(facts.inspectionDate, facts.timeZone)],
    ["Next inspection due by", formatLongDate(facts.nextDueDate, facts.timeZone)],
    ["Our reference", facts.reference],
  ];

  const footer: string[] = [];
  if (facts.portalLink) {
    footer.push(
      `The record itself is in your account: <a href="${escapeHtml(facts.portalLink)}" style="color:#db7304;font-weight:700;">${escapeHtml(facts.portalLink)}</a>`,
    );
  }
  footer.push(
    "The document is not attached. It is held securely and can be downloaded by signing in, or we can send it another way if you ask.",
  );
  footer.push(
    `Questions: ${escapeHtml(business.phone)} · ${escapeHtml(business.emailGeneral)}`,
  );

  const preheader = corrected
    ? `Corrected gas safety record for ${where}`
    : `Gas safety record for ${where}`;
  const { html, text } = shell(preheader, paragraphs, rows, footer);

  return { subject, preheader, html, text };
}
