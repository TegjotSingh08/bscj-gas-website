/**
 * The invoice, as a page.
 *
 * Every coordinate below was measured from the invoices BSCJ has actually
 * been sending — A4, 595.5 × 842pt, set in Calibri — and is carried over
 * from the standalone generator unchanged, so a customer who has had one
 * before receives the same document from a different system rather than a
 * redesign they have to check.
 *
 * Two things are deliberately different from the original:
 *
 * 1. **Nothing about the business is in this file.** The original hard-coded
 *    a company name, a telephone number, a qualifications list and three
 *    lines of bank details. All of that is `business_setting`, arrives here
 *    in `identity`, `terms` and `vat`, and is frozen onto the invoice at
 *    issue. The entity behind BSCJ is expected to change; an invoice must
 *    not silently start claiming to have been issued by a company that did
 *    not exist on its date. An unconfigured field prints nothing — there is
 *    no placeholder, because a plausible-looking company name on a document
 *    is a claim this code is not entitled to make.
 *
 * 2. **The body is a list of lines, not one description and one price.**
 *    The original had a single service description with a single amount,
 *    which is all a hand-typed invoice ever needed. An invoice raised from a
 *    job may carry an adjustment, a second service or a credit. The single
 *    line case draws **exactly** where it used to: the property line at
 *    447.60, the description from 422.10, the amount at 418.80.
 *
 * `paintInvoice` returns warnings rather than throwing or truncating
 * silently. A description too long to fit is something the administrator
 * must see before issuing, not something to discover on the customer's copy.
 *
 * Pure: it takes data and a painter. No database, no session, no settings
 * read of its own.
 */

import type {
  BusinessIdentity,
  InvoiceTerms,
  VatPosition,
} from "@/lib/settings/business-identity";
import {
  fitOrOverflow,
  textWidth,
  wrapText,
  type FontFace,
  type Painter,
} from "./painter";

// ---------------------------------------------------------------------------
// What a painted invoice is made of
// ---------------------------------------------------------------------------

export type InvoiceLineView = {
  description: string;
  quantity: number;
  unitPricePence: number;
  totalPence: number;
};

export type InvoiceDocumentData = {
  /** Blank on a draft preview, which is how a draft is visibly not an invoice. */
  number: string | null;
  /** As printed, e.g. "19/09/2026". Formatted by the caller. */
  date: string | null;
  dueDate: string | null;
  /** Who is being billed. */
  payerName: string;
  /** The billing address. Never the property. */
  billingAddressLines: string[];
  /** The service address, printed above the lines and underlined. */
  propertyLine: string | null;
  lines: InvoiceLineView[];
  subtotalPence: number;
  vatPence: number;
  totalPence: number;
  /** A draft watermark, so a preview cannot be mistaken for an invoice. */
  draft: boolean;
  /** Printed under the total when the invoice has been voided. */
  voided: boolean;
};

export type InvoiceRenderInput = {
  data: InvoiceDocumentData;
  identity: BusinessIdentity;
  terms: InvoiceTerms;
  vat: VatPosition;
};

export const PAGE = { w: 595.5, h: 842 } as const;

type Face = FontFace;

/**
 * The measured layout.
 *
 * Kept as a single declarative object, as the original was, because that is
 * what makes a coordinate checkable against a printed invoice with a ruler
 * instead of readable only by running the code.
 */
