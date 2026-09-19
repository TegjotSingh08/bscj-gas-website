/**
 * A minimal PDF writer, and the painter interface the layout draws through.
 *
 * Ported from the standalone invoice generator BSCJ already uses, where this
 * approach has produced every invoice the business has issued. It is kept
 * rather than replaced for one reason: the coordinates in `layout.ts` were
 * measured off those invoices, and a different renderer with different text
 * metrics would move every one of them.
 *
 * **No new dependency.** A PDF with embedded TrueType fonts, positioned text
 * and filled rectangles is a few hundred lines, and that is all an invoice
 * needs. Pulling in a general PDF library to draw sixty strings would add a
 * megabyte to the server bundle and a font pipeline to keep working.
 *
 * Two painters implement the same interface:
 *
 * - **`PdfPainter`** writes the file.
 * - **`SvgPainter`** draws the same instructions as an SVG, which is what the
 *   admin preview renders. Same coordinates, same wrapping, same metrics — so
 *   the preview cannot drift from the PDF the way a hand-built HTML mock-up
 *   inevitably would.
 *
 * Pure: no database, no session, no filesystem. It takes positioned strings
 * and returns bytes.
 */

import { FONTS, WINANSI, type FontFace } from "./fonts.generated";

export type { FontFace };

// ---------------------------------------------------------------------------
// Text metrics
// ---------------------------------------------------------------------------

/**
 * The width of one character, in 1/1000 em.
 *
 * Anything outside WinAnsi becomes `?` (63) — the same substitution the PDF
 * writer makes below, so a measured width always matches what is drawn. A
 * character that measured as one thing and printed as another is how text
 * silently overflows a column.
 */
function charWidth(face: FontFace, ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  const b = cp < 128 ? cp : (WINANSI[String(cp)] ?? 63);
  if (b < 32 || b > 255) return 0;
  return FONTS[face].w[b - 32] ?? 0;
}

/** The width of a string at a given size, in points. */
export function textWidth(face: FontFace, str: string, size: number): number {
  let total = 0;
  for (const ch of str) total += charWidth(face, ch);
  return (total * size) / 1000;
}

/**
 * Greedy word wrap to a maximum width, in points.
 *
 * A single word wider than the column is hard-broken rather than allowed to
 * run over the rule — a long postcode-free street name or an email address
 * would otherwise print across the table border.
 */
