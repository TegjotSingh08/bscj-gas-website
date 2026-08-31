import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DETAILS_FIELD_ORDER,
  firstInvalidField,
  hasErrors,
  validateDetails,
} from "./details";
import { bookingSchema } from "./schema";

/**
 * The details step must not let a customer through with contact fields blank.
 *
 * The production defect: the Continue button gated only on the address being
 * ready, so a valid postcode was enough to reach Review with the name, email
 * and mobile empty. The server always refused those — but not until Confirm,
 * after the customer had held a slot, typed an address and read the terms.
 */

/** A submission that should sail through. */
const VALID = {
  fullName: "Jane Smith",
  email: "jane@example.com",
  phone: "07700 900123",
  houseOrName: "24",
  street: "Example Road",
  postcode: "WV1 1AA",
  customerType: "landlord",
  applianceCount: 3,
  tenantPhone: "",
};

const withValues = (overrides: Record<string, unknown> = {}) =>
  validateDetails({ ...VALID, ...overrides } as typeof VALID);

describe("a complete, valid form passes", () => {
  test("no errors at all", () => {
    assert.deepEqual(withValues(), {});
    assert.equal(hasErrors(withValues()), false);
    assert.equal(firstInvalidField(withValues()), null);
  });

  test("a UK 07-style mobile is accepted", () => {
    assert.equal(withValues({ phone: "07700 900123" }).phone, undefined);
    assert.equal(withValues({ phone: "07700900123" }).phone, undefined);
  });

  test("a +44 mobile is accepted", () => {
    assert.equal(withValues({ phone: "+447700900123" }).phone, undefined);
    assert.equal(withValues({ phone: "+44 7700 900123" }).phone, undefined);
  });

  test("normal human formatting is tolerated", () => {
    for (const phone of ["07700 900 123", "(07700) 900123", "07700-900-123"]) {
      assert.equal(withValues({ phone }).phone, undefined, phone);
    }
  });
});

describe("the name is required", () => {
  test("blank cannot progress", () => {
    assert.ok(withValues({ fullName: "" }).fullName);
  });

  test("whitespace only cannot progress", () => {
    // The exact shape a customer produces by tabbing through and typing a space.
    for (const fullName of [" ", "   ", "\t", "\n  \t "]) {
      assert.ok(
        withValues({ fullName }).fullName,
        `${JSON.stringify(fullName)} must be rejected`,
      );
    }
  });

  test("a single character is not a name", () => {
    assert.ok(withValues({ fullName: "J" }).fullName);
    assert.equal(withValues({ fullName: "Jo" }).fullName, undefined);
  });

  test("surrounding whitespace does not make a valid name invalid", () => {
    assert.equal(withValues({ fullName: "  Jane Smith  " }).fullName, undefined);
  });
});

describe("the email is required and validated", () => {
  test("blank cannot progress", () => {
    assert.ok(withValues({ email: "" }).email);
  });

  test("malformed cannot progress", () => {
    for (const email of [
      "jane",
      "jane@",
      "@example.com",
      "jane@example",
      "jane smith@example.com",
      "jane@@example.com",
    ]) {
      assert.ok(withValues({ email }).email, `${email} must be rejected`);
    }
  });

  test("it uses the shared implementation, so odd casing still passes", () => {
    assert.equal(withValues({ email: "  Jane@Example.CO.UK " }).email, undefined);
  });
});

describe("the mobile is required and validated", () => {
  test("blank cannot progress", () => {
    assert.ok(withValues({ phone: "" }).phone);
  });

  test("whitespace only cannot progress", () => {
    assert.ok(withValues({ phone: "   " }).phone);
  });

  test("malformed cannot progress", () => {
    for (const phone of ["0770", "077009001234", "07700 SEVEN", "+12125550123"]) {
      assert.ok(withValues({ phone }).phone, `${phone} must be rejected`);
    }
  });

  test("a landline is refused, as the field asks for a mobile", () => {
    assert.ok(withValues({ phone: "01902123456" }).phone);
  });

  test("the message explains what is wrong", () => {
    assert.match(withValues({ phone: "" }).phone!, /enter a mobile number/i);
    assert.match(withValues({ phone: "0770" }).phone!, /too short/i);
  });
});

describe("the optional tenant phone", () => {
  test("blank is fine, because it is optional", () => {
    assert.equal(withValues({ tenantPhone: "" }).tenantPhone, undefined);
    assert.equal(withValues({ tenantPhone: undefined }).tenantPhone, undefined);
  });

  test("but a supplied one is held to the same standard", () => {
    assert.ok(withValues({ tenantPhone: "01902123456" }).tenantPhone);
    assert.equal(withValues({ tenantPhone: "07700 900999" }).tenantPhone, undefined);
  });
});

describe("the address fields are still required", () => {
  test("a missing house number cannot progress", () => {
    assert.ok(withValues({ houseOrName: "" }).houseOrName);
    assert.ok(withValues({ houseOrName: "  " }).houseOrName);
  });

  test("a missing street cannot progress", () => {
    assert.ok(withValues({ street: "" }).street);
  });

  test("a malformed postcode cannot progress", () => {
    for (const postcode of ["", "ZZZ", "12345", "WV"]) {
      assert.ok(withValues({ postcode }).postcode, `${postcode} must be rejected`);
    }
  });

  test("a well-formed postcode passes the shape check however it is typed", () => {
    for (const postcode of ["wv1 1aa", "WV11AA", " WV1  1AA "]) {
      assert.equal(withValues({ postcode }).postcode, undefined, postcode);
    }
  });
});

