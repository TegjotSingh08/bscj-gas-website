import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildIdentitySnapshot,
  canIssueInvoices,
  EMPTY_BUSINESS_IDENTITY,
  EMPTY_INVOICE_TERMS,
  invoiceTotals,
  missingInvoiceIdentityFields,
  NOT_VAT_REGISTERED,
  parseBusinessIdentity,
  parseInvoiceTerms,
  parseVatPosition,
  type BusinessIdentity,
} from "./business-identity";

/**
 * Business identity and VAT.
 *
 * Two rules are worth more than the rest: nothing here invents a value, and
 * nothing charges or mentions VAT while registration is off. Both failure
 * directions are tested, because the safe one has to be the default.
 */

const COMPLETE: BusinessIdentity = {
  displayName: "BSCJ Solutions",
  tradingName: "BSCJ Gas & Heating",
  legalName: "Example Entity Ltd",
  companyNumber: "00000000",
  addressLines: ["Unit 1", "Example Street"],
  postcode: "WV1 1AA",
  phone: "07000000000",
  email: "admin@example.com",
  website: "https://example.com",
  gasSafeNumber: "000000",
  footerText: "To be confirmed before issue.",
};

const COMPLETE_TERMS = {
  paymentTerms: "Due on receipt",
  paymentDueDays: 0,
  paymentInstructions: "Bank transfer.",
};

describe("nothing is invented", () => {
  test("an unset identity is empty, not a placeholder", () => {
    /*
      The legal entity behind BSCJ is changing. A default that reached a
      document would be a claim about who issued it, which is not this code's
      to make.
    */
    for (const value of [null, undefined, "", 42, []]) {
      assert.deepEqual(parseBusinessIdentity(value), EMPTY_BUSINESS_IDENTITY);
    }
  });

  test("blank strings are treated as unset, not as a value", () => {
    const identity = parseBusinessIdentity({ displayName: "   ", legalName: "" });
    assert.equal(identity.displayName, null);
    assert.equal(identity.legalName, null);
  });

  test("the trading name and the legal entity are never collapsed", () => {
    // They differ today and are expected to differ again.
    const identity = parseBusinessIdentity(COMPLETE);
    assert.equal(identity.displayName, "BSCJ Solutions");
    assert.equal(identity.legalName, "Example Entity Ltd");
    assert.notEqual(identity.displayName, identity.legalName);
  });

  test("terms default to unset rather than to a guessed period", () => {
    assert.deepEqual(parseInvoiceTerms(null), EMPTY_INVOICE_TERMS);
    assert.equal(parseInvoiceTerms({ paymentDueDays: -5 }).paymentDueDays, null);
    assert.equal(parseInvoiceTerms({ paymentDueDays: 1.5 }).paymentDueDays, null);
  });
});

describe("an invoice cannot be issued on missing facts", () => {
  test("an empty configuration lists exactly what is missing", () => {
    const missing = missingInvoiceIdentityFields(
      EMPTY_BUSINESS_IDENTITY,
      EMPTY_INVOICE_TERMS,
    );
    assert.deepEqual(missing.sort(), [
      "addressLines",
      "displayName",
      "email",
      "footerText",
      "legalName",
      "paymentInstructions",
      "paymentTerms",
      "postcode",
    ]);
    assert.equal(canIssueInvoices(EMPTY_BUSINESS_IDENTITY, EMPTY_INVOICE_TERMS), false);
  });

  test("one missing field is still a refusal", () => {
    // A list rather than a boolean so an admin screen can say what to fill in;
    // but any gap blocks issuing, and code never fills one with a default.
    assert.equal(
      canIssueInvoices({ ...COMPLETE, footerText: null }, COMPLETE_TERMS),
      false,
    );
  });

  test("a complete configuration permits issuing", () => {
    assert.deepEqual(missingInvoiceIdentityFields(COMPLETE, COMPLETE_TERMS), []);
    assert.equal(canIssueInvoices(COMPLETE, COMPLETE_TERMS), true);
  });
});

