/**
 * Lifts the four Carlito font subsets out of the standalone invoice generator.
 *
 * **Development tooling, not application code.** Nothing in `src` imports it.
 * It exists so `src/lib/invoices/pdf/fonts.generated.ts` is reproducible
 * rather than a 240 KB blob somebody has to take on trust: run this against
 * the original and the output must be byte-identical to what is committed.
 *
 * It reads the generator **read-only** and copies exactly one thing: the
 * `FONTS` object, which is font data and font metrics. It deliberately copies
 * nothing else from that file — no layout coordinates, no company name, no
 * bank details, no landlord list. Those are either configuration (and belong
 * in `business_setting`) or somebody else's records (and belong nowhere near
 * this repository).
 *
 * Carlito is Copyright (c) 2010-2013 Łukasz Dziedzic, licensed under the SIL
 * Open Font Licence 1.1, which permits redistribution as part of a larger
 * work. The subsets here are the WinAnsi range only.
 *
 * Usage:
 *   node scripts/extract-invoice-fonts.mjs [path-to-generator.html]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

const SOURCE =
  process.argv[2] ?? path.join(os.homedir(), "Invoice Generator", "Invoice Generator.html");

const OUT = path.join(
  process.cwd(),
  "src",
  "lib",
  "invoices",
  "pdf",
  "fonts.generated.ts",
);

const html = readFileSync(SOURCE, "utf8");

const match = html.match(/const FONTS = (\{.*?\});\n/s);
if (!match) {
  console.error(`No FONTS object found in ${SOURCE}.`);
  process.exit(1);
}

const fonts = JSON.parse(match[1]);

const FACES = ["reg", "bold", "ital", "bi"];
for (const face of FACES) {
  if (!fonts[face]) {
    console.error(`Face "${face}" is missing from the source.`);
    process.exit(1);
  }
}

const winansi = html.match(/const WINANSI = (\{.*?\});\n/s);
if (!winansi) {
  console.error("No WINANSI table found in the source.");
  process.exit(1);
}

const lines = [];
lines.push(`/**`);
lines.push(` * Carlito, and the WinAnsi mapping — generated, do not edit by hand.`);
lines.push(` *`);
lines.push(` * Produced by \`scripts/extract-invoice-fonts.mjs\` from the standalone`);
lines.push(` * invoice generator, which is the only thing copied out of it. Re-running`);
lines.push(` * that script against the original must reproduce this file exactly.`);
lines.push(` *`);
lines.push(` * Carlito is metric-compatible with Calibri, which is what the existing`);
lines.push(` * invoices are set in — so the same coordinates produce the same page.`);
lines.push(` * Copyright (c) 2010-2013 Łukasz Dziedzic, SIL Open Font Licence 1.1.`);
lines.push(` *`);
lines.push(` * Subset to the WinAnsi range: widths are 224 entries, code 32 to 255.`);
lines.push(` * Server-side only — none of this reaches a browser bundle.`);
lines.push(` */`);
lines.push(``);
lines.push(`export type FontFace = "reg" | "bold" | "ital" | "bi";`);
lines.push(``);
lines.push(`export type EmbeddedFont = {`);
lines.push(`  /** PostScript name, as it appears in the PDF font dictionary. */`);
lines.push(`  name: string;`);
lines.push(`  stemv: number;`);
lines.push(`  bbox: readonly number[];`);
lines.push(`  italic: number;`);
lines.push(`  asc: number;`);
lines.push(`  desc: number;`);
lines.push(`  cap: number;`);
lines.push(`  /** Advance widths for codes 32..255, in 1/1000 em. */`);
lines.push(`  w: readonly number[];`);
lines.push(`  /** The TrueType subset itself. */`);
lines.push(`  b64: string;`);
lines.push(`};`);
lines.push(``);

const digests = [];

lines.push(`export const FONTS: Readonly<Record<FontFace, EmbeddedFont>> = {`);
for (const face of FACES) {
  const f = fonts[face];
  const bytes = Buffer.from(f.b64, "base64");
  digests.push(
    `${face}: ${f.name}, ${bytes.length} bytes, sha256 ${createHash("sha256")
      .update(bytes)
      .digest("hex")}`,
  );
  lines.push(`  ${face}: {`);
  lines.push(`    name: ${JSON.stringify(f.name)},`);
  lines.push(`    stemv: ${f.stemv},`);
  lines.push(`    bbox: [${f.bbox.join(", ")}],`);
  lines.push(`    italic: ${f.italic},`);
  lines.push(`    asc: ${f.asc},`);
  lines.push(`    desc: ${f.desc},`);
  lines.push(`    cap: ${f.cap},`);
  lines.push(`    w: [${f.w.join(", ")}],`);
  lines.push(`    b64: ${JSON.stringify(f.b64)},`);
  lines.push(`  },`);
}
lines.push(`};`);
lines.push(``);
lines.push(`/** Unicode code point to its WinAnsi (cp1252) byte. */`);
lines.push(
  `export const WINANSI: Readonly<Record<string, number>> = ${winansi[1]};`,
);
lines.push(``);

writeFileSync(OUT, lines.join("\n"), "utf8");

console.log(`Wrote ${OUT}`);
for (const d of digests) console.log(`  ${d}`);