describe("customer type and appliance count", () => {
  test("only the allowed customer types pass", () => {
    for (const customerType of ["landlord", "letting-agent", "tenant", "homeowner"]) {
      assert.equal(withValues({ customerType }).customerType, undefined);
    }
    for (const customerType of ["", "owner", "LANDLORD", "other"]) {
      assert.ok(withValues({ customerType }).customerType, customerType);
    }
  });

  test("the appliance count must be a whole number of at least one", () => {
    assert.ok(withValues({ applianceCount: 0 }).applianceCount);
    assert.ok(withValues({ applianceCount: 2.5 }).applianceCount);
    assert.equal(withValues({ applianceCount: 1 }).applianceCount, undefined);
  });
});

describe("THE PRODUCTION BUG: a valid address with blank contact details", () => {
  /** Exactly the state a customer reached on the deployed site. */
  const addressOnly = {
    ...VALID,
    fullName: "",
    email: "",
    phone: "",
  };

  test("it cannot progress to review", () => {
    const errors = validateDetails(addressOnly);
    assert.equal(hasErrors(errors), true);
  });

  test("all three missing fields are reported, not just the first", () => {
    const errors = validateDetails(addressOnly);
    assert.ok(errors.fullName);
    assert.ok(errors.email);
    assert.ok(errors.phone);
  });

  test("the valid address is not reported as a problem", () => {
    const errors = validateDetails(addressOnly);
    assert.equal(errors.postcode, undefined);
    assert.equal(errors.houseOrName, undefined);
    assert.equal(errors.street, undefined);
  });

  test("focus goes to the name, the first thing on screen to fix", () => {
    assert.equal(firstInvalidField(validateDetails(addressOnly)), "fullName");
  });

  test("the server would have refused it too", () => {
    // The server was never the weak point — it just refused too late.
    const result = bookingSchema.safeParse({
      ...addressOnly,
      slotStart: "2026-08-27T18:00:00.000Z",
      addressConfirmedByCustomer: true,
      termsAccepted: true,
      termsVersion: "2026-08-24",
      idempotencyKey: "abcdefgh1234",
    });
    assert.equal(result.success, false);
  });
});

describe("focus order follows the form", () => {
  test("the first invalid field on screen is the one chosen", () => {
    assert.equal(
      firstInvalidField(withValues({ fullName: "", email: "", phone: "" })),
      "fullName",
    );
    assert.equal(firstInvalidField(withValues({ email: "", phone: "" })), "email");
    assert.equal(firstInvalidField(withValues({ phone: "" })), "phone");
    assert.equal(firstInvalidField(withValues({ street: "" })), "street");
  });

  test("every field in the order has an input to focus", () => {
    const form = readFileSync(
      path.resolve(process.cwd(), "src/components/booking/DetailsForm.tsx"),
      "utf8",
    );
    const address = readFileSync(
      path.resolve(process.cwd(), "src/components/booking/AddressFields.tsx"),
      "utf8",
    );
    const phone = readFileSync(
      path.resolve(process.cwd(), "src/components/booking/PhoneField.tsx"),
      "utf8",
    );
    const markup = form + address + phone;

    for (const field of DETAILS_FIELD_ORDER) {
      const rendered =
        markup.includes(`id="${field}"`) || markup.includes(`id={id}`);
      assert.ok(rendered, `no element carries id="${field}" to focus`);
    }
  });
});

describe("the client and the server agree on what is required", () => {
  /**
   * The point of the fix: anything the server rejects must be caught here
   * first, so the customer never gets as far as Review with it.
   */
  const serverPayload = (overrides: Record<string, unknown>) => ({
    slotStart: "2026-08-27T18:00:00.000Z",
    fullName: VALID.fullName,
    email: VALID.email,
    phone: VALID.phone,
    houseOrName: VALID.houseOrName,
    street: VALID.street,
    postcode: VALID.postcode,
    customerType: VALID.customerType,
    applianceCount: VALID.applianceCount,
    addressConfirmedByCustomer: true,
    termsAccepted: true,
    termsVersion: "2026-08-24",
    idempotencyKey: "abcdefgh1234",
    ...overrides,
  });

  const cases: Record<string, unknown>[] = [
    { fullName: "" },
    { fullName: "   " },
    { fullName: "J" },
    { email: "" },
    { email: "not-an-email" },
    { phone: "" },
    { phone: "01902123456" },
    { houseOrName: "" },
    { street: "" },
    { postcode: "ZZZ" },
    { customerType: "other" },
  ];

  for (const overrides of cases) {
    const label = JSON.stringify(overrides);
    test(`both reject ${label}`, () => {
      const client = validateDetails({ ...VALID, ...overrides } as typeof VALID);
      assert.equal(hasErrors(client), true, `client accepted ${label}`);

      const server = bookingSchema.safeParse(serverPayload(overrides));
      assert.equal(server.success, false, `server accepted ${label}`);
    });
  }

  test("and both accept a complete submission", () => {
    assert.equal(hasErrors(validateDetails(VALID)), false);
    assert.equal(bookingSchema.safeParse(serverPayload({})).success, true);
  });
});