describe("VAT, while registration is off", () => {
  test("the default position is not registered", () => {
    // BSCJ is not currently VAT registered, confirmed 16 September 2026.
    assert.deepEqual(parseVatPosition(null), NOT_VAT_REGISTERED);
    assert.equal(NOT_VAT_REGISTERED.registered, false);
  });

  test("nothing is charged, and the renderer is told to print nothing", () => {
    const totals = invoiceTotals(9000, NOT_VAT_REGISTERED);
    assert.equal(totals.vatPence, 0);
    assert.equal(totals.totalPence, 9000);
    /*
      `vatRegistered: false` is what tells the renderer to print no VAT line,
      no VAT number and no "VAT" anywhere. Showing "VAT £0.00" would be a claim
      about tax status that is not ours to make.
    */
    assert.equal(totals.vatRegistered, false);
    assert.equal(totals.vatNumber, null);
  });

  test("a half-configured registration reads as not registered", () => {
    /*
      The ambiguous case must be the safe one: a partly-filled VAT row must
      never produce a document that charges tax.
    */
    for (const value of [
      { registered: true },
      { registered: true, number: "GB123456789" },
      { registered: true, ratePercentBasisPoints: 2000 },
      { registered: true, number: "", ratePercentBasisPoints: 2000 },
      { registered: true, number: "GB123456789", ratePercentBasisPoints: -1 },
      { registered: true, number: "GB123456789", ratePercentBasisPoints: 20.5 },
      { registered: "yes", number: "GB123456789", ratePercentBasisPoints: 2000 },
    ]) {
      assert.deepEqual(
        parseVatPosition(value),
        NOT_VAT_REGISTERED,
        JSON.stringify(value),
      );
    }
  });
});

describe("VAT, once registration is switched on", () => {
  const registered = parseVatPosition({
    registered: true,
    number: "GB123456789",
    ratePercentBasisPoints: 2000,
    registeredFrom: "2027-01-01",
  });

  test("enabling it is a settings change, not a schema change", () => {
    assert.equal(registered.registered, true);
    assert.equal(registered.ratePercentBasisPoints, 2000);
  });

  test("the rate is basis points, so it cannot arrive as a float", () => {
    // 20% is 2000. A rate held as 0.2 arrives at an invoice as
    // 19.999999999999996 often enough to matter.
    assert.equal(Number.isInteger(registered.ratePercentBasisPoints), true);
  });

  test("it is added to the subtotal and rounded once", () => {
    assert.deepEqual(invoiceTotals(9000, registered), {
      subtotalPence: 9000,
      vatPence: 1800,
      totalPence: 10_800,
      vatRegistered: true,
      vatNumber: "GB123456789",
    });
  });

  test("an awkward subtotal rounds to a whole penny", () => {
    const totals = invoiceTotals(3999, registered);
    assert.equal(totals.vatPence, 800);
    assert.equal(Number.isInteger(totals.vatPence), true);
    assert.equal(totals.totalPence, totals.subtotalPence + totals.vatPence);
  });
});

describe("the identity frozen onto an invoice", () => {
  test("it captures identity, VAT and terms together, with a timestamp", () => {
    const at = new Date("2026-09-16T12:00:00.000Z");
    const snapshot = buildIdentitySnapshot(
      COMPLETE,
      NOT_VAT_REGISTERED,
      COMPLETE_TERMS,
      at,
    );

    assert.equal(snapshot.identity.legalName, "Example Entity Ltd");
    assert.equal(snapshot.vat.registered, false);
    assert.equal(snapshot.terms.paymentTerms, "Due on receipt");
    assert.equal(snapshot.capturedAt, at.toISOString());
  });

  test("changing the settings afterwards does not change the snapshot", () => {
    // An invoice must not silently start claiming to have been issued by a
    // company that did not exist on its date.
    const snapshot = buildIdentitySnapshot(
      COMPLETE,
      NOT_VAT_REGISTERED,
      COMPLETE_TERMS,
    );
    const stored = JSON.parse(JSON.stringify(snapshot));

    const renamed = parseBusinessIdentity({
      ...COMPLETE,
      legalName: "BSCJ Solutions Ltd",
    });
    assert.equal(renamed.legalName, "BSCJ Solutions Ltd");
    assert.equal(stored.identity.legalName, "Example Entity Ltd");
  });
});
