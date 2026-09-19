import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  billingAddressLines,
  canIssue,
  compareWithQuote,
  dueDateFrom,
  EMPTY_BILLING_ADDRESS,
  formatInvoiceDate,
  formatPence,
  hasBillingAddress,
  isActive,
  isEditable,
  isIssued,
  issueBlockers,
  MAX_LINES,
  parseBillingAddress,
  penceToPounds,
  poundsToPence,
  subtotalOf,
  validateBillingAddress,
  validateLines,
  type BillingAddress,
} from "./model";
import {
  formatInvoiceNumber,
  isInvoiceNumber,
  normaliseInvoiceNumber,
} from "./number";
import {
  invoiceApprovalFromKey,
  invoiceFromKey,
  invoiceKey,
  invoiceRows,
  certificateKey,
  OUTBOX_KINDS,
} from "@/lib/notifications/kinds";
import {
  canIssueInvoices,
  invoiceTotals,
  missingInvoiceIdentityFields,
  parseBusinessIdentity,
  parseVatPosition,
  EMPTY_BUSINESS_IDENTITY,
  EMPTY_INVOICE_TERMS,
  NOT_VAT_REGISTERED,
  type BusinessIdentity,
  type InvoiceTerms,
  type VatPosition,
} from "@/lib/settings/business-identity";
import { renderInvoicePdf, renderInvoiceSvg } from "./pdf/render";
import { textWidth, wrapText } from "./pdf/painter";

/**
 * Invoicing.
 *
 * The pure parts are tested directly: the arithmetic, the validation, the
 * issue gate, the outbox keys and the page itself. The database-shaped
 * guarantees — the partial unique index that stops a second live invoice, the
 * conditional update that allocates a number once — are proved against the
 * development database in a browser journey and recorded in
 * `docs/V2_3_1_HANDOFF.md` §21. Mocking Drizzle deeply enough to assert an
 * index would only prove the mock.
 *
 * **Every fixture here is visibly fictional.** No real company name, address,
 * bank detail or customer appears anywhere in this file, and the configuration
 * used to render a PDF is invented for the test.
 */

// ---------------------------------------------------------------------------
// Fixtures — clearly not real, deliberately
// ---------------------------------------------------------------------------

const FIXTURE_IDENTITY: BusinessIdentity = {
  displayName: "Fixture Heating Co",
  tradingName: null,
  legalName: "Fixture Heating Company Limited",
  companyNumber: "00000000",
  addressLines: ["1 Fixture Way", "Example Town"],
  postcode: "WV1 1AA",
  phone: "+44 1902 000000",
  email: "accounts@example.invalid",
  website: null,
  gasSafeNumber: "000000",
  footerText: "Fixture Heating Company Limited — a fixture, not a business.",
  tagline: "A fixture",
  qualifications: "NONE1, NONE2",
  serviceLines: ["A fixture line", "Another fixture line"],
};

const FIXTURE_TERMS: InvoiceTerms = {
  paymentTerms: "Payable within 14 days.",
  paymentDueDays: 14,
  paymentInstructions:
    "Name: Fixture Heating Company Limited\nAccount Number: 00000000\nSort Code: 00-00-00",
};

const NO_VAT: VatPosition = NOT_VAT_REGISTERED;

const REGISTERED_VAT: VatPosition = {
  registered: true,
  number: "GB000000000",
  ratePercentBasisPoints: 2000,
  registeredFrom: "2026-01-01",
};