export function wrapText(
  face: FontFace,
  str: string,
  size: number,
  maxW: number,
): string[] {
  const words = str.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let cur = "";

  for (let w of words) {
    while (textWidth(face, w, size) > maxW) {
      let cut = 1;
      while (cut < w.length && textWidth(face, w.slice(0, cut + 1), size) <= maxW) {
        cut++;
      }
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      lines.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const trial = cur ? `${cur} ${w}` : w;
    if (textWidth(face, trial, size) <= maxW) cur = trial;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }

  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [""];
}

/**
 * Shrinks a size until the string fits, down to a floor.
 *
 * Used for the fields that must stay on one line — a payer's name, an
 * amount — where wrapping would break the layout rather than extend it.
 *
 * **It can fail**, which is why it is private. A string long enough will still
 * be wider than the column at the floor size, and this returns the floor
 * regardless: the caller draws it and it runs over whatever is beside it.
 * `fitOrOverflow` is the exported one because it answers the question that
 * matters — silently overlapping text is the failure mode a person notices
 * last, since it reads as a rendering glitch rather than a missing fact.
 */
function fitSize(
  face: FontFace,
  str: string,
  size: number,
  maxW: number,
  floor = 7,
): number {
  let s = size;
  while (textWidth(face, str, s) > maxW && s > floor) s -= 0.25;
  return s;
}

/**
 * The same, and it says whether it actually worked.
 *
 * `overflows` is true when the string is still wider than the column even at
 * the floor size. Every caller in the layout reports that as a warning, and a
 * warning stops the invoice being issued — so no document leaves this system
 * with one field printed over another.
 */
export function fitOrOverflow(
  face: FontFace,
  str: string,
  size: number,
  maxW: number,
  floor = 7,
): { size: number; overflows: boolean } {
  const fitted = fitSize(face, str, size, maxW, floor);
  return { size: fitted, overflows: textWidth(face, str, fitted) > maxW };
}

// ---------------------------------------------------------------------------
// The painter
// ---------------------------------------------------------------------------

/**
 * Where a painter draws.
 *
 * PDF user space: origin bottom-left, one unit is one point. The layout is
 * written in these coordinates because that is what the original invoices
 * were measured in, and converting them would be an opportunity to be a
 * quarter of a point out everywhere.
 */
export abstract class Painter {
  readonly w: number;
  readonly h: number;

  constructor(width: number, height: number) {
    this.w = width;
    this.h = height;
  }

  abstract rect(x: number, y: number, w: number, h: number): void;
  abstract text(
    face: FontFace,
    size: number,
    x: number,
    y: number,
    str: string,
  ): void;

  textCentre(
    face: FontFace,
    size: number,
    cx: number,
    y: number,
    str: string,
  ): void {
    if (!str) return;
    this.text(face, size, cx - textWidth(face, str, size) / 2, y, str);
  }

  textRight(
    face: FontFace,
    size: number,
    rx: number,
    y: number,
    str: string,
  ): void {
    if (!str) return;
    this.text(face, size, rx - textWidth(face, str, size), y, str);
  }

  /** Centred text with a rule beneath it, as the original template draws it. */
  textCentreUnderlined(
    face: FontFace,
    size: number,
    cx: number,
    y: number,
    str: string,
    drop: number,
    thick: number,
  ): void {
    if (!str) return;
    const w = textWidth(face, str, size);
    this.text(face, size, cx - w / 2, y, str);
    this.rect(cx - w / 2, y - drop, w, thick);
  }
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** A JS string as an escaped PDF literal, in WinAnsi bytes. */
function pdfLiteral(str: string): string {
  let out = "";
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 63;
    const b = cp < 128 ? cp : (WINANSI[String(cp)] ?? 63);
    const c = String.fromCharCode(b);
    if (c === "(" || c === ")" || c === "\\") out += `\\${c}`;
    else out += c;
  }
  return `(${out})`;
}

type PdfObject = { dict: string; stream?: Uint8Array };

export class PdfPainter extends Painter {
  private readonly ops: string[] = [];
  private readonly used = new Set<FontFace>();

  rect(x: number, y: number, w: number, h: number): void {
    this.ops.push(`0 g ${f(x)} ${f(y)} ${f(w)} ${f(h)} re f`);
  }

  text(
    face: FontFace,
    size: number,
    x: number,
    y: number,
    str: string,
  ): void {
    if (!str) return;
    this.used.add(face);
    this.ops.push(
      `BT /${face} ${f(size)} Tf 0 g 1 0 0 1 ${f(x)} ${f(y)} Tm ${pdfLiteral(str)} Tj ET`,
    );
  }

  /** The finished file. */
  build(): Uint8Array {
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let len = 0;

    const push = (d: string | Uint8Array) => {
      const b = typeof d === "string" ? latin1ToBytes(d) : d;
      chunks.push(b);
      len += b.length;
    };

    const objects: (PdfObject | null)[] = [];
    const obj = (body: PdfObject | null): number => {
      objects.push(body);
      return objects.length;
    };

    const catalog = obj(null);
    const pages = obj(null);
    const page = obj(null);
    const content = obj(null);

    // Only the faces actually drawn are embedded. A blank template that never
    // uses the italic face does not carry 41 KB of it.
    const faces = [...this.used];
    const fontRefs: Partial<Record<FontFace, number>> = {};

    for (const key of faces) {
      const F = FONTS[key];
      const ttf = b64ToBytes(F.b64);
      const file = obj({
        stream: ttf,
        dict: `/Length ${ttf.length} /Length1 ${ttf.length}`,
      });
      const flags = 32 | (F.italic ? 64 : 0);
      const desc = obj({
        dict:
          `/Type /FontDescriptor /FontName /${F.name} /Flags ${flags} ` +
          `/FontBBox [${F.bbox.join(" ")}] /ItalicAngle ${F.italic} /Ascent ${F.asc} ` +
          `/Descent ${F.desc} /CapHeight ${F.cap} /StemV ${F.stemv} /FontFile2 ${file} 0 R`,
      });
      fontRefs[key] = obj({
        dict:
          `/Type /Font /Subtype /TrueType /BaseFont /${F.name} /FirstChar 32 /LastChar 255 ` +
          `/Widths [${F.w.join(" ")}] /Encoding /WinAnsiEncoding /FontDescriptor ${desc} 0 R`,
      });
    }

    const cs = this.ops.join("\n");
    const fontRes = faces.map((k) => `/${k} ${fontRefs[k]} 0 R`).join(" ");

    objects[catalog - 1] = { dict: `/Type /Catalog /Pages ${pages} 0 R` };
    objects[pages - 1] = { dict: `/Type /Pages /Kids [${page} 0 R] /Count 1` };
    objects[page - 1] = {
      dict:
        `/Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${f(this.w)} ${f(this.h)}] ` +
        `/Resources << /Font << ${fontRes} >> /ProcSet [/PDF /Text] >> /Contents ${content} 0 R`,
    };
    objects[content - 1] = {
      stream: latin1ToBytes(cs),
      dict: `/Length ${cs.length}`,
    };

    push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
    objects.forEach((o, i) => {
      offsets[i] = len;
      push(`${i + 1} 0 obj\n<< ${o!.dict} >>\n`);
      if (o!.stream) {
        push("stream\n");
        push(o!.stream);
        push("\nendstream\n");
      }
      push("endobj\n");
    });

    const xref = len;
    let x = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach((o) => {
      x += `${String(o).padStart(10, "0")} 00000 n \n`;
    });
    x += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    push(x);

    const out = new Uint8Array(len);
    let p = 0;
    for (const c of chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// SVG preview
// ---------------------------------------------------------------------------

const FACE_CSS: Record<FontFace, { style: string; weight: string }> = {
  reg: { style: "normal", weight: "400" },
  bold: { style: "normal", weight: "700" },
  ital: { style: "italic", weight: "400" },
  bi: { style: "italic", weight: "700" },
};

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The same instructions, as an SVG.
 *
 * The preview an administrator approves has to be the document that is
 * issued. Rendering it from the same `paintInvoice` call — same wrapping,
 * same overflow warnings, same coordinates — is the only way to promise
 * that. The browser substitutes Calibri or a metric-compatible face; letter
 * positions come from the layout, not from the browser, so a font
 * substitution shifts glyph shapes and nothing else.
 */
export class SvgPainter extends Painter {
  private readonly parts: string[] = [];

  rect(x: number, y: number, w: number, h: number): void {
    // Flipped into SVG space, where y runs downwards.
    this.parts.push(
      `<rect x="${f(x)}" y="${f(this.h - y - h)}" width="${f(Math.max(w, 0.35))}" height="${f(
        Math.max(h, 0.35),
      )}" fill="#000"/>`,
    );
  }

  text(
    face: FontFace,
    size: number,
    x: number,
    y: number,
    str: string,
  ): void {
    if (!str) return;
    const { style, weight } = FACE_CSS[face];
    this.parts.push(
      `<text x="${f(x)}" y="${f(this.h - y)}" font-family="Calibri, Carlito, Helvetica, sans-serif" ` +
        `font-size="${f(size)}" font-style="${style}" font-weight="${weight}" fill="#000" ` +
        `xml:space="preserve">${escapeXml(str)}</text>`,
    );
  }

  build(): string {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(this.w)} ${f(this.h)}" ` +
      `width="100%" role="img" aria-label="Invoice preview">` +
      `<rect x="0" y="0" width="${f(this.w)}" height="${f(this.h)}" fill="#fff"/>` +
      this.parts.join("") +
      `</svg>`
    );
  }
}
