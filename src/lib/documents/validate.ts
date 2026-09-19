/**
 * Is this actually a PDF, and is it a sensible size?
 *
 * **Checked on the server, from the bytes.** A `Content-Type` is whatever the
 * client says it is, an `accept=".pdf"` on a file input is a convenience for
 * the person choosing, and a filename ending in `.pdf` is four characters
 * anybody can type. None of the three is evidence. The only thing that is
 * evidence is the file itself.
 *
 * This does not parse PDFs and does not try to. It establishes that the
 * bytes begin and end the way a PDF does, which is enough to keep a
 * mistyped upload, a photograph of a certificate or something actively
 * unpleasant out of the document store. What it deliberately does not do is
 * claim the document is *valid* — that is a judgement for the administrator
 * reviewing it, and the whole release step exists because software cannot
 * make it.
 *
 * Pure and dependency-free.
 */

/** `%PDF-` — the five bytes every PDF starts with. */
const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

/**
 * The size cap.
 *
 * A one-page A4 certificate rendered at scale 3 and re-encoded as JPEG comes
 * out around 200–600 KB. Ten megabytes is far more headroom than that needs
 * and still small enough that a bad upload cannot fill the store or hold a
 * request open. It is a guard, not a target.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** Below this it is not a document, it is a mistake or an empty file. */
export const MIN_DOCUMENT_BYTES = 1024;

export type DocumentCheck =
  | { ok: true; sizeBytes: number; filename: string }
  | { ok: false; error: string };

/**
 * A filename safe to store and to put in a `Content-Disposition`.
 *
 * Not the customer's address, not a name — the caller decides what to call
 * it. This only ensures whatever they chose cannot become a path, a header
 * injection or an empty string.
 */
export function safeDocumentFilename(raw: unknown, fallback: string): string {
  const name = typeof raw === "string" ? raw : "";
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    // Quotes and control characters are what would break out of a header.
    .replace(/["\r\n\t\\]/g, "")
    .replace(/[^A-Za-z0-9 ._-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  if (!cleaned || cleaned === ".pdf" || cleaned.startsWith(".")) return fallback;
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

/**
 * Checks the uploaded bytes.
 *
 * Every refusal says what is wrong in terms the person can act on. "Invalid
 * file" tells an engineer in a doorway nothing at all.
 */
export function checkPdf(bytes: Uint8Array, rawFilename: unknown): DocumentCheck {
  if (bytes.byteLength === 0) {
    return { ok: false, error: "That file is empty." };
  }
  if (bytes.byteLength < MIN_DOCUMENT_BYTES) {
    return {
      ok: false,
      error: "That file is too small to be a certificate. Check you picked the right one.",
    };
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    const mb = (bytes.byteLength / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      error: `That file is ${mb} MB. The limit is ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`,
    };
  }

  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) {
      return {
        ok: false,
        error: "That is not a PDF. Export the certificate from the generator and upload that file.",
      };
    }
  }

  /*
    A PDF ends with `%%EOF`, usually followed by a newline. Checked over the
    last kilobyte rather than the exact tail, because writers differ about
    trailing whitespace — and a truncated upload, which is the failure this
    catches, is missing it entirely.
  */
  const tail = bytes.subarray(Math.max(0, bytes.byteLength - 1024));
  const tailText = Array.from(tail, (b) => String.fromCharCode(b)).join("");
  if (!tailText.includes("%%EOF")) {
    return {
      ok: false,
      error: "That PDF looks incomplete — it may not have finished downloading. Try again.",
    };
  }

  return {
    ok: true,
    sizeBytes: bytes.byteLength,
    filename: safeDocumentFilename(rawFilename, "certificate.pdf"),
  };
}