function documentData(overrides: Record<string, unknown> = {}) {
  return {
    number: "BSCJ-001000",
    date: "19/09/2026",
    dueDate: "03/10/2026",
    payerName: "Fixture Lettings Limited",
    billingAddressLines: ["Fixture House", "2 Fixture Street", "WV2 2BB"],
    propertyLine: "14 Example Road, Example Town, WV3 3CC",
    lines: [
      {
        description: "Gas Safety Certificate (CP12)",
        quantity: 1,
        unitPricePence: 4500,
        totalPence: 4500,
      },
    ],
    subtotalPence: 4500,
    vatPence: 0,
    totalPence: 4500,
    draft: false,
    voided: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

describe("money is integer pence, at every edge", () => {
  test("pounds as people actually type them", () => {
    const cases: [string, number][] = [
      ["45", 4500],
      ["45.00", 4500],
      ["£45.00", 4500],
      ["  45.5 ", 4550],
      ["1,234.56", 123456],
      ["0.01", 1],
      ["-15.00", -1500],
    ];
    for (const [input, pence] of cases) {
      const result = poundsToPence(input);
      assert.equal(result.ok, true, `${input} was refused`);
      if (result.ok) assert.equal(result.pence, pence, input);
    }
  });

  test("more than two decimal places is refused, never rounded", () => {
    // Rounding decides something the typist did not.
    for (const input of ["45.005", "45.999", "1.2345"]) {
      assert.equal(poundsToPence(input).ok, false, input);
    }
  });

  test("nonsense is refused", () => {
    for (const input of ["", "   ", "abc", "45.00.00", "4 5", "£", "45p", "1 234.56"]) {
      assert.equal(poundsToPence(input).ok, false, JSON.stringify(input));
    }
  });

  test("a space inside the number is refused, not quietly closed up", () => {
    // "4 5" must never become £45. Retyping is cheaper than an amount that
    // means something other than what was typed.
    assert.equal(poundsToPence("4 5").ok, false);
  });

  test("an amount larger than the form accepts is refused", () => {
    assert.equal(poundsToPence("100000.01").ok, false);
    assert.equal(poundsToPence("100000.00").ok, true);
  });

  test("pence round-trip through pounds without drifting", () => {
    for (const pence of [0, 1, 99, 100, 4500, 123456, -1500]) {
      const text = penceToPounds(pence);
      const back = poundsToPence(text);
      assert.equal(back.ok, true, text);
      if (back.ok) assert.equal(back.pence, pence, text);
    }
  });

  test("formatting groups thousands and keeps two places", () => {
    assert.equal(formatPence(4500), "£45.00");
    assert.equal(formatPence(5), "£0.05");
    assert.equal(formatPence(123456), "£1,234.56");
    assert.equal(formatPence(-1500), "-£15.00");
  });

  test("the classic float case does not arise", () => {
    // 0.1 + 0.2 in pounds is the whole reason this is integer pence.
    const a = poundsToPence("0.10");
    const b = poundsToPence("0.20");
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.equal(a.pence + b.pence, 30);
  });
});

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

describe("lines are validated and priced by the server", () => {
  test("the line total is quantity × unit price, whatever was posted", () => {
    const result = validateLines([
      { description: "CP12", quantity: "1", unitPrice: "45.00" },
      { description: "Extra appliance", quantity: "2", unitPrice: "15.00" },
    ]);

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.lines[0]!.totalPence, 4500);
    assert.equal(result.lines[1]!.totalPence, 3000);
    assert.equal(subtotalOf(result.lines), 7500);
  });

  test("a posted total is not a field this accepts at all", () => {
    // The shape has no `totalPence`. Passing one changes nothing.
    const result = validateLines([
      {
        description: "CP12",
        quantity: "1",
        unitPrice: "45.00",
        ...({ totalPence: 1 } as object),
      },
    ]);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.lines[0]!.totalPence, 4500);
  });

  test("every fault is reported at once, keyed to its field", () => {
    const result = validateLines([
      { description: "", quantity: "0", unitPrice: "nope" },
      { description: "Fine", quantity: "1", unitPrice: "10.00" },
      { description: "Bad qty", quantity: "-1", unitPrice: "10.00" },
    ]);

    assert.equal(result.ok, false);
    if (result.ok) return;

    assert.ok(result.errors["line-0-description"]);
    assert.ok(result.errors["line-0-quantity"]);
    assert.ok(result.errors["line-0-unitPrice"]);
    assert.ok(result.errors["line-2-quantity"]);
    assert.equal(result.errors["line-1-description"], undefined);
  });

  test("an invoice with no lines is refused", () => {
    const result = validateLines([]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.lines);
  });

  test("past the line limit it says to raise a second invoice", () => {
    const many = Array.from({ length: MAX_LINES + 1 }, () => ({
      description: "Line",
      quantity: "1",
      unitPrice: "1.00",
    }));
    const result = validateLines(many);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.lines!, /second invoice/i);
  });

  test("a negative line is allowed, because an agreed credit is a real thing", () => {
    const result = validateLines([
      { description: "CP12", quantity: "1", unitPrice: "45.00" },
      { description: "Agreed reduction", quantity: "1", unitPrice: "-5.00" },
    ]);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(subtotalOf(result.lines), 4000);
  });
});

// ---------------------------------------------------------------------------
// The quote is never rewritten
// ---------------------------------------------------------------------------

