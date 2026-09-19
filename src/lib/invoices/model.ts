/**
 * What an invoice is, and the arithmetic on it.
 *
 * Pure and dependency-free, so every rule below is testable without a
 * database, a session or a request — and so there is exactly one place that
 * decides what a line total is.
 *
 * **Money is integer pence, everywhere.** Not pounds, not a float, not a
 * decimal string. `0.1 + 0.2` is the reason: an invoice that is a penny out
 * from the sum of its own lines is one somebody has to reconcile by hand.
 * Pounds exist only at the edges — what an administrator types, and what is
 * printed — and both conversions live here.
 *
 * **Nothing here is ever taken from the browser.** The form posts a
 * description, a quantity and a unit price; it does not post a line total, an
 * invoice total or a status, and this module recomputes all three. A client
 * that can name its own total can name zero.
 */

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export const INVOICE_STATUSES = [
  "draft",
  "issued",
  "sent",
  "paid",
  "void",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return (
    typeof value === "string" &&
    (INVOICE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Statuses that hold a real, numbered invoice.
 *
 * The one predicate that decides whether a row is frozen. Everything that
 * refuses to edit, and everything that lets an agency see a document, asks
 * this rather than listing statuses of its own — a list repeated in four
 * places is a list that will disagree with itself.
 */
export function isIssued(status: InvoiceStatus): boolean {
  return status === "issued" || status === "sent" || status === "paid";
}

/** Whether the row may still be edited. Only a draft may. */
export function isEditable(status: InvoiceStatus): boolean {
  return status === "draft";
}

/** Whether this row occupies the "one live invoice per job" slot. */
export function isActive(status: InvoiceStatus): boolean {
  return status !== "void";
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** The largest single charge the form will accept: £100,000. */
export const MAX_LINE_PENCE = 10_000_000;
export const MAX_QUANTITY = 999;
export const MAX_DESCRIPTION = 400;
export const MAX_LINES = 12;

export type PenceResult =
  | { ok: true; pence: number }
  | { ok: false; error: string };

/**
 * Pounds as typed, to pence.
 *
 * Accepts "45", "45.00", "£45.00", "1,234.56" and a leading minus, because
 * all of those are what people actually type. Refuses anything that is not
 * exactly two decimal places or fewer — "45.005" is not an amount of money,
 * and rounding it silently decides something the typist did not.
 */
export function poundsToPence(value: string): PenceResult {
  /*
    A currency symbol and thousands separators are stripped; **spaces inside
    the number are not**. "1 234.56" is refused rather than read as 1234.56,
    because the same leniency would silently turn a mistyped "4 5" into £45 —
    and an amount of money quietly meaning something other than what was typed
    is the one failure this function exists to prevent. Retyping it is cheap.
  */
  const cleaned = value.trim().replace(/[£,]/g, "");
  if (cleaned === "") return { ok: false, error: "Enter an amount." };

  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    return {
      ok: false,
      error: "Enter an amount in pounds and pence, such as 45.00.",
    };
  }

  const negative = cleaned.startsWith("-");
  const body = negative ? cleaned.slice(1) : cleaned;
  const [whole, fraction = ""] = body.split(".");
  const pence =
    Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));

  if (!Number.isSafeInteger(pence)) {
    return { ok: false, error: "That amount is too large." };
  }
  if (Math.abs(pence) > MAX_LINE_PENCE) {
    return { ok: false, error: "That amount is larger than this form accepts." };
  }

  return { ok: true, pence: negative ? -pence : pence };
}

/** Pence as a plain "45.00", for putting back into a form field. */
export function penceToPounds(pence: number): string {
  const negative = pence < 0;
  const abs = Math.abs(pence);
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Pence as "£1,234.56", for reading. */
export function formatPence(pence: number): string {
  const negative = pence < 0;
  const abs = Math.abs(pence);
  const whole = Math.floor(abs / 100).toLocaleString("en-GB");
  return `${negative ? "-" : ""}£${whole}.${String(abs % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** A line as it arrives from a form: three fields, all strings. */
export type LineInput = {
  description: unknown;
  quantity: unknown;
  unitPrice: unknown;
  /** The job this line is for, or null for an adjustment. */
  jobId?: string | null;
};

/** A line the server has validated and priced. */
export type ValidatedLine = {
  description: string;
  quantity: number;
  unitPricePence: number;
  /** Always `quantity × unitPricePence`. Never what the form said. */
  totalPence: number;
  jobId: string | null;
  sortOrder: number;
};

export type LineErrors = Record<string, string>;

export type LinesResult =
  | { ok: true; lines: ValidatedLine[] }
  | { ok: false; errors: LineErrors };

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validates and prices every line at once.
 *
 * All the errors, not the first one: an administrator correcting a four-line
 * invoice should not discover the third fault on the third attempt. Errors are
 * keyed `line-<index>-<field>` so the form can put each one beside its input.
 */
export function validateLines(inputs: readonly LineInput[]): LinesResult {
  const errors: LineErrors = {};
  const lines: ValidatedLine[] = [];

  if (inputs.length === 0) {
    return { ok: false, errors: { lines: "An invoice needs at least one line." } };
  }
  if (inputs.length > MAX_LINES) {
    return {
      ok: false,
      errors: {
        lines: `An invoice takes at most ${MAX_LINES} lines. Raise a second invoice.`,
      },
    };
  }

  inputs.forEach((input, index) => {
    const description = asString(input.description);
    if (description === "") {
      errors[`line-${index}-description`] = "Describe what is being charged.";
    } else if (description.length > MAX_DESCRIPTION) {
      errors[`line-${index}-description`] =
        `Keep the description under ${MAX_DESCRIPTION} characters.`;
    }

    const quantityRaw = asString(input.quantity);
    const quantity = Number(quantityRaw);
    const quantityOk =
      /^\d+$/.test(quantityRaw) && Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_QUANTITY;
    if (!quantityOk) {
      errors[`line-${index}-quantity`] = `A whole number between 1 and ${MAX_QUANTITY}.`;
    }

    const price = poundsToPence(asString(input.unitPrice));
    if (!price.ok) {
      errors[`line-${index}-unitPrice`] = price.error;
    }

    if (description !== "" && quantityOk && price.ok) {
      const totalPence = quantity * price.pence;
      if (Math.abs(totalPence) > MAX_LINE_PENCE) {
        errors[`line-${index}-unitPrice`] =
          "That quantity and price come to more than this form accepts.";
        return;
      }
      lines.push({
        description,
        quantity,
        unitPricePence: price.pence,
        totalPence,
        jobId: input.jobId ?? null,
        sortOrder: index,
      });
    }
  });

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, lines };
}

/** The subtotal: the sum of the line totals, and nothing else. */
export function subtotalOf(lines: readonly { totalPence: number }[]): number {
  return lines.reduce((sum, line) => sum + line.totalPence, 0);
}

// ---------------------------------------------------------------------------
// Adjustment against the quote
// ---------------------------------------------------------------------------

export type QuoteComparison = {
  quotedPence: number;
  invoicedPence: number;
  differencePence: number;
  /** True when the invoice does not match what the job was quoted. */
  adjusted: boolean;
};

/**
 * How this invoice differs from what the job was quoted.
 *
 * Shown on the screen and recorded in the audit event, so an adjustment is a
 * visible decision rather than something discovered later by comparing two
 * numbers nobody put side by side. **The job's own price is never changed** —
 * `job.price_total_pence` and `job.price_snapshot` are what was agreed when
 * the work was taken, and an invoice is a separate document about it.
 */
export function compareWithQuote(
  quotedPence: number | null,
  invoicedPence: number,
): QuoteComparison | null {
  if (quotedPence === null) return null;
  return {
    quotedPence,
    invoicedPence,
    differencePence: invoicedPence - quotedPence,
    adjusted: invoicedPence !== quotedPence,
  };
}

// ---------------------------------------------------------------------------
// Billing address
// ---------------------------------------------------------------------------

export type BillingAddress = {
  lines: string[];
  postcode: string | null;
};

export const EMPTY_BILLING_ADDRESS: BillingAddress = { lines: [], postcode: null };

/**
 * Parses a stored billing address.
 *
 * Returns empty rather than throwing, and **never substitutes the property
 * address**. An invoice addressed to the flat that was inspected, rather than
 * to the agency that pays for it, is wrong in a way that looks right.
 */
export function parseBillingAddress(
  lines: unknown,
  postcode: unknown,
): BillingAddress {
  const parsed = Array.isArray(lines)
    ? lines.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.trim())
    : [];
  return {
    lines: parsed,
    postcode:
      typeof postcode === "string" && postcode.trim() !== ""
        ? postcode.trim().toUpperCase()
        : null,
  };
}

export function hasBillingAddress(address: BillingAddress): boolean {
  return address.lines.length > 0 && address.postcode !== null;
}

/** The address as it prints: the lines, then the postcode on its own line. */
export function billingAddressLines(address: BillingAddress): string[] {
  return address.postcode ? [...address.lines, address.postcode] : [...address.lines];
}

export type AddressResult =
  | { ok: true; address: BillingAddress }
  | { ok: false; errors: LineErrors };

/** Validates a typed billing address. Four lines, because the layout fits four. */
export function validateBillingAddress(
  linesRaw: unknown,
  postcodeRaw: unknown,
): AddressResult {
  const errors: LineErrors = {};

  const lines =
    typeof linesRaw === "string"
      ? linesRaw
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "")
      : [];

  if (lines.length === 0) {
    errors.billingAddress = "Enter the billing address. It is not the property address.";
  } else if (lines.length > 3) {
    errors.billingAddress = "Three lines at most, plus the postcode.";
  } else if (lines.some((l) => l.length > 60)) {
    errors.billingAddress = "Keep each line under 60 characters.";
  }

  const postcode = asString(postcodeRaw).toUpperCase();
  if (postcode === "") {
    errors.billingPostcode = "Enter the billing postcode.";
  } else if (postcode.length > 10) {
    errors.billingPostcode = "That is not a postcode.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, address: { lines, postcode } };
}

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

/** Why an invoice may not be issued. Empty means it may. */
export type IssueBlocker = {
  code:
    | "not_a_draft"
    | "no_lines"
    | "not_positive"
    | "no_billing_address"
    | "configuration"
    | "no_storage";
  message: string;
  /** For `configuration`: the settings fields still empty. */
  fields?: string[];
};

export type IssueCheckInput = {
  status: InvoiceStatus;
  lineCount: number;
  totalPence: number;
  billingAddress: BillingAddress;
  missingSettings: readonly string[];
  storageReady: boolean;
};

/**
 * Everything that has to be true before a number is drawn.
 *
 * Returned as a list so the screen can show all of it at once — an
 * administrator chasing one blocker at a time through five attempts is how a
 * gate becomes something people work around.
 *
 * **Drafts are never blocked by this.** Missing business configuration stops
 * *issuing*, not drafting: the work of preparing an invoice can happen while
 * somebody chases the bank details, and blocking the draft too would make the
 * whole feature untestable until every real-world fact exists.
 */
export function issueBlockers(input: IssueCheckInput): IssueBlocker[] {
  const blockers: IssueBlocker[] = [];

  if (!isEditable(input.status)) {
    blockers.push({
      code: "not_a_draft",
      message: "This invoice has already been issued.",
    });
  }
  if (input.lineCount === 0) {
    blockers.push({ code: "no_lines", message: "An invoice needs at least one line." });
  }
  if (input.totalPence <= 0) {
    blockers.push({
      code: "not_positive",
      message: "An invoice has to come to more than nothing.",
    });
  }
  if (!hasBillingAddress(input.billingAddress)) {
    blockers.push({
      code: "no_billing_address",
      message:
        "There is no billing address for the payer. Enter one — the property address is not a substitute.",
    });
  }
  if (input.missingSettings.length > 0) {
    blockers.push({
      code: "configuration",
      message:
        "The business details an invoice has to carry are not configured yet.",
      fields: [...input.missingSettings],
    });
  }
  if (!input.storageReady) {
    blockers.push({
      code: "no_storage",
      message:
        "No document store is configured, so the PDF could not be kept. Nothing has been issued.",
    });
  }

  return blockers;
}

export function canIssue(input: IssueCheckInput): boolean {
  return issueBlockers(input).length === 0;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** "19/09/2026", which is how the existing invoices print a date. */
export function formatInvoiceDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

/**
 * The due date, from the issue date and the configured terms.
 *
 * Returns null when no term is configured. **Nothing is guessed** — "30 days"
 * is a commercial decision BSCJ has not recorded, and printing a due date
 * nobody agreed to is inventing an accounting fact.
 */
export function dueDateFrom(issuedOn: string, paymentDueDays: number | null): string | null {
  if (paymentDueDays === null) return null;
  const date = new Date(`${issuedOn}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + paymentDueDays);
  return date.toISOString().slice(0, 10);
}
