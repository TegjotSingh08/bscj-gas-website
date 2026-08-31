import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PRODUCT_ID,
  isProductId,
  PRODUCT_IDS,
  productFor,
  productList,
  products,
} from "./products";
import { bundleSavingFor } from "./products";
import { calculatePrice, MAX_APPLIANCES } from "./pricing";
import { blockMinutesFor, bookingConfig, bookingConfigFor } from "./config";
import { bookingSchema } from "./schema";
import { TERMS_VERSION } from "./terms";

/**
 * The registry is the whole safety argument for a second product: the browser
 * names a service, and every figure that follows — price, appliance rate,
 * appointment length — is read here rather than off the request.
 */
describe("the product registry", () => {
  test("holds exactly the three confirmed services", () => {
    assert.deepEqual(
      [...PRODUCT_IDS],
      ["cp12", "boiler-service", "cp12-boiler-service"],
    );
    assert.equal(productList.length, 3);
  });

  test("the standalone boiler service is £60, and outside the appliance rule", () => {
    const service = products["boiler-service"];
    assert.equal(service.name, "Annual Boiler Service");
    assert.equal(service.price, 60);
    assert.equal(service.durationMinutes, 60);
    assert.equal(service.appliancePricing, false);
    assert.equal(service.extraAppliancePrice, 0);
  });

  test("the CP12 is the default, and is unchanged", () => {
    assert.equal(DEFAULT_PRODUCT_ID, "cp12");
    const cp12 = products.cp12;
    assert.equal(cp12.price, 45);
    assert.equal(cp12.durationMinutes, 45);
    assert.equal(cp12.extraAppliancePrice, 15);
    assert.equal(cp12.includes, "one boiler and two additional appliances");
  });

  test("the bundle is £90 for sixty minutes", () => {
    const bundle = products["cp12-boiler-service"];
    assert.equal(bundle.name, "CP12 + Annual Boiler Service");
    assert.equal(bundle.price, 90);
    assert.equal(bundle.durationMinutes, 60);
    assert.equal(bundle.extraAppliancePrice, 15);
  });

  test("the CP12 is offered first", () => {
    // It is the entry product: someone who came for a certificate should meet
    // the certificate before the upsell.
    assert.equal(productList[0].id, "cp12");
  });

  test("every product is internally consistent", () => {
    for (const product of productList) {
      assert.equal(product.priceDisplay, `£${product.price}`);
      assert.equal(product.priceTotalDisplay, `£${product.price} total`);
      assert.equal(product.extraApplianceDisplay, `£${product.extraAppliancePrice}`);
      assert.ok(product.name.length > 0);
      assert.ok(product.subjectName.length > 0);
      assert.ok(product.calendarName.length > 0);
      assert.ok(product.workDescription.length > 0);
      assert.ok(product.durationMinutes > 0);
    }
  });

  test("every product is distinguishable everywhere it is named", () => {
    // A shared label anywhere would make a booking ambiguous on screen, in
    // the diary or in an email.
    for (const field of [
      "name",
      "subjectName",
      "calendarName",
      "workDescription",
      "tagline",
    ] as const) {
      const values = productList.map((product) => product[field]);
      assert.equal(
        new Set(values).size,
        productList.length,
        `two products share a ${field}`,
      );
    }
  });
});