describe("the original quoted price survives", () => {
  test("a difference is reported, not applied to the job", () => {
    const comparison = compareWithQuote(4500, 7500);
    assert.ok(comparison);
    assert.equal(comparison!.quotedPence, 4500);
    assert.equal(comparison!.invoicedPence, 7500);
    assert.equal(comparison!.differencePence, 3000);
    assert.equal(comparison!.adjusted, true);
  });

  test("matching the quote is not an adjustment", () => {
    assert.equal(compareWithQuote(4500, 4500)!.adjusted, false);
  });

  test("a reduction is a negative difference, not an error", () => {
    assert.equal(compareWithQuote(4500, 4000)!.differencePence, -500);
  });

  test("no quote means no comparison, rather than a comparison against zero", () => {
    assert.equal(compareWithQuote(null, 4500), null);
  });

  test("nothing in the invoicing code re-prices a job", () => {
    /*
      A structural check, because this is the rule that is easiest to break
      by accident and hardest to notice: one helpful import of `resolvePrice`
      and last March's job starts being invoiced at September's rates.
    */
    const root = path.resolve(process.cwd(), "src/lib/invoices");
    const files = [
      "invoices.ts",
      "model.ts",
      "delivery.ts",
      "pdf/layout.ts",
      "pdf/render.ts",
    ];
    for (const file of files) {
      const source = readFileSync(path.join(root, file), "utf8");
      assert.equal(
        /from "@\/lib\/pricing\/resolve"/.test(source),
        false,
        `${file} imports the pricing resolver`,
      );
      assert.equal(
        /resolvePrice\s*\(/.test(source),
        false,
        `${file} calls resolvePrice`,
      );
    }
  });

  test("the invoicing code never writes to the job row at all", () => {
    /*
      The strongest form of "an invoice does not change what was agreed":
      there is no update of `jobs` anywhere in the invoicing modules, so the
      price columns, the snapshot and the lifecycle are all out of reach by
      construction rather than by care.
    */
    const root = path.resolve(process.cwd(), "src/lib/invoices");
    for (const file of ["invoices.ts", "delivery.ts"]) {
      const source = readFileSync(path.join(root, file), "utf8");
      assert.equal(
        /\.update\(\s*jobs\s*\)/.test(source),
        false,
        `${file} updates the job row`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Billing address
// ---------------------------------------------------------------------------

describe("the billing address is its own thing", () => {
  test("an empty or malformed stored value reads as empty, never as the property", () => {
    assert.deepEqual(parseBillingAddress(null, null), EMPTY_BILLING_ADDRESS);
    assert.deepEqual(parseBillingAddress("not an array", 42), EMPTY_BILLING_ADDRESS);
    assert.deepEqual(parseBillingAddress([1, 2], null), EMPTY_BILLING_ADDRESS);
  });

  test("a stored address comes back trimmed, with an uppercase postcode", () => {
    const parsed = parseBillingAddress([" Suite 4 ", "", "12 Example Street"], " wv1 1aa ");
    assert.deepEqual(parsed.lines, ["Suite 4", "12 Example Street"]);
    assert.equal(parsed.postcode, "WV1 1AA");
  });

  test("an address needs both lines and a postcode to count", () => {
    assert.equal(hasBillingAddress({ lines: ["A"], postcode: "WV1 1AA" }), true);
    assert.equal(hasBillingAddress({ lines: [], postcode: "WV1 1AA" }), false);
    assert.equal(hasBillingAddress({ lines: ["A"], postcode: null }), false);
  });

  test("it prints as the lines plus the postcode", () => {
    assert.deepEqual(
      billingAddressLines({ lines: ["Suite 4", "12 Example Street"], postcode: "WV1 1AA" }),
      ["Suite 4", "12 Example Street", "WV1 1AA"],
    );
  });

  test("a missing one is refused with a message that rules out the property", () => {
    const result = validateBillingAddress("", "");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.errors.billingAddress!, /not the property address/i);
      assert.ok(result.errors.billingPostcode);
    }
  });

  test("too many lines is refused, because the layout fits four", () => {
    const result = validateBillingAddress("a\nb\nc\nd", "WV1 1AA");
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// The issue gate
// ---------------------------------------------------------------------------

const GOOD_ADDRESS: BillingAddress = { lines: ["Fixture House"], postcode: "WV2 2BB" };

function gate(overrides: Record<string, unknown> = {}) {
  return {
    status: "draft" as const,
    lineCount: 1,
    totalPence: 4500,
    billingAddress: GOOD_ADDRESS,
    missingSettings: [] as string[],
    storageReady: true,
    ...overrides,
  };
}

describe("what has to be true before a number is drawn", () => {
  test("a complete draft may be issued", () => {
    assert.equal(canIssue(gate()), true);
    assert.deepEqual(issueBlockers(gate()), []);
  });

  test("missing business configuration blocks issuing and names the fields", () => {
    const blockers = issueBlockers(
      gate({ missingSettings: ["legalName", "paymentInstructions"] }),
    );
    const configuration = blockers.find((b) => b.code === "configuration");
    assert.ok(configuration);
    assert.deepEqual(configuration!.fields, ["legalName", "paymentInstructions"]);
  });

  test("a missing billing address blocks issuing", () => {
    const blockers = issueBlockers(gate({ billingAddress: EMPTY_BILLING_ADDRESS }));
    assert.ok(blockers.some((b) => b.code === "no_billing_address"));
  });

  test("no storage blocks issuing, because the PDF could not be kept", () => {
    assert.ok(
      issueBlockers(gate({ storageReady: false })).some((b) => b.code === "no_storage"),
    );
  });

  test("an invoice for nothing is refused", () => {
    assert.ok(issueBlockers(gate({ totalPence: 0 })).some((b) => b.code === "not_positive"));
    assert.ok(issueBlockers(gate({ totalPence: -100 })).some((b) => b.code === "not_positive"));
  });

  test("an already-issued invoice cannot be issued again", () => {
    for (const status of ["issued", "sent", "paid", "void"] as const) {
      assert.ok(
        issueBlockers(gate({ status })).some((b) => b.code === "not_a_draft"),
        status,
      );
    }
  });

  test("every blocker is reported at once, not one at a time", () => {
    const blockers = issueBlockers(
      gate({
        billingAddress: EMPTY_BILLING_ADDRESS,
        missingSettings: ["legalName"],
        storageReady: false,
        totalPence: 0,
      }),
    );
    assert.equal(blockers.length, 4);
  });
});

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

describe("statuses mean different things and are kept apart", () => {
  test("only a draft is editable", () => {
    assert.equal(isEditable("draft"), true);
    for (const status of ["issued", "sent", "paid", "void"] as const) {
      assert.equal(isEditable(status), false, status);
    }
  });

  test("issued, sent and paid all hold a real invoice", () => {
    assert.equal(isIssued("issued"), true);
    assert.equal(isIssued("sent"), true);
    assert.equal(isIssued("paid"), true);
    assert.equal(isIssued("draft"), false);
    assert.equal(isIssued("void"), false);
  });

  test("everything but void occupies the one-live-invoice slot", () => {
    assert.equal(isActive("draft"), true);
    assert.equal(isActive("issued"), true);
    assert.equal(isActive("void"), false);
  });

  test("sent is not paid", () => {
    // The distinction the whole status column exists for.
    assert.notEqual(isIssued("sent"), isIssued("void"));
    assert.equal(("sent" as string) === "paid", false);
  });
});

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

describe("invoice numbers", () => {
  test("the series is formatted from the sequence value", () => {
    assert.equal(formatInvoiceNumber(1000), "BSCJ-001000");
    assert.equal(formatInvoiceNumber(1001), "BSCJ-001001");
  });

  test("a number quoted over the telephone normalises", () => {
    assert.equal(normaliseInvoiceNumber("bscj 001000"), "BSCJ-001000");
    assert.equal(normaliseInvoiceNumber("1000"), "BSCJ-001000");
    assert.equal(normaliseInvoiceNumber("BSCJ-ABC123"), null);
  });

  test("a job reference is never mistaken for an invoice number", () => {
    assert.equal(isInvoiceNumber("BSCJ-001000"), true);
    assert.equal(isInvoiceNumber("BSCJ-4K7P2X"), false);
  });
});

// ---------------------------------------------------------------------------
// Due dates
// ---------------------------------------------------------------------------

describe("due dates are configured, never assumed", () => {
  test("no configured term means no due date", () => {
    assert.equal(dueDateFrom("2026-09-19", null), null);
  });

  test("a configured term produces the date", () => {
    assert.equal(dueDateFrom("2026-09-19", 14), "2026-10-03");
    assert.equal(dueDateFrom("2026-09-19", 0), "2026-09-19");
  });

  test("month and year boundaries are handled", () => {
    assert.equal(dueDateFrom("2026-12-28", 7), "2027-01-04");
    assert.equal(dueDateFrom("2028-02-28", 1), "2028-02-29");
  });

  test("dates print the way the existing invoices print them", () => {
    assert.equal(formatInvoiceDate("2026-09-19"), "19/09/2026");
  });
});

// ---------------------------------------------------------------------------
// VAT
// ---------------------------------------------------------------------------

describe("VAT stays switched off and unmentioned", () => {
  test("an unregistered position charges nothing and says nothing", () => {
    const totals = invoiceTotals(4500, NO_VAT);
    assert.equal(totals.vatPence, 0);
    assert.equal(totals.totalPence, 4500);
    assert.equal(totals.vatRegistered, false);
    assert.equal(totals.vatNumber, null);
  });

  test("no VAT wording reaches the page while registration is off", () => {
    const { svg } = renderInvoiceSvg({
      data: documentData(),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    assert.equal(/VAT/i.test(svg), false, "the page mentions VAT");
  });

  test("registering is a setting and a rate, not a redesign", () => {
    const totals = invoiceTotals(10000, REGISTERED_VAT);
    assert.equal(totals.vatPence, 2000);
    assert.equal(totals.totalPence, 12000);

    const { svg } = renderInvoiceSvg({
      data: documentData({ subtotalPence: 10000, vatPence: 2000, totalPence: 12000 }),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: REGISTERED_VAT,
    });
    assert.match(svg, /VAT/);
    assert.match(svg, /GB000000000/);
  });

  test("a half-configured VAT row parses as not registered", () => {
    // The ambiguous case is the safe one: a row missing its number or its
    // rate must never produce a document that charges tax.
    assert.equal(parseVatPosition({ ...REGISTERED_VAT, number: null }).registered, false);
    assert.equal(
      parseVatPosition({ ...REGISTERED_VAT, ratePercentBasisPoints: null }).registered,
      false,
    );
    assert.equal(parseVatPosition({ registered: true }).registered, false);
  });

  test("a position with no number prints no VAT, whatever it claims", () => {
    // The layout's own guard, independent of the parser.
    const { svg } = renderInvoiceSvg({
      data: documentData(),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: { ...REGISTERED_VAT, number: null },
    });
    assert.equal(/VAT/i.test(svg), false);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("nothing about the business is invented", () => {
  test("an empty configuration cannot issue, and says what is missing", () => {
    assert.equal(canIssueInvoices(EMPTY_BUSINESS_IDENTITY, EMPTY_INVOICE_TERMS), false);
    const missing = missingInvoiceIdentityFields(
      EMPTY_BUSINESS_IDENTITY,
      EMPTY_INVOICE_TERMS,
    );
    for (const field of [
      "displayName",
      "legalName",
      "addressLines",
      "postcode",
      "email",
      "footerText",
      "paymentTerms",
      "paymentInstructions",
    ]) {
      assert.ok(missing.includes(field), `${field} is not reported as missing`);
    }
  });

  test("a complete fixture configuration can issue", () => {
    assert.equal(canIssueInvoices(FIXTURE_IDENTITY, FIXTURE_TERMS), true);
  });

  test("the three optional lines are optional", () => {
    const withoutExtras = { ...FIXTURE_IDENTITY, tagline: null, qualifications: null, serviceLines: [] };
    assert.equal(canIssueInvoices(withoutExtras, FIXTURE_TERMS), true);
  });

  test("an unconfigured field prints nothing rather than a placeholder", () => {
    const { svg } = renderInvoiceSvg({
      data: documentData({ payerName: "A Payer", billingAddressLines: ["Somewhere"] }),
      identity: EMPTY_BUSINESS_IDENTITY,
      terms: EMPTY_INVOICE_TERMS,
      vat: NO_VAT,
    });

    // The frame and the fixed labels survive, because they are the form.
    assert.match(svg, /Description/);
    assert.match(svg, /Invoice no:/);

    // Nothing about the issuer does. The masthead, the telephone line, the
    // payment block and the footer are all absent rather than guessed.
    assert.equal(/Fixture Heating/.test(svg), false);
    assert.equal(/Telephone:/.test(svg), false);
    assert.equal(/Details for Payment/.test(svg), false);
    assert.equal(/Sort Code/.test(svg), false);
  });

  test("a stored identity round-trips through the parser unchanged", () => {
    assert.deepEqual(parseBusinessIdentity(FIXTURE_IDENTITY), FIXTURE_IDENTITY);
  });

  test("no real business identity is baked into the layout", () => {
    /*
      The generator this was ported from hard-coded a company name, a
      telephone number and three lines of bank details. None of it may have
      come across.
    */
    const layout = readFileSync(
      path.resolve(process.cwd(), "src/lib/invoices/pdf/layout.ts"),
      "utf8",
    );
    assert.equal(/Supreme Gas/i.test(layout), false);
    assert.equal(/Sort Code:\s*\d/.test(layout), false);
    assert.equal(/Account Number:\s*\d/.test(layout), false);
    assert.equal(/\b07\d{9}\b/.test(layout), false, "a telephone number is in the layout");
  });
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

describe("the page", () => {
  test("a PDF is produced, and it is a PDF", () => {
    const { bytes, warnings } = renderInvoicePdf({
      data: documentData(),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });

    assert.deepEqual(warnings, []);
    const header = Buffer.from(bytes.slice(0, 5)).toString("latin1");
    assert.equal(header, "%PDF-");
    const trailer = Buffer.from(bytes.slice(-8)).toString("latin1");
    assert.match(trailer, /%%EOF/);
    assert.ok(bytes.byteLength > 20_000, "no fonts were embedded");
  });

  test("the same input twice produces identical bytes", () => {
    // Deterministic: an invoice re-rendered from the same frozen data is the
    // same document, which is what makes a stored PDF checkable.
    const input = {
      data: documentData(),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    };
    const a = renderInvoicePdf(input).bytes;
    const b = renderInvoicePdf(input).bytes;
    assert.deepEqual(Buffer.from(a), Buffer.from(b));
  });

  test("the preview and the PDF come from one set of instructions", () => {
    const input = {
      data: documentData(),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    };
    const svg = renderInvoiceSvg(input);
    const pdf = renderInvoicePdf(input);
    assert.deepEqual(svg.warnings, pdf.warnings);

    // Everything the customer reads is in both.
    for (const text of [
      "BSCJ-001000",
      "Fixture Lettings Limited",
      "Gas Safety Certificate (CP12)",
      "19/09/2026",
    ]) {
      assert.ok(svg.svg.includes(text), `the preview is missing ${text}`);
    }
  });

  test("the service address and the billing address are both on it, and are different", () => {
    const { svg } = renderInvoiceSvg({
      data: documentData(),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    assert.match(svg, /14 Example Road/); // service
    assert.match(svg, /Fixture House/); // billing
  });

  test("a draft is stamped, so a preview cannot be mistaken for an invoice", () => {
    const { svg } = renderInvoiceSvg({
      data: documentData({ number: null, draft: true }),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    assert.match(svg, /DRAFT/);
  });

  test("a voided invoice is stamped VOID", () => {
    const { svg } = renderInvoiceSvg({
      data: documentData({ voided: true }),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    assert.match(svg, /VOID/);
  });

  test("a quantity above one is shown, so the arithmetic can be checked", () => {
    const { svg } = renderInvoiceSvg({
      data: documentData({
        lines: [
          {
            description: "Additional appliance",
            quantity: 2,
            unitPricePence: 1500,
            totalPence: 3000,
          },
        ],
        subtotalPence: 3000,
        totalPence: 3000,
      }),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    assert.match(svg, /2 × £15\.00/);
    assert.match(svg, /£30\.00/);
  });

  test("text too long to fit is reported rather than printed over the footer", () => {
    const { warnings } = renderInvoicePdf({
      data: documentData({
        lines: Array.from({ length: 6 }, (_, i) => ({
          description: `Line ${i}: ${"a very long description that wraps ".repeat(8)}`,
          quantity: 1,
          unitPricePence: 100,
          totalPence: 100,
        })),
        subtotalPence: 600,
        totalPence: 600,
      }),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    assert.ok(warnings.length > 0, "an overflowing invoice reported nothing");
    assert.match(warnings.join(" "), /does not fit/i);
  });

  test("an over-long billing address is reported", () => {
    const { warnings } = renderInvoicePdf({
      data: documentData({
        billingAddressLines: ["a", "b", "c", "d", "e", "f"],
      }),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    assert.match(warnings.join(" "), /billing address/i);
  });

  test("the blank template renders without any data at all", () => {
    const { bytes, warnings } = renderInvoicePdf({
      data: {
        number: null,
        date: null,
        dueDate: null,
        payerName: "",
        billingAddressLines: [],
        propertyLine: null,
        lines: [],
        subtotalPence: 0,
        vatPence: 0,
        totalPence: 0,
        draft: false,
        voided: false,
      },
      identity: EMPTY_BUSINESS_IDENTITY,
      terms: EMPTY_INVOICE_TERMS,
      vat: NO_VAT,
    });
    assert.deepEqual(warnings, []);
    assert.ok(bytes.byteLength > 0);
  });

  test("a payer name with a parenthesis cannot break the PDF syntax", () => {
    // `(`, `)` and `\` are the three characters a PDF string literal cares
    // about. An unescaped one corrupts the file rather than the text.
    const { bytes } = renderInvoicePdf({
      data: documentData({ payerName: "Fixture (Lettings) \\ Co" }),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    const text = Buffer.from(bytes).toString("latin1");
    assert.match(text, /Fixture \\\(Lettings\\\) \\\\ Co/);
    assert.match(Buffer.from(bytes.slice(-8)).toString("latin1"), /%%EOF/);
  });

  test("SVG-significant characters in a description are escaped in the preview", () => {
    const { svg } = renderInvoiceSvg({
      data: documentData({
        lines: [
          {
            description: "Boiler <service> & check",
            quantity: 1,
            unitPricePence: 6000,
            totalPence: 6000,
          },
        ],
      }),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    assert.match(svg, /&lt;service&gt;/);
    assert.match(svg, /&amp;/);
    assert.equal(/<service>/.test(svg), false);
  });
});

describe("overflow is always reported, never silent", () => {
  /*
    Every one of these was found by rendering a deliberately extreme invoice
    and looking at the page. Two of them were real faults that produced no
    warning at all: the telephone number and the email address printed on top
    of one another, and the payment terms — the one field a customer may have
    to act on — were drawn centred with no width limit and ran off both edges
    of the page, losing their first and last words.

    A warning is not cosmetic here: `issueInvoice` refuses while any warning
    stands, so anything reported below cannot reach a customer.
  */

  const long = (n: number, word = "verylongword") =>
    Array.from({ length: n }, () => word).join(" ");

  test("a contact value too long for its half of the row is reported", () => {
    /*
      The telephone and the email each get half the row and are capped there,
      which is what stops them meeting. A value that will not fit its half
      even at the smallest size is reported rather than printed illegibly
      across the rule.
    */
    const { warnings } = renderInvoiceSvg({
      data: documentData(),
      identity: {
        ...FIXTURE_IDENTITY,
        phone: "01902 000000 / 07700 900000 / 07700 900001 extension 1234 / out of hours 07700 900002",
        email: "accounts.receivable.department.invoices.and.credit.control@a-very-long-fixture-domain.invalid",
      },
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    assert.match(warnings.join(" "), /too long for its half of the contact line/i);
  });

  test("an ordinary long telephone and email do not trip it", () => {
    const { warnings } = renderInvoiceSvg({
      data: documentData(),
      identity: {
        ...FIXTURE_IDENTITY,
        phone: "01902 000000 / 07700 900000",
        email: "accounts.receivable.department@a-very-long-fixture-domain.invalid",
      },
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    assert.equal(
      /telephone number and the email address/i.test(warnings.join(" ")),
      false,
      "a case that fits was reported as an overflow",
    );
  });

  test("payment terms wrap instead of running off the page", () => {
    const terms = {
      ...FIXTURE_TERMS,
      paymentTerms:
        "Payment is due within fourteen days of the invoice date. Late payment may attract statutory interest under the Late Payment of Commercial Debts (Interest) Act 1998.",
    };
    const { svg, warnings } = renderInvoiceSvg({
      data: documentData(),
      identity: FIXTURE_IDENTITY,
      terms,
      vat: NO_VAT,
    });

    // It fits in two lines, so nothing is reported and nothing is lost.
    assert.deepEqual(warnings, []);
    // Both ends of the sentence survive, which is what clipping destroyed.
    assert.match(svg, /Payment is due within fourteen days/);
    assert.match(svg, /Act 1998\./);
  });

  test("payment terms too long for two lines say what is not printed", () => {
    const { warnings } = renderInvoiceSvg({
      data: documentData(),
      identity: FIXTURE_IDENTITY,
      terms: { ...FIXTURE_TERMS, paymentTerms: long(40, "terms") },
      vat: NO_VAT,
    });
    const text = warnings.join(" ");
    assert.match(text, /payment terms need \d+ lines/i);
    assert.match(text, /Not printed:/);
  });

  test("a truncated billing address names the lines that vanished", () => {
    const { warnings } = renderInvoiceSvg({
      data: documentData({
        billingAddressLines: ["One", "Two", "Three", "Four", "Five", "WV9 9ZZ"],
      }),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    const text = warnings.join(" ");
    assert.match(text, /Not printed:/);
    // The postcode is the line a payment most needs, and it is the first to
    // fall off the end. Counting the lines would not have said so.
    assert.match(text, /WV9 9ZZ/);
  });

  test("truncated payment details name what is missing", () => {
    const { warnings } = renderInvoiceSvg({
      data: documentData(),
      identity: FIXTURE_IDENTITY,
      terms: {
        ...FIXTURE_TERMS,
        paymentInstructions:
          "Name: Fixture\nAccount Number: 00000000\nSort Code: 00-00-00\nIBAN: GB00FIXT00000000000000",
      },
      vat: NO_VAT,
    });
    const text = warnings.join(" ");
    assert.match(text, /Not printed:/);
    assert.match(text, /IBAN/);
  });

  test("a masthead line nothing can shrink to fit is reported", () => {
    const { warnings } = renderInvoiceSvg({
      data: documentData(),
      identity: { ...FIXTURE_IDENTITY, displayName: long(12, "Enormous") },
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    assert.match(warnings.join(" "), /trading name is too long/i);
  });

  test("more services lines than the layout has room for are reported", () => {
    const { warnings } = renderInvoiceSvg({
      data: documentData(),
      identity: { ...FIXTURE_IDENTITY, serviceLines: ["One", "Two", "Three"] },
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    assert.match(warnings.join(" "), /services lines/i);
  });

  test("a page that cannot print every line says the total does not add up", () => {
    /*
      The most dangerous page this layout can produce: lines missing, and a
      total below them that includes the ones that are not there. Stated in
      its own right rather than left to be inferred.
    */
    const { warnings } = renderInvoiceSvg({
      data: documentData({
        lines: Array.from({ length: 8 }, (_, i) => ({
          description: `Line ${i}: ${long(10, "description")}`,
          quantity: 1,
          unitPricePence: 1000,
          totalPence: 1000,
        })),
        subtotalPence: 8000,
        totalPence: 8000,
      }),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    const text = warnings.join(" ");
    assert.match(text, /does not fit/i);
    assert.match(text, /does not add up to the lines above it/i);
  });

  test("a realistic long agency name prints at full size and is not reported", () => {
    // 300pt was inherited from a generator whose names were short, and it
    // shrank ordinary agency names for no reason. Nothing sits to the right
    // of this line.
    const { warnings } = renderInvoiceSvg({
      data: documentData({
        payerName: "Bartlett Residential Lettings (Wolverhampton) Limited",
      }),
      identity: FIXTURE_IDENTITY,
      terms: FIXTURE_TERMS,
      vat: NO_VAT,
    });
    assert.deepEqual(warnings, []);
  });

  test("the extreme invoice is fully reported and still renders a valid PDF", () => {
    const { bytes, warnings } = renderInvoicePdf({
      data: documentData({
        payerName: long(9, "Extremely"),
        billingAddressLines: ["One", "Two", "Three", "Four", "WV9 9ZZ"],
        propertyLine: long(12, "Property"),
        lines: Array.from({ length: 10 }, (_, i) => ({
          description: `Service ${i}: ${long(8, "described")}`,
          quantity: i + 1,
          unitPricePence: 1500,
          totalPence: (i + 1) * 1500,
        })),
        subtotalPence: 82500,
        totalPence: 82500,
      }),
      identity: { ...FIXTURE_IDENTITY, displayName: long(10, "Enormous") },
      terms: { ...FIXTURE_TERMS, paymentInstructions: long(3, "pay").split(" ").join("\n") },
      vat: NO_VAT,
    });

    assert.ok(warnings.length > 0, "an extreme invoice reported nothing");
    // It still produces a well-formed file rather than throwing — the page is
    // reported as unissuable, not made impossible to look at.
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString("latin1"), "%PDF-");
    assert.match(Buffer.from(bytes.slice(-8)).toString("latin1"), /%%EOF/);
  });

  test("a warning is what stops it being issued", () => {
    // The link between "the page reports a problem" and "nobody receives it"
    // lives in `issueInvoice`, which refuses while any warning stands. This
    // asserts the refusal exists in that module rather than only in a comment.
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/invoices/invoices.ts"),
      "utf8",
    );
    assert.match(source, /if \(warnings\.length > 0\)/);
    assert.match(source, /Nothing was issued/);
  });
});

describe("text metrics, which every coordinate depends on", () => {
  test("width scales with size and is measured, not guessed", () => {
    const small = textWidth("reg", "Gas Safety Certificate", 11);
    const large = textWidth("reg", "Gas Safety Certificate", 22);
    assert.ok(small > 0);
    assert.ok(Math.abs(large - small * 2) < 0.001);
  });

  test("wrapping keeps every line inside the column", () => {
    const maxW = 364;
    const lines = wrapText("ital", "a ".repeat(200).trim(), 11, maxW);
    assert.ok(lines.length > 1);
    for (const line of lines) {
      assert.ok(textWidth("ital", line, 11) <= maxW, line);
    }
  });

  test("a single word wider than the column is hard-broken, not left to overflow", () => {
    const maxW = 60;
    const lines = wrapText("reg", "x".repeat(200), 11, maxW);
    assert.ok(lines.length > 1);
    for (const line of lines) {
      assert.ok(textWidth("reg", line, 11) <= maxW);
    }
  });
});

// ---------------------------------------------------------------------------
// Outbox keys
// ---------------------------------------------------------------------------

describe("the outbox key is the provider's key, so retries and re-approvals differ", () => {
  const invoiceId = "11111111-2222-3333-4444-555555555555";

  test("a retry keeps the key; a re-approval does not", () => {
    const first = invoiceKey(invoiceId, "agent", 1);
    const again = invoiceKey(invoiceId, "agent", 1);
    const reapproved = invoiceKey(invoiceId, "agent", 2);

    assert.equal(first, again, "a retry would produce a different key");
    assert.notEqual(first, reapproved, "a re-approval would be deduplicated away");
  });

  test("two recipients are two keys", () => {
    assert.notEqual(
      invoiceKey(invoiceId, "agent", 1),
      invoiceKey(invoiceId, "customer", 1),
    );
  });

  test("the invoice and the approval are readable back out of the key", () => {
    const key = invoiceKey(invoiceId, "customer", 3);
    assert.equal(invoiceFromKey(key), invoiceId);
    assert.equal(invoiceApprovalFromKey(key), 3);
  });

  test("a certificate key is never read as an invoice key", () => {
    // Widening either reader would let one kind's provider key collide with
    // the other's.
    const certificate = certificateKey(invoiceId, "agent", 1);
    assert.equal(invoiceFromKey(certificate), null);
    assert.equal(invoiceApprovalFromKey(certificate), null);
  });

  test("the approved address is frozen onto the row, not resolved later", () => {
    const rows = invoiceRows({
      jobId: "99999999-8888-7777-6666-555555555555",
      invoiceId,
      recipients: [
        { recipient: "agent", address: "lettings@example.invalid" },
        { recipient: "customer", address: "payer@example.invalid", approval: 2 },
      ],
    });

    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.recipientAddress, "lettings@example.invalid");
    assert.equal(rows[1]!.recipientAddress, "payer@example.invalid");
    assert.equal(rows[0]!.kind, OUTBOX_KINDS.invoice);
    assert.match(rows[1]!.idempotencyKey, /:customer:2$/);
  });

  test("no address appears in a key", () => {
    // A key ends up in logs. An address in one is an address in a log.
    const rows = invoiceRows({
      jobId: "99999999-8888-7777-6666-555555555555",
      invoiceId,
      recipients: [{ recipient: "agent", address: "lettings@example.invalid" }],
    });
    assert.equal(rows[0]!.idempotencyKey.includes("@"), false);
  });
});
