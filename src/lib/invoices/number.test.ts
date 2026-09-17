import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  formatInvoiceNumber,
  INVOICE_DIGITS,
  INVOICE_PREFIX,
  isInvoiceNumber,
  normaliseInvoiceNumber,
  parseInvoiceNumber,
} from "./number";
import {
  generateJobReference,
  isJobReference,
  normaliseJobReference,
} from "@/lib/jobs/reference";

/**
 * Invoice numbering.
 *
 * V2 runs its own `BSCJ-001000` series rather than continuing the standalone
 * generator's hand-maintained `D-…` one. The rules that matter are that a
 * number is never reissued, never truncated, and never confusable with a job
 * reference.
 */
describe("the format", () => {
  test("it is the prefix and six digits", () => {
    assert.equal(INVOICE_PREFIX, "BSCJ-");
    assert.equal(INVOICE_DIGITS, 6);
    assert.equal(formatInvoiceNumber(1000), "BSCJ-001000");
    assert.equal(formatInvoiceNumber(1001), "BSCJ-001001");
    assert.equal(formatInvoiceNumber(1002), "BSCJ-001002");
    assert.equal(formatInvoiceNumber(999_999), "BSCJ-999999");
  });

  test("the first V2 invoice is BSCJ-001000", () => {
    /*
      The sequence starts at 1000 rather than at 1, so the first invoice is not
      obviously the first. The padding is unchanged, so the series reads as an
      ordinary six-digit number and has room for 998,999 more before it widens.

      The start lives in drizzle/0001; this module formats whatever the
      sequence hands it. The assertion below is the pairing of the two.
    */
    const migration = readFileSync(
      path.resolve(process.cwd(), "drizzle/0001_invoice_number_sequence.sql"),
      "utf8",
    );
    const start = Number(/START WITH (\d+)/.exec(migration)?.[1]);

    assert.equal(start, 1000);
    assert.equal(formatInvoiceNumber(start), "BSCJ-001000");
    assert.equal(formatInvoiceNumber(start + 1), "BSCJ-001001");
    assert.equal(formatInvoiceNumber(start + 2), "BSCJ-001002");
  });

  test("padding still applies below the starting point", () => {
    // Nothing should ever draw one of these, but the format is the format:
    // moving the start is a migration change, not a change to the shape.
    assert.equal(formatInvoiceNumber(1), "BSCJ-000001");
    assert.equal(formatInvoiceNumber(999), "BSCJ-000999");
  });

  test("a value beyond six digits is rendered in full, never wrapped", () => {
    /*
      Truncating to six digits would restart the series at BSCJ-000000 and
      reissue every number, which is the one thing this format exists to
      prevent. A wider number is ugly and correct.
    */
    assert.equal(formatInvoiceNumber(1_000_000), "BSCJ-1000000");
  });

  test("a sequence never produces zero or a fraction, so neither is accepted", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => formatInvoiceNumber(value), RangeError, String(value));
    }
  });

  test("only the exact shape validates", () => {
    assert.equal(isInvoiceNumber("BSCJ-001000"), true);
    for (const value of [
      "BSCJ-00001",
      "BSCJ-0000001",
      "bscj-000001",
      "BSCJ000001",
      "D-130",
      "BSCJ-00A001",
      "",
    ]) {
      assert.equal(isInvoiceNumber(value), false, value);
    }
  });

  test("a number reads back to the sequence value that made it", () => {
    for (const value of [1, 1000, 1001, 999_999]) {
      assert.equal(parseInvoiceNumber(formatInvoiceNumber(value)), value);
    }
  });
});

describe("what someone actually types", () => {
  test("lower case, missing prefix, spaces and hyphens are all tolerated", () => {
    // What arrives when a number is read off a PDF or quoted over the phone.
    for (const typed of [
      "BSCJ-000154",
      "bscj-000154",
      "BSCJ 000154",
      "000154",
      "  bscj000154  ",
      "154",
    ]) {
      assert.equal(normaliseInvoiceNumber(typed), "BSCJ-000154", typed);
    }
  });

  test("nonsense normalises to null, so a search never runs on it", () => {
    for (const typed of ["", "invoice", "BSCJ-ABC123", "D-130", "1 2 A"]) {
      assert.equal(normaliseInvoiceNumber(typed), null, typed);
    }
  });

  test("stray hyphens inside the digits are stripped, not rejected", () => {
    // Deliberate leniency. Someone reading "000154" off a PDF and typing
    // "12-34-56" has typed a number, and refusing it teaches them nothing.
    assert.equal(normaliseInvoiceNumber("12-34-56"), "BSCJ-123456");
  });

  test("the old D- series is not recognised, deliberately", () => {
    // Two systems incrementing one series is how two invoices end up sharing
    // a number.
    assert.equal(normaliseInvoiceNumber("D-154"), null);
    assert.equal(isInvoiceNumber("D-154"), false);
  });
});

describe("invoice numbers and job references cannot be confused", () => {
  test("a generated reference is never all digits", () => {
    /*
      Both use the `BSCJ-` prefix, and digits are in the reference alphabet, so
      about one reference in a thousand would otherwise come out looking
      exactly like an invoice number. Generation refuses the shape.
    */
    for (let attempt = 0; attempt < 3000; attempt += 1) {
      const reference = generateJobReference();
      assert.equal(
        isInvoiceNumber(reference),
        false,
        `${reference} is indistinguishable from an invoice number`,
      );
    }
  });

  test("a generated reference is still a valid reference", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      assert.equal(isJobReference(generateJobReference()), true);
    }
  });

  test("an all-digit reference still validates, because V1 issued them", () => {
    /*
      V1 derived references from a hash and had no such rule, so all-digit
      references are already sitting in customers' inboxes. Refusing them here
      would make a real booking unquotable.
    */
    assert.equal(isJobReference("BSCJ-482910"), true);
    assert.equal(normaliseJobReference("bscj 482910"), "BSCJ-482910");
  });

  test("an invoice number is never accepted as a reference lookup result", () => {
    // Letters in a reference mean an invoice lookup can never match one.
    assert.equal(normaliseInvoiceNumber("BSCJ-A1B2C3"), null);
  });
});
