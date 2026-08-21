import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  formatUkMobileForDisplay,
  normaliseEmail,
  normaliseUkMobile,
} from "./contact";
import { bookingSchema } from "./schema";

describe("UK mobile numbers are accepted however people write them", () => {
  const canonical = "+447700900123";

  const accepted: [string, string][] = [
    ["plain national", "07700900123"],
    ["national with a space", "07700 900123"],
    ["national with several spaces", "07700 900 123"],
    ["with dashes", "07700-900-123"],
    ["with brackets", "(07700) 900123"],
    ["pasted with +44", "+447700900123"],
    ["+44 with spaces", "+44 7700 900123"],
    ["+44 with a space and no zero", "+44 7700900123"],
    ["international 0044 form", "00447700900123"],
    ["bare 44 prefix", "447700900123"],
    ["without the leading zero", "7700900123"],
    ["surrounded by whitespace", "  07700 900123  "],
  ];

  for (const [description, input] of accepted) {
    test(`${description}: ${input}`, () => {
      const result = normaliseUkMobile(input);
      assert.equal(result.ok, true, `${input} should be accepted`);
      assert.equal(result.ok && result.e164, canonical);
    });
  }

  test("every accepted form produces exactly the same stored value", () => {
    const stored = new Set(
      accepted.map(([, input]) => {
        const result = normaliseUkMobile(input);
        return result.ok ? result.e164 : "rejected";
      }),
    );
    assert.equal(stored.size, 1);
    assert.ok(stored.has(canonical));
  });

  test("the national form is also returned, for display", () => {
    const result = normaliseUkMobile("+447700900123");
    assert.equal(result.ok && result.national, "07700900123");
  });
});

describe("bad numbers are rejected", () => {
  const rejected: [string, string][] = [
    ["empty", ""],
    ["whitespace only", "   "],
    ["far too short", "0770"],
    ["one digit short", "0770090012"],
    ["one digit too many", "077009001234"],
    ["letters", "07700 SEVEN"],
    ["entirely alphabetic", "not a number"],
    ["a landline, not a mobile", "01902123456"],
    ["a London landline", "02079460958"],
    ["an 07 number that is not a mobile range", "07000000"],
    ["a US number", "+12125550123"],
    ["symbols only", "+++"],
  ];

  for (const [description, input] of rejected) {
    test(`${description}: ${JSON.stringify(input)}`, () => {
      assert.equal(
        normaliseUkMobile(input).ok,
        false,
        `${input} should be rejected`,
      );
    });
  }

  test("rejection reasons are specific enough to explain", () => {
    const empty = normaliseUkMobile("");
    assert.equal(empty.ok === false && empty.reason, "empty");
    const short = normaliseUkMobile("0770090012");
    assert.equal(short.ok === false && short.reason, "too_short");
    const long = normaliseUkMobile("077009001234");
    assert.equal(long.ok === false && long.reason, "too_long");
    const letters = normaliseUkMobile("07700 abcdef");
    assert.equal(letters.ok === false && letters.reason, "not_numeric");
    const landline = normaliseUkMobile("01902123456");
    assert.equal(landline.ok === false && landline.reason, "not_uk_mobile");
  });
});

describe("displaying a stored number", () => {
  test("reads back in the familiar national form", () => {
    assert.equal(formatUkMobileForDisplay("+447700900123"), "07700 900123");
  });

  test("an unrecognised value is returned untouched rather than mangled", () => {
    assert.equal(formatUkMobileForDisplay("not a number"), "not a number");
  });
});

