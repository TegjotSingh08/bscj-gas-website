import { escapeHtml } from "./escape";
import type { RenderedEmail } from "./booking-confirmation";
import { business } from "@/lib/business";
import { formatLongDate } from "@/lib/booking/time";

/**
 * Sending somebody their invoice.
 *
 * **The PDF is attached**, and it is the exact document that was issued —
 * fetched from private storage by the worker, not re-rendered. An invoice is
 * a document somebody has to keep, forward to a bookkeeper and file, and
 * making them sign in to get it is how it gets chased by telephone instead.
 *
 * That is a deliberate difference from a certificate, which describes a
 * property and is more sensitive than the amount of a bill.
 *
 * Nothing here states a fact BSCJ has not configured. The payment terms and
 * the payment instructions are on the PDF, printed from `business_setting`;
 * this message does not repeat them, because repeating them would mean
 * deciding what to say when they are empty.
 */

export type InvoiceFacts = {
  number: string;
  /** What the invoice is for, as an address. */
  address: string;
  postcode: string;
  /** `YYYY-MM-DD`, from the invoice. Never recomputed here. */
  issuedOn: string;
  dueDate: string | null;
  /** Already formatted, e.g. "£75.00" — the arithmetic is not repeated here. */
  totalFormatted: string;
  /** Our job reference, so a query can be tied to the work. */
  reference: string;
  /** Where an authenticated agency can read it. Null for a private customer. */
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

export function renderInvoiceEmail(facts: InvoiceFacts): RenderedEmail {
  const where = `${facts.address}, ${facts.postcode}`;
  const subject = `Invoice ${facts.number} — ${facts.address}`;

  const paragraphs = [
    `Invoice <strong>${escapeHtml(facts.number)}</strong> for work at ${escapeHtml(where)} is attached as a PDF.`,
  ];

  const rows: [string, string][] = [
    ["Invoice number", facts.number],
    ["Invoice date", formatLongDate(facts.issuedOn, facts.timeZone)],
  ];

  // Only when terms are configured. No due date is invented.
  if (facts.dueDate) {
    rows.push(["Payment due by", formatLongDate(facts.dueDate, facts.timeZone)]);
  }

  rows.push(["Total", facts.totalFormatted]);
  rows.push(["Our reference", facts.reference]);

  const footer: string[] = [];
  if (facts.portalLink) {
    footer.push(
      `It is also in your account: <a href="${escapeHtml(facts.portalLink)}" style="color:#db7304;font-weight:700;">${escapeHtml(facts.portalLink)}</a>`,
    );
  }
  footer.push(
    "How to pay is printed on the invoice itself.",
  );
  footer.push(
    `Questions about this invoice: ${escapeHtml(business.phone)} · ${escapeHtml(business.emailGeneral)}`,
  );

  const preheader = `Invoice ${facts.number} for ${where}`;
  const { html, text } = shell(preheader, paragraphs, rows, footer);

  return { subject, preheader, html, text };
}