const L = {
  page: PAGE,

  // -- Masthead. Text comes from configuration; the geometry does not. -----
  invoiceWord: { face: "bi" as Face, size: 12, cx: 544.13, y: 797.8, text: "Invoice" },
  company: { face: "bi" as Face, size: 36, cx: 294.1, y: 774.9 },
  tagline: { face: "bi" as Face, size: 12, cx: 302.9, y: 740.5 },
  quals: { face: "bold" as Face, size: 10, cx: 302.9, y: 727.8 },
  services: { face: "ital" as Face, size: 11, cx: 302.9, ys: [714.5, 701.1] },
  /*
    The contact row: telephone on the left, email on the right, on one
    baseline.

    `gap` is the clear space they must leave between them. Without it the two
    simply grew towards each other and printed on top of one another — which
    is what a long number and a long address actually did, and the page said
    nothing about it. Both are now measured against their own half of the row
    and the collision is reported.
  */
  phone: { face: "bi" as Face, size: 11, x: 53.1, y: 650.28, maxW: 230 },
  /** Sits beside the telephone line; empty unless an email is configured. */
  email: { face: "bi" as Face, size: 11, rx: 548.88, y: 650.28, maxW: 230 },
  contactRow: { gap: 12 },

  // -- Date, number, payer ------------------------------------------------
  dateLabel: { face: "bi" as Face, size: 11, x: 411.95, y: 611.28, text: "Date:" },
  dateValue: { face: "bi" as Face, size: 11, rx: 558.7, y: 611.28 },
  invLabel: { face: "bi" as Face, size: 11, x: 387.65, y: 598.4, text: "Invoice no:" },
  invValue: { face: "bi" as Face, size: 11, rx: 558.88, y: 598.4 },
  dueLabel: { face: "bi" as Face, size: 10, rx: 558.88, y: 585.5 },
  /*
    The payer's name.

    `maxW` is 480, not the 300 carried over from the original generator. There
    is nothing to the right of this line — the date and invoice-number block
    sits well above it — so 300 was a limit with no cause, and it shrank a
    perfectly ordinary agency name ("Customer Name: …Lettings (Wolverhampton)
    Limited" measures 328pt at full size) for no reason. 480 leaves a margin
    and is the width actually available.
  */
  custName: { face: "bold" as Face, size: 11, x: 53.1, y: 555.1, maxW: 480 },
  address: {
    face: "bold" as Face,
    size: 11,
    x: 53.1,
    y: 526.1,
    lead: 13.5,
    maxW: 229,
    maxLines: 4,
  },

  // -- Table geometry, 0.5pt rules exactly as the template draws them ------
  tbl: {
    x0: 44.0,
    xMid: 423.58,
    x1: 548.88,
    xTotalSplit: 313.95,
    t: 0.5,
    rules: [478.35, 457.75, 220.33, 190.63],
    ruleW: 505.38,
    bands: [
      { y: 458.25, h: 20.1, xs: [44.0, 423.58, 548.88] }, // heading row
      { y: 220.83, h: 236.92, xs: [44.0, 423.58, 548.88] }, // body
      { y: 191.13, h: 29.2, xs: [44.0, 313.95, 423.58, 548.88] }, // total row
    ],
  },
  colDesc: { cx: 234.04, maxW: 364 },
  colPrice: { cx: 486.48, maxW: 112 },
  colTotalLabel: { cx: 369.02, maxW: 100 },

  head: { face: "bold" as Face, size: 11, yDesc: 467.9, yPrice: 468.8 },
  property: { face: "bi" as Face, size: 11, y: 447.6, ulDrop: 1.95, ulThick: 0.7 },
  desc: {
    face: "ital" as Face,
    size: 11,
    yFirst: 447.6,
    yAfterProperty: 422.1,
    lead: 12.75,
    yFloor: 227.0,
    /** Gap between one line item and the next. */
    itemGap: 6.0,
  },
  /**
   * The amount sits fractionally below its description's baseline, because it
   * is set a point larger. 422.10 − 3.30 = 418.80, which is where the original
   * put the single price.
   */
  price: { face: "reg" as Face, size: 12, dropFromDesc: 3.3 },
  qty: { face: "ital" as Face, size: 9.5 },
  totalRow: { face: "bold" as Face, size: 11, y: 210.7, text: "Total (£):" },
  totalVal: { face: "reg" as Face, size: 12, y: 210.7 },
  /** Only drawn when VAT registration is on. Off today. */
  vatRows: { face: "bold" as Face, size: 10, ySubtotal: 178.0, yVat: 165.5, labelCx: 369.02 },
  vatNumber: { face: "ital" as Face, size: 9.5, x: 44.0, y: 150.0 },

  // -- Payment footer -----------------------------------------------------
  payHead: {
    face: "bi" as Face,
    size: 14,
    cx: 287.1,
    y: 109.0,
    text: "Details for Payment:",
    ulDrop: 2.5,
    ulThick: 0.9,
  },
  payLines: { face: "ital" as Face, size: 14, cx: 287.1, ys: [83.2, 70.3, 57.4], lead: 12.9 },
  /*
    Payment terms, and the footer beneath them.

    Both wrap now. The terms line had **no width constraint at all**: a
    sentence of any length was drawn centred and ran off both edges of the
    page, losing its first and last words with no warning. It is the only
    field on the invoice a customer might have to act on, so losing the end of
    it is the worst possible thing to lose silently.
  */
  terms: {
    face: "ital" as Face,
    size: 9.5,
    cx: 287.1,
    /*
      Raised from 38 to 46 so a second wrapped line lands at 36 rather than
      27.5, which is where the footer's ascenders begin. The single-line case
      moves 8pt up the page and nothing else shifts.
    */
    y: 46.0,
    lead: 10.0,
    maxW: 470,
    maxLines: 2,
  },
  footer: {
    face: "ital" as Face,
    size: 8.5,
    cx: 297.75,
    y: 22.0,
    lead: 9.5,
    maxW: 500,
    maxLines: 2,
  },

  // -- Stamps -------------------------------------------------------------
  draftStamp: { face: "bi" as Face, size: 46, cx: 297.75, y: 300.0, text: "DRAFT" },
  voidStamp: { face: "bi" as Face, size: 46, cx: 297.75, y: 300.0, text: "VOID" },
} as const;

