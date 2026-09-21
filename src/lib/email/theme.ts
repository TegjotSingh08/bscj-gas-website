/**
 * The shared look of every transactional email BSCJ sends.
 *
 * One module so a later message cannot drift into its own palette, its own
 * button and its own idea of a heading. The colours are the site's own — the
 * navy and orange in `globals.css` — restated here because an email cannot
 * reach a stylesheet.
 *
 * **Email is not the web.** Everything below is inline, table-based and
 * conservative on purpose:
 *
 * - No `<style>` block and no classes. Several clients strip both, and Gmail
 *   strips the `<head>` entirely.
 * - No flexbox, no grid, no custom properties, no `rem`. Outlook's rendering
 *   engine is Word's, and it understands none of them.
 * - No web font. `FONT_STACK` names what is already on the device; a font that
 *   fails to load silently reflows a layout that was tested with it.
 * - No background image and no image-only content. Images are blocked by
 *   default in many clients, so anything that matters is text.
 *
 * **Dark mode is handled by not fighting it.** Clients that invert colours do
 * so unpredictably, so the palette keeps real contrast both ways: dark navy
 * text on white, white on navy, and no light-grey-on-white anywhere. A
 * `color-scheme` hint is emitted for the clients that honour it, which stops
 * the more aggressive ones inverting a brand panel into something muddy.
 */

export const NAVY_900 = "#0b1b30";
export const NAVY_800 = "#112643";
export const NAVY_700 = "#16304f";
export const NAVY_600 = "#1c3a63";
export const NAVY_200 = "#c2d5ec";
export const NAVY_100 = "#e3ecf7";
export const NAVY_50 = "#f2f6fb";
export const FLAME_600 = "#db7304";
export const FLAME_500 = "#e2680f";
export const FLAME_400 = "#ffab2e";
export const WHITE = "#ffffff";

export const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

/** The readable width of a message. Wider than this is hard to scan on a phone. */
export const CONTENT_WIDTH = 560;

/**
 * The header every message carries.
 *
 * Wordmark as **text**, not an image: images are blocked by default in many
 * clients, and a brand that disappears in half of them is not a brand. The
 * navy bar makes the message recognisably BSCJ at a glance, which is most of
 * what a header is for.
 */
export function header(): string {
  return `<tr><td style="background-color:${NAVY_900};padding:20px 24px;">
<p style="margin:0;font-family:${FONT_STACK};font-size:19px;font-weight:bold;color:${WHITE};letter-spacing:-0.01em;">BSCJ <span style="color:${FLAME_400};">Gas &amp; Heating</span></p>
<p style="margin:4px 0 0;font-family:${FONT_STACK};font-size:12px;color:${NAVY_200};">Gas Safe registered engineer</p>
</td></tr>`;
}

/** A heading. One per message — the thing it is about. */
export function heading(text: string): string {
  return `<p style="margin:0 0 12px;font-family:${FONT_STACK};font-size:21px;line-height:1.25;font-weight:bold;color:${NAVY_900};">${text}</p>`;
}

/** Body copy. Short paragraphs; a wall of text is not read on a phone. */
export function paragraph(html: string, muted = false): string {
  return `<p style="margin:0 0 12px;font-family:${FONT_STACK};font-size:15px;line-height:1.5;color:${muted ? NAVY_600 : NAVY_800};">${html}</p>`;
}

/**
 * The appointment, or whatever the message is really about.
 *
 * A bordered panel rather than a run of sentences, because this is the part
 * somebody comes back to the message to re-read. Rows are a table: it is the
 * only layout Outlook renders reliably, and a label/value pair is genuinely
 * tabular.
 */
export function detailPanel(rows: readonly { label: string; value: string }[]): string {
  const cells = rows
    .map(
      ({ label, value }) => `<tr>
<td style="padding:6px 0;font-family:${FONT_STACK};font-size:12px;font-weight:bold;letter-spacing:0.06em;text-transform:uppercase;color:${NAVY_600};white-space:nowrap;vertical-align:top;width:38%;">${label}</td>
<td style="padding:6px 0 6px 12px;font-family:${FONT_STACK};font-size:15px;line-height:1.4;color:${NAVY_900};font-weight:bold;">${value}</td>
</tr>`,
    )
    .join("");

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:2px solid ${NAVY_200};border-radius:12px;background-color:${NAVY_50};margin:0 0 16px;">
<tr><td style="padding:14px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${cells}</table>
</td></tr></table>`;
}

/**
 * The one action a message asks for.
 *
 * A single prominent button, never two competing ones — a message with two
 * equal calls to action has none. The href is repeated as text underneath by
 * `fallbackLink`, because a client that strips the anchor still has to leave
 * somebody able to act.
 */
export function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 12px;">
<tr><td style="border-radius:12px;background-color:${FLAME_500};">
<a href="${href}" style="display:inline-block;padding:14px 28px;font-family:${FONT_STACK};font-size:16px;font-weight:bold;color:${WHITE};text-decoration:none;border-radius:12px;">${label}</a>
</td></tr></table>`;
}

/** The same link as plain text, for a client that ate the button. */
export function fallbackLink(href: string): string {
  return `<p style="margin:0 0 16px;font-family:${FONT_STACK};font-size:12px;line-height:1.5;color:${NAVY_600};word-break:break-all;">If the button does not work, copy this into your browser:<br />${href}</p>`;
}

/** A quiet note. Smaller, still legible — never light grey on white. */
export function note(html: string): string {
  return `<p style="margin:0 0 10px;font-family:${FONT_STACK};font-size:13px;line-height:1.5;color:${NAVY_600};">${html}</p>`;
}

/** A thin rule, for separating the message from its footer. */
export function divider(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 14px;"><tr><td style="border-top:2px solid ${NAVY_100};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}

/**
 * Wraps a message body in the shell.
 *
 * `preheader` is the line a client shows beside the subject in the list. It is
 * hidden in the body and is worth writing: left out, clients fill it with
 * whatever text comes first, which is usually the greeting.
 *
 * `lang` and `role="presentation"` on every layout table keep a screen reader
 * announcing the content rather than the scaffolding.
 */
export function shell(input: {
  preheader: string;
  body: string;
  footer: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en-GB"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
</head>
<body style="margin:0;padding:0;background-color:${NAVY_50};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${input.preheader}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${NAVY_50};">
<tr><td align="center" style="padding:16px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:${CONTENT_WIDTH}px;background-color:${WHITE};border-radius:16px;overflow:hidden;">
${header()}
<tr><td style="padding:24px;">${input.body}</td></tr>
<tr><td style="background-color:${NAVY_50};padding:16px 24px;border-top:2px solid ${NAVY_100};">${input.footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