describe("an unrecognised product is never honoured", () => {
  test("isProductId accepts only the registry's own ids", () => {
    assert.equal(isProductId("cp12"), true);
    assert.equal(isProductId("cp12-boiler-service"), true);

    for (const value of [
      "cp12-free",
      "CP12",
      "",
      " cp12",
      "cp12 ",
      null,
      undefined,
      42,
      {},
      ["cp12"],
      true,
    ]) {
      assert.equal(isProductId(value), false, `accepted ${String(value)}`);
    }
  });

  test("productFor falls back to the CP12 rather than to nothing", () => {
    // Total by design: routes refuse an unknown id before this is reached, so
    // this exists to keep the type honest, never to forgive a bad request.
    assert.equal(productFor("nonsense").id, "cp12");
    assert.equal(productFor(undefined).id, "cp12");
    assert.equal(productFor(null).id, "cp12");
    assert.equal(productFor("cp12-boiler-service").id, "cp12-boiler-service");
  });

  test("the booking schema refuses an id outside the registry", () => {
    const valid = {
      slotStart: "2026-08-19T17:00:00.000Z",
      fullName: "Jane Smith",
      email: "jane@example.co.uk",
      phone: "07700 900123",
      houseOrName: "24",
      street: "Example Road",
      postcode: "wv1 1aa",
      addressConfirmedByCustomer: true,
      customerType: "landlord",
      applianceCount: 3,
      termsAccepted: true,
      termsVersion: TERMS_VERSION,
      idempotencyKey: "abcdefgh1234",
    };

    assert.equal(bookingSchema.safeParse(valid).success, true);
    assert.equal(
      bookingSchema.safeParse({ ...valid, productId: "cp12-boiler-service" })
        .success,
      true,
    );

    for (const productId of ["cp12-free", "", 1, null, ["cp12"]]) {
      assert.equal(
        bookingSchema.safeParse({ ...valid, productId }).success,
        false,
        `accepted ${JSON.stringify(productId)}`,
      );
    }
  });

  test("omitting the product books the CP12", () => {
    const parsed = bookingSchema.safeParse({
      slotStart: "2026-08-19T17:00:00.000Z",
      fullName: "Jane Smith",
      email: "jane@example.co.uk",
      phone: "07700 900123",
      houseOrName: "24",
      street: "Example Road",
      postcode: "wv1 1aa",
      addressConfirmedByCustomer: true,
      customerType: "landlord",
      applianceCount: 3,
      termsAccepted: true,
      termsVersion: TERMS_VERSION,
      idempotencyKey: "abcdefgh1234",
    });
    assert.equal(parsed.success, true);
    if (parsed.success) assert.equal(parsed.data.productId, "cp12");
  });

  test("no submitted price or duration is even read off a booking", () => {
    // The schema is the only door into the route, and it has no field for
    // either — so there is nothing to trust or to have to ignore.
    const shape = Object.keys(bookingSchema.shape);
    for (const forbidden of [
      "price",
      "priceTotal",
      "basePrice",
      "total",
      "durationMinutes",
      "appointmentMinutes",
      "slotEnd",
    ]) {
      assert.equal(shape.includes(forbidden), false, `${forbidden} is accepted`);
    }
  });
});

describe("pricing is derived per product", () => {
  test("the CP12 prices exactly as it always has", () => {
    assert.equal(calculatePrice(1).total, 45);
    assert.equal(calculatePrice(3).total, 45);
    assert.equal(calculatePrice(4).total, 60);
    assert.equal(calculatePrice(5).total, 75);
  });

  test("the bundle starts at £90 and adds £15 an appliance", () => {
    const bundle = "cp12-boiler-service" as const;
    assert.equal(calculatePrice(1, bundle).total, 90);
    assert.equal(calculatePrice(3, bundle).total, 90);
    assert.equal(calculatePrice(4, bundle).total, 105);
    assert.equal(calculatePrice(5, bundle).total, 120);
  });

  test("the standalone service is £60 whatever the appliance count says", () => {
    // The certificate's appliance rule does not reach it. Every count, and
    // every abusive count, still costs sixty pounds.
    for (const count of [1, 3, 4, 5, 12, 99, 0, -3, 2.7]) {
      const price = calculatePrice(count, "boiler-service");
      assert.equal(price.total, 60, `appliance count ${count} changed the price`);
      assert.equal(price.extraAppliances, 0);
      assert.equal(price.extraCharge, 0);
    }
  });

  test("the included-appliance rule is shared by the certificate products", () => {
    // Three included on both, and the difference between them is only ever
    // the base — so the two can never drift apart on appliances.
    for (const { id } of productList.filter((p) => p.appliancePricing)) {
      assert.equal(calculatePrice(3, id).extraAppliances, 0);
      assert.equal(calculatePrice(4, id).extraAppliances, 1);
      assert.equal(
        calculatePrice(4, id).total - calculatePrice(3, id).total,
        15,
      );
    }
  });

  test("only the products that include a certificate price by appliance", () => {
    assert.deepEqual(
      productList.filter((p) => p.appliancePricing).map((p) => p.id),
      ["cp12", "cp12-boiler-service"],
    );
  });

  test("the breakdown names the product it priced", () => {
    const price = calculatePrice(4, "cp12-boiler-service");
    assert.equal(price.productId, "cp12-boiler-service");
    assert.equal(price.productName, "CP12 + Annual Boiler Service");
    assert.equal(price.basePrice, 90);
    assert.equal(price.extraCharge, 15);
    assert.equal(price.totalDisplay, "£105 total");
  });

  test("out-of-range counts are clamped on either product", () => {
    for (const { id } of productList) {
      assert.equal(calculatePrice(0, id).applianceCount, 1);
      assert.equal(calculatePrice(-5, id).applianceCount, 1);
      assert.equal(calculatePrice(999, id).applianceCount, MAX_APPLIANCES);
      assert.equal(calculatePrice(2.7, id).applianceCount, 2);
    }
  });

  test("an unknown product cannot conjure a price of its own", () => {
    assert.equal(
      calculatePrice(3, "cp12-free" as never).total,
      45,
      "an unrecognised id must fall back, never invent",
    );
  });
});