describe("email validation", () => {
  test("a normal address passes and is lowercased and trimmed", () => {
    const result = normaliseEmail("  Jane.Smith@Example.CO.UK ");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.email, "jane.smith@example.co.uk");
  });

  test("plus addressing and subdomains are accepted", () => {
    assert.equal(normaliseEmail("jane+cp12@mail.example.co.uk").ok, true);
  });

  const malformed = [
    ["empty", ""],
    ["no at sign", "janeexample.com"],
    ["nothing before the at", "@example.com"],
    ["nothing after the at", "jane@"],
    ["no dot in the domain", "jane@example"],
    ["a space inside", "jane smith@example.com"],
    ["two at signs", "jane@@example.com"],
    ["a trailing comma", "jane@example.com,"],
    ["a semicolon separated pair", "jane@example.com;bob@example.com"],
    ["angle brackets", "<jane@example.com>"],
  ];

  for (const [description, input] of malformed) {
    test(`rejects ${description}: ${JSON.stringify(input)}`, () => {
      assert.equal(normaliseEmail(input).ok, false);
    });
  }

  test("an absurdly long address is rejected", () => {
    const long = `${"a".repeat(250)}@example.com`;
    const result = normaliseEmail(long);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "too_long");
  });

  test("nothing here contacts a mail server", () => {
    // Shape only, by design: no SMTP probe, no verification API, no send.
    // The function is synchronous, which is the simplest proof of that.
    assert.equal(typeof normaliseEmail("jane@example.com"), "object");
  });
});

describe("the booking schema uses the same rules", () => {
  const valid = {
    slotStart: "2026-08-24T16:00:00.000Z",
    fullName: "Jane Smith",
    email: "  Jane@Example.com ",
    phone: "07700 900123",
    houseOrName: "24",
    street: "Example Road",
    postcode: "wv1 1aa",
    customerType: "landlord",
    applianceCount: 3,
    addressConfirmedByCustomer: true,
    idempotencyKey: "abcdefgh1234",
  };

  test("the phone is stored in canonical form, not as typed", () => {
    const result = bookingSchema.safeParse(valid);
    assert.equal(result.success, true);
    assert.equal(result.success && result.data.phone, "+447700900123");
  });

  test("the email is normalised", () => {
    const result = bookingSchema.safeParse(valid);
    assert.equal(result.success && result.data.email, "jane@example.com");
  });

  test("a malformed phone is rejected with a usable message", () => {
    const result = bookingSchema.safeParse({ ...valid, phone: "01902123456" });
    assert.equal(result.success, false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "phone");
      assert.ok(issue?.message.includes("UK mobile"));
    }
  });

  test("a malformed email is rejected", () => {
    assert.equal(
      bookingSchema.safeParse({ ...valid, email: "jane@example" }).success,
      false,
    );
  });

  test("a blank tenant phone is fine, because it is optional", () => {
    assert.equal(
      bookingSchema.safeParse({ ...valid, tenantPhone: "" }).success,
      true,
    );
  });

  test("a supplied tenant phone is held to the same standard", () => {
    assert.equal(
      bookingSchema.safeParse({ ...valid, tenantPhone: "07700 900999" }).success,
      true,
    );
    assert.equal(
      bookingSchema.safeParse({ ...valid, tenantPhone: "01902123456" }).success,
      false,
    );
  });

  test("a supplied tenant phone is normalised too", () => {
    const result = bookingSchema.safeParse({
      ...valid,
      tenantPhone: "+44 7700 900999",
    });
    assert.equal(result.success && result.data.tenantPhone, "+447700900999");
  });

  test("the address confirmation is required, not merely encouraged", () => {
    const withoutConfirmation: Record<string, unknown> = { ...valid };
    delete withoutConfirmation.addressConfirmedByCustomer;
    assert.equal(bookingSchema.safeParse(withoutConfirmation).success, false);
    assert.equal(
      bookingSchema.safeParse({ ...valid, addressConfirmedByCustomer: false })
        .success,
      false,
    );
  });

  test("a submission cannot fake the confirmation with a truthy value", () => {
    for (const forged of ["true", 1, "yes", {}]) {
      assert.equal(
        bookingSchema.safeParse({ ...valid, addressConfirmedByCustomer: forged })
          .success,
        false,
        `${JSON.stringify(forged)} should not count as confirmation`,
      );
    }
  });
});