/** Pence as "£1,234.56". The only money formatter this layout uses. */
export function poundsFromPence(pence: number): string {
  const negative = pence < 0;
  const abs = Math.abs(pence);
  const whole = Math.floor(abs / 100).toLocaleString("en-GB");
  const part = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}£${whole}.${part}`;
}

// ---------------------------------------------------------------------------
// The painting
// ---------------------------------------------------------------------------

/**
 * Draws one invoice onto any painter, and reports what would not fit.
 *
 * `data` may be almost entirely empty — that produces the blank template,
 * which is what the settings screen previews so somebody can see the effect
 * of a configuration change without raising an invoice to look at it.
 */
export function paintInvoice(input: InvoiceRenderInput, p: Painter): string[] {
  const { data, identity, terms, vat } = input;
  const warn: string[] = [];

  // -- Masthead -----------------------------------------------------------
  p.textCentre(L.invoiceWord.face, L.invoiceWord.size, L.invoiceWord.cx, L.invoiceWord.y, L.invoiceWord.text);

  /*
    One centred line that must fit, drawn at whatever size fits — and
    **reported when no size does**. Every masthead field goes through this,
    so a configured value too long for its row produces a warning rather than
    text over the line above it.
  */
  const centredOrWarn = (
    spec: { face: Face; size: number; cx: number },
    y: number,
    text: string,
    maxW: number,
    floor: number,
    label: string,
  ) => {
    const { size, overflows } = fitOrOverflow(spec.face, text, spec.size, maxW, floor);
    if (overflows) {
      warn.push(`The ${label} is too long for the page, even at the smallest size it is drawn at. Shorten it.`);
    }
    p.textCentre(spec.face, size, spec.cx, y, text);
  };

  if (identity.displayName) {
    centredOrWarn(L.company, L.company.y, identity.displayName, 480, 18, "trading name");
  }
  if (identity.tagline) {
    centredOrWarn(L.tagline, L.tagline.y, identity.tagline, 505, 7, "tagline");
  }
  if (identity.qualifications) {
    centredOrWarn(L.quals, L.quals.y, identity.qualifications, 500, 7, "qualifications line");
  }
  identity.serviceLines.slice(0, L.services.ys.length).forEach((line, i) => {
    centredOrWarn(L.services, L.services.ys[i]!, line, 505, 7, `services line ${i + 1}`);
  });

  if (identity.serviceLines.length > L.services.ys.length) {
    warn.push(
      `There are ${identity.serviceLines.length} services lines and the layout has room for ${L.services.ys.length}. The rest are not printed.`,
    );
  }

  /*
    The contact row, laid out as two halves that must not meet.

    Each side is fitted to its own half; then the drawn widths are compared
    against the gap between them. A telephone number and an email address that
    together span the page used to print straight over one another.
  */
  {
    const phoneText = identity.phone ? `Telephone: ${identity.phone}` : "";
    const emailText = identity.email ?? "";

    const phoneFit = fitOrOverflow(L.phone.face, phoneText, L.phone.size, L.phone.maxW, 7);
    const emailFit = fitOrOverflow(L.email.face, emailText, L.email.size, L.email.maxW, 7);

    if (phoneText) p.text(L.phone.face, phoneFit.size, L.phone.x, L.phone.y, phoneText);
    if (emailText) p.textRight(L.email.face, emailFit.size, L.email.rx, L.email.y, emailText);

    /*
      Two independent guards, not a chain.

      The first is what a person has to act on: a value so long that shrinking
      it to the floor still does not fit its half of the row, so it is printed
      too small to read *and* over the rule.

      The second is the invariant itself — that the two halves never meet. The
      widths above make that impossible today, which is the point: the caps
      are the fix and this is the check that the fix is still in force. If
      either `maxW` is ever widened without thinking about the other, this is
      what says so instead of the two lines quietly printing over each other,
      which is exactly what they did before.
    */
    if (phoneFit.overflows || emailFit.overflows) {
      warn.push(
        "The telephone number or the email address is too long for its half of the contact line. Shorten it.",
      );
    }

    if (phoneText && emailText) {
      const phoneEnd = L.phone.x + textWidth(L.phone.face, phoneText, phoneFit.size);
      const emailStart = L.email.rx - textWidth(L.email.face, emailText, emailFit.size);
      if (emailStart - phoneEnd < L.contactRow.gap) {
        warn.push(
          "The telephone number and the email address are too long to sit on the same line without touching. Shorten one of them.",
        );
      }
    }
  }

  // -- Date, number, due --------------------------------------------------
  p.text(L.dateLabel.face, L.dateLabel.size, L.dateLabel.x, L.dateLabel.y, L.dateLabel.text);
  if (data.date) {
    p.textRight(L.dateValue.face, L.dateValue.size, L.dateValue.rx, L.dateValue.y, data.date);
  }
  p.text(L.invLabel.face, L.invLabel.size, L.invLabel.x, L.invLabel.y, L.invLabel.text);
  if (data.number) {
    p.textRight(L.invValue.face, L.invValue.size, L.invValue.rx, L.invValue.y, data.number);
  }
  if (data.dueDate) {
    p.textRight(L.dueLabel.face, L.dueLabel.size, L.dueLabel.rx, L.dueLabel.y, `Due: ${data.dueDate}`);
  }

  // -- Payer --------------------------------------------------------------
  {
    const C = L.custName;
    const line = `Customer Name:${data.payerName ? ` ${data.payerName}` : ""}`;
    const { size, overflows } = fitOrOverflow(C.face, line, C.size, C.maxW, 8);
    if (overflows) {
      warn.push(
        "The payer's name is too long to fit above the table. Shorten it, or use the company name on its own.",
      );
    }
    p.text(C.face, size, C.x, C.y, line);
  }
  {
    const A = L.address;
    const src = data.billingAddressLines.length > 0 ? data.billingAddressLines : [""];
    let lines: string[] = [];
    src.forEach((raw, i) => {
      const withLabel = (i === 0 ? `Address:${raw ? " " : ""}` : "") + raw;
      lines = lines.concat(wrapText(A.face, withLabel, A.size, A.maxW));
    });
    if (lines.length > A.maxLines) {
      /*
        What is dropped is named, not just counted. The lines that do not fit
        are the *last* ones — which in a UK address is the town and the
        postcode, the two a payment most needs. Saying "shorten it" without
        saying what vanished is how somebody shortens the wrong line.
      */
      const dropped = lines.slice(A.maxLines);
      warn.push(
        `The billing address is ${lines.length} lines and only ${A.maxLines} fit above the table. Not printed: ${dropped.join(" / ")}. Shorten it.`,
      );
      lines = lines.slice(0, A.maxLines);
    }
    lines.forEach((ln, i) => p.text(A.face, A.size, A.x, A.y - i * A.lead, ln));
  }

  // -- Table frame --------------------------------------------------------
  const T = L.tbl;
  T.rules.forEach((y) => p.rect(T.x0, y, T.ruleW, T.t));
  T.bands.forEach((b) => b.xs.forEach((x) => p.rect(x, b.y, T.t, b.h)));

  p.textCentre(L.head.face, L.head.size, L.colDesc.cx, L.head.yDesc, "Description");
  p.textCentre(L.head.face, L.head.size, L.colPrice.cx, L.head.yPrice, "Price");

  // -- Property line ------------------------------------------------------
  let y: number = L.desc.yFirst;
  if (data.propertyLine) {
    const P = L.property;
    const { size, overflows } = fitOrOverflow(P.face, data.propertyLine, P.size, L.colDesc.maxW, 7);
    if (overflows) {
      warn.push(
        "The service address is too long for the description column and would run over the table rule.",
      );
    }
    p.textCentreUnderlined(P.face, size, L.colDesc.cx, P.y, data.propertyLine, P.ulDrop, P.ulThick);
    y = L.desc.yAfterProperty; // the blank line the originals leave
  }

  // -- Lines --------------------------------------------------------------
  /*
    Measured before anything is drawn.

    A line that will not fit must be reported, not printed over the payment
    footer. The original truncated and warned; this refuses to start an item
    it cannot finish, so the page never shows half a charge.
  */
  const D = L.desc;
  let drawn = 0;
  for (const [index, line] of data.lines.entries()) {
    const paragraphs = line.description.replace(/\r/g, "").split("\n");
    const out: string[] = [];
    for (const para of paragraphs) {
      if (!para.trim()) out.push("");
      else for (const l of wrapText(D.face, para.trim(), D.size, L.colDesc.maxW)) out.push(l);
    }
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    if (out.length === 0) out.push("");

    // "2 × £45.00" beneath the description, and only when there is more than
    // one of something. The original layout has no quantity column and this
    // does not invent one.
    const showsQuantity = line.quantity !== 1;
    const quantityLine = showsQuantity
      ? `${line.quantity} × ${poundsFromPence(line.unitPricePence)}`
      : null;

    const needed = (out.length + (quantityLine ? 1 : 0)) * D.lead;
    if (y - needed < D.yFloor) {
      warn.push(
        `Line ${index + 1} does not fit in the table. Shorten the descriptions, or raise a second invoice.`,
      );
      break;
    }

    out.forEach((ln, i) => {
      if (ln) p.textCentre(D.face, D.size, L.colDesc.cx, y - i * D.lead, ln);
    });

    if (quantityLine) {
      p.textCentre(L.qty.face, L.qty.size, L.colDesc.cx, y - out.length * D.lead, quantityLine);
    }

    const amount = poundsFromPence(line.totalPence);
    const amountFit = fitOrOverflow(L.price.face, amount, L.price.size, L.colPrice.maxW, 7);
    if (amountFit.overflows) {
      warn.push(`The amount on line ${index + 1} is too wide for the price column.`);
    }
    p.textCentre(L.price.face, amountFit.size, L.colPrice.cx, y - L.price.dropFromDesc, amount);

    drawn += 1;
    y -= needed + D.itemGap;
  }

  /*
    If any line was left out, say so **against the total**.

    The total below is the total of everything, including what did not fit, so
    a page that stops short shows a figure its own lines do not add up to.
    That is the single most dangerous thing this layout can produce, so it is
    stated in its own right rather than left to be inferred from the warning
    about the line that would not fit.
  */
  if (drawn < data.lines.length) {
    warn.push(
      `Only ${drawn} of ${data.lines.length} lines are printed, so the total shown does not add up to the lines above it. This invoice cannot be issued as it stands.`,
    );
  }

  // -- Totals -------------------------------------------------------------
  p.textCentre(L.totalRow.face, L.totalRow.size, L.colTotalLabel.cx, L.totalRow.y, L.totalRow.text);

  const total = poundsFromPence(data.totalPence);
  const totalFit = fitOrOverflow(L.totalVal.face, total, L.totalVal.size, L.colPrice.maxW, 7);
  if (totalFit.overflows) {
    warn.push("The total is too wide for the price column.");
  }
  p.textCentre(L.totalVal.face, totalFit.size, L.colPrice.cx, L.totalVal.y, total);

  /*
    VAT is drawn **only** when registration is on.

    BSCJ is not registered. Printing "VAT £0.00" would be a statement about
    tax status, and it is not one this code is entitled to make — so the
    rows, the number and the word itself are absent entirely rather than
    present and zero.
  */
  if (vat.registered && vat.number) {
    const V = L.vatRows;
    p.textCentre(V.face, V.size, V.labelCx, V.ySubtotal, "Subtotal (£):");
    p.textCentre(L.totalVal.face, V.size, L.colPrice.cx, V.ySubtotal, poundsFromPence(data.subtotalPence));
    p.textCentre(V.face, V.size, V.labelCx, V.yVat, "VAT (£):");
    p.textCentre(L.totalVal.face, V.size, L.colPrice.cx, V.yVat, poundsFromPence(data.vatPence));
    p.text(L.vatNumber.face, L.vatNumber.size, L.vatNumber.x, L.vatNumber.y, `VAT registration: ${vat.number}`);
  }

  // -- Payment ------------------------------------------------------------
  if (terms.paymentInstructions) {
    const H = L.payHead;
    p.textCentreUnderlined(H.face, H.size, H.cx, H.y, H.text, H.ulDrop, H.ulThick);

    const instructionLines = terms.paymentInstructions
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (instructionLines.length > L.payLines.ys.length) {
      // Named, not counted: an account number that is not printed is the
      // reason the invoice does not get paid.
      const dropped = instructionLines.slice(L.payLines.ys.length);
      warn.push(
        `Payment details are ${instructionLines.length} lines and only ${L.payLines.ys.length} fit in the footer. Not printed: ${dropped.join(" / ")}.`,
      );
    }

    instructionLines.slice(0, L.payLines.ys.length).forEach((ln, i) => {
      const { size, overflows } = fitOrOverflow(L.payLines.face, ln, L.payLines.size, 480, 8);
      if (overflows) {
        warn.push(`This payment detail is too wide for the footer: "${ln}".`);
      }
      p.textCentre(L.payLines.face, size, L.payLines.cx, L.payLines.ys[i]!, ln);
    });
  }

  /*
    The payment terms.

    Wrapped to the page, and reported when they still do not fit. Before this
    they were drawn centred with no constraint at all, so a sentence of any
    length ran off **both** edges and lost its first and last words — on the
    one field a customer may actually have to act on.
  */
  if (terms.paymentTerms) {
    const T = L.terms;
    const lines = wrapText(T.face, terms.paymentTerms, T.size, T.maxW);
    if (lines.length > T.maxLines) {
      const dropped = lines.slice(T.maxLines);
      warn.push(
        `The payment terms need ${lines.length} lines and ${T.maxLines} fit at the foot of the page. Not printed: ${dropped.join(" ")}. Shorten them.`,
      );
    }
    lines
      .slice(0, T.maxLines)
      .forEach((ln, i) => p.textCentre(T.face, T.size, T.cx, T.y - i * T.lead, ln));
  }

  if (identity.footerText) {
    const F = L.footer;
    const lines = wrapText(F.face, identity.footerText, F.size, F.maxW);
    if (lines.length > F.maxLines) {
      const dropped = lines.slice(F.maxLines);
      warn.push(
        `The footer wording needs ${lines.length} lines and ${F.maxLines} fit at the bottom of the page. Not printed: ${dropped.join(" ")}. Shorten it.`,
      );
    }
    lines
      .slice(0, F.maxLines)
      .forEach((ln, i) => p.textCentre(F.face, F.size, F.cx, F.y - i * F.lead, ln));
  }

  // -- Stamps -------------------------------------------------------------
  if (data.draft) {
    const S = L.draftStamp;
    p.textCentre(S.face, S.size, S.cx, S.y, S.text);
  }
  if (data.voided) {
    const S = L.voidStamp;
    p.textCentre(S.face, S.size, S.cx, S.y, S.text);
  }

  return warn;
}

/** Whether a string fits the description column at its normal size. */
export function descriptionFits(text: string): boolean {
  return textWidth(L.desc.face, text, L.desc.size) <= L.colDesc.maxW;
}