describe("the booking configuration follows the product", () => {
  test("the bare export is still the CP12's", () => {
    assert.equal(bookingConfig.appointmentMinutes, 45);
    assert.deepEqual(bookingConfig, bookingConfigFor("cp12"));
    assert.deepEqual(bookingConfig, bookingConfigFor());
  });

  test("only the appointment length varies between products", () => {
    const cp12 = bookingConfigFor("cp12");
    const bundle = bookingConfigFor("cp12-boiler-service");

    assert.equal(cp12.appointmentMinutes, 45);
    assert.equal(bundle.appointmentMinutes, 60);

    assert.deepEqual(
      { ...cp12, appointmentMinutes: 0 },
      { ...bundle, appointmentMinutes: 0 },
    );
  });

  test("the buffer is the same fifteen minutes for both", () => {
    for (const { id } of productList) {
      assert.equal(bookingConfigFor(id).bufferMinutes, 15);
    }
  });

  test("the block a booking occupies is its appointment plus the buffer", () => {
    assert.equal(blockMinutesFor(bookingConfigFor("cp12")), 60);
    assert.equal(blockMinutesFor(bookingConfigFor("cp12-boiler-service")), 75);
  });
});


/**
 * The saving the bundle is allowed to advertise.
 *
 * It is only sayable because both halves are themselves published, bookable
 * prices. Derived from those, so the figure on the page can never drift from
 * the arithmetic — and so a change to any of the three prices moves the claim
 * with it rather than leaving a lie behind.
 */
describe("the advertised bundle saving is arithmetic on real prices", () => {
  test("£45 and £60 separately, £90 together, £15 saved", () => {
    const saving = bundleSavingFor("cp12-boiler-service");
    assert.ok(saving, "the bundle should report a saving");

    assert.equal(saving.separateTotal, 105);
    assert.equal(saving.bundlePrice, 90);
    assert.equal(saving.saving, 15);
    assert.equal(saving.savingDisplay, "£15");
    assert.equal(saving.separateTotalDisplay, "£105");
  });

  test("it is computed from the components, not written down", () => {
    const saving = bundleSavingFor("cp12-boiler-service");
    assert.ok(saving);

    const components = products["cp12-boiler-service"].componentIds ?? [];
    assert.deepEqual([...components], ["cp12", "boiler-service"]);
    assert.equal(
      saving.separateTotal,
      components.reduce((total, id) => total + products[id].price, 0),
    );
    assert.equal(
      saving.saving,
      saving.separateTotal - products["cp12-boiler-service"].price,
    );
  });

  test("both halves of the comparison are genuinely bookable", () => {
    // The whole justification for saying "save £15" is that a customer could
    // instead book these two, at these prices, today.
    for (const id of products["cp12-boiler-service"].componentIds ?? []) {
      assert.ok(PRODUCT_IDS.includes(id), `${id} is not a bookable product`);
      assert.ok(products[id].price > 0);
    }
  });

  test("a product that is not a bundle claims no saving", () => {
    assert.equal(bundleSavingFor("cp12"), null);
    assert.equal(bundleSavingFor("boiler-service"), null);
  });
});
