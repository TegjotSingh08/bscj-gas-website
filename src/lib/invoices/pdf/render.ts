/**
 * The two things the application asks of the renderer.
 *
 * `renderInvoicePdf` produces the file that is stored and attached.
 * `renderInvoiceSvg` produces the preview an administrator approves.
 *
 * Both call `paintInvoice` with the same input, so the preview cannot show
 * one document and the PDF contain another — which is the whole reason the
 * preview is not a separate HTML mock-up of the same information.
 */

import { PAGE, paintInvoice, type InvoiceRenderInput } from "./layout";
import { PdfPainter, SvgPainter } from "./painter";

export type RenderedPdf = { bytes: Uint8Array; warnings: string[] };
export type RenderedSvg = { svg: string; warnings: string[] };

export function renderInvoicePdf(input: InvoiceRenderInput): RenderedPdf {
  const painter = new PdfPainter(PAGE.w, PAGE.h);
  const warnings = paintInvoice(input, painter);
  return { bytes: painter.build(), warnings };
}

export function renderInvoiceSvg(input: InvoiceRenderInput): RenderedSvg {
  const painter = new SvgPainter(PAGE.w, PAGE.h);
  const warnings = paintInvoice(input, painter);
  return { svg: painter.build(), warnings };
}

export { PAGE, poundsFromPence } from "./layout";
export type {
  InvoiceDocumentData,
  InvoiceLineView,
  InvoiceRenderInput,
} from "./layout";
