import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildPropertyAddress,
  comparable,
  formatAddress,
  formatAddressLines,
  looksLikePostcode,
  normaliseLine,
  normalisePostcode,
} from "./format";
import { haversineMiles, isValidCoordinates } from "./geo";
import { checkServiceArea } from "./service-area";
import {
  FakePostcodeProvider,
  IN_AREA_POSTCODE,
  NO_COORDINATES_POSTCODE,
  OUT_OF_AREA_POSTCODE,
} from "./fakes";

/**
 * No test here contacts a live provider. The postcode service is free public
 * infrastructure and running the suite against it would be an abuse of it.
 */

/** The configured operating centre, passed explicitly so tests are hermetic. */
const CENTRE = { latitude: 52.594, longitude: -2.145 };
const RADIUS = 12;

const area = (postcode: { latitude: number | null; longitude: number | null }) =>
  checkServiceArea(postcode, { centre: CENTRE, radiusMiles: RADIUS });

describe("postcode normalisation", () => {
  test("uppercases and inserts the missing space", () => {
    assert.equal(normalisePostcode("wv11aa"), "WV1 1AA");
  });

  test("accepts a postcode already spaced", () => {
    assert.equal(normalisePostcode("WV1 1AA"), "WV1 1AA");
  });

  test("tolerates messy whitespace and casing", () => {
    assert.equal(normalisePostcode("  wV1   1aA "), "WV1 1AA");
  });

  test("handles the shortest and longest UK formats", () => {
    assert.equal(normalisePostcode("m11ae"), "M1 1AE");
    assert.equal(normalisePostcode("ec1a1bb"), "EC1A 1BB");
  });

  test("recognises well-formed postcodes", () => {
    for (const value of ["WV1 1AA", "wv11aa", "B3 3HN", "EC1A 1BB"]) {
      assert.ok(looksLikePostcode(value), `${value} should look valid`);
    }
  });

  test("rejects obvious nonsense without a lookup", () => {
    for (const value of ["", "ZZZ", "12345", "hello there"]) {
      assert.ok(!looksLikePostcode(value), `${value} should not look valid`);
    }
  });
});

describe("postcode lookup", () => {
  let provider: FakePostcodeProvider;
  beforeEach(() => {
    provider = new FakePostcodeProvider([
      IN_AREA_POSTCODE,
      OUT_OF_AREA_POSTCODE,
      NO_COORDINATES_POSTCODE,
    ]);
  });

  test("a known postcode returns canonical data with coordinates", async () => {
    const result = await provider.lookup("wv991aa");
    assert.equal(result.status, "valid");
    if (result.status === "valid") {
      assert.equal(result.postcode.postcode, "WV99 1AA");
      assert.equal(result.postcode.areaName, "Wolverhampton");
      assert.equal(typeof result.postcode.latitude, "number");
      assert.equal(typeof result.postcode.longitude, "number");
    }
  });

  test("the canonical form is used, not what the customer typed", async () => {
    const result = await provider.lookup("  wv99   1aa ");
    assert.equal(result.status === "valid" && result.postcode.postcode, "WV99 1AA");
  });

  test("an unknown postcode is not found", async () => {
    assert.equal((await provider.lookup("WV99 8XX")).status, "not_found");
  });

  test("nonsense is reported as malformed, not as not found", async () => {
    assert.equal((await provider.lookup("banana")).status, "malformed");
  });

  test("a provider outage is distinct from an invalid postcode", async () => {
    provider.setUnavailable(true);
    const result = await provider.lookup("wv991aa");
    assert.equal(result.status, "provider_unavailable");
    // The two must never be conflated: one is the customer's problem, the
    // other is ours.
    assert.notEqual(result.status, "not_found");
  });
});

describe("haversine distance", () => {
  test("a point measured against itself is zero", () => {
    assert.equal(haversineMiles(CENTRE, CENTRE), 0);
  });

  test("a known separation is calculated correctly", () => {
    // Wolverhampton to Birmingham city centre is about 13 miles as the crow
    // flies; allow a little slack for the exact reference points.
    const miles = haversineMiles(CENTRE, {
      latitude: 52.4796,
      longitude: -1.9027,
    });
    assert.ok(miles > 11 && miles < 15, `expected roughly 13 miles, got ${miles}`);
  });

  test("distance is symmetrical", () => {
    const a = { latitude: 52.6, longitude: -2.12 };
    assert.equal(
      haversineMiles(CENTRE, a).toFixed(9),
      haversineMiles(a, CENTRE).toFixed(9),
    );
  });

  test("a degree of latitude is about 69 miles", () => {
    const miles = haversineMiles(
      { latitude: 52, longitude: -2 },
      { latitude: 53, longitude: -2 },
    );
    assert.ok(miles > 68 && miles < 70, `got ${miles}`);
  });

  test("coordinates are validated before use", () => {
    assert.ok(isValidCoordinates({ latitude: 52.5, longitude: -2.1 }));
    assert.ok(!isValidCoordinates({ latitude: null, longitude: -2.1 }));
    assert.ok(!isValidCoordinates({ latitude: 52.5, longitude: null }));
    assert.ok(!isValidCoordinates(null));
    assert.ok(!isValidCoordinates(undefined));
    assert.ok(!isValidCoordinates({ latitude: Number.NaN, longitude: -2.1 }));
    assert.ok(!isValidCoordinates({ latitude: 91, longitude: -2.1 }));
    assert.ok(!isValidCoordinates({ latitude: 52.5, longitude: 181 }));
  });
});

describe("service area radius", () => {
  test("the operating centre itself is covered", () => {
    const result = area({ latitude: CENTRE.latitude, longitude: CENTRE.longitude });
    assert.equal(result.covered, true);
    assert.equal(result.covered && Math.round(result.distanceMiles), 0);
  });

  test("a property well inside the radius is covered", () => {
    const result = area(IN_AREA_POSTCODE);
    assert.equal(result.covered, true);
  });

  test("a property well outside the radius is not covered", () => {
    const result = area(OUT_OF_AREA_POSTCODE);
    assert.equal(result.covered, false);
    assert.equal(result.covered === false && result.reason, "outside_radius");
  });

  test("just inside the boundary is covered", () => {
    // 11.9 miles due north: one degree of latitude is about 69 miles.
    const justInside = {
      latitude: CENTRE.latitude + 11.9 / 69.0,
      longitude: CENTRE.longitude,
    };
    const result = area(justInside);
    assert.equal(result.covered, true);
    assert.ok(result.covered && result.distanceMiles < RADIUS);
  });

  test("just outside the boundary is not covered", () => {
    const justOutside = {
      latitude: CENTRE.latitude + 12.1 / 69.0,
      longitude: CENTRE.longitude,
    };
    const result = area(justOutside);
    assert.equal(result.covered, false);
    assert.ok(!result.covered && (result.distanceMiles ?? 0) > RADIUS);
  });

  test("exactly on the boundary is covered", () => {
    // The rule is "within 12 miles", so the boundary itself counts as inside.
    const onBoundary = {
      latitude: CENTRE.latitude,
      longitude: CENTRE.longitude,
    };
    const result = checkServiceArea(onBoundary, {
      centre: CENTRE,
      radiusMiles: 0,
    });
    assert.equal(result.covered, true);
  });

  test("a postcode without coordinates is never waved through", () => {
    const result = area(NO_COORDINATES_POSTCODE);
    assert.equal(result.covered, false);
    assert.equal(result.covered === false && result.reason, "no_coordinates");
    assert.equal(result.distanceMiles, null);
  });

  test("the radius is configurable", () => {
    const far = { latitude: 52.4796, longitude: -1.9027 };
    assert.equal(
      checkServiceArea(far, { centre: CENTRE, radiusMiles: 5 }).covered,
      false,
    );
    assert.equal(
      checkServiceArea(far, { centre: CENTRE, radiusMiles: 50 }).covered,
      true,
    );
  });

  test("a valid postcode outside the area is still a valid postcode", () => {
    // Coverage and validity are separate ideas and must stay that way.
    const result = area(OUT_OF_AREA_POSTCODE);
    assert.equal(result.covered, false);
    assert.equal(OUT_OF_AREA_POSTCODE.postcode, "WV99 9ZZ");
  });
});

describe("address formatting is done in one place", () => {
  test("assembles a readable single line", () => {
    assert.equal(
      formatAddress({
        houseOrName: "24",
        street: "Example Road",
        town: "Wolverhampton",
        postcode: "wv11aa",
      }),
      "24 Example Road, Wolverhampton, WV1 1AA",
    );
  });

  test("tidies messy input rather than repeating it", () => {
    assert.equal(
      formatAddress({
        houseOrName: "  24 ",
        street: "  Example   Road ",
        town: " Wolverhampton ",
        postcode: " wv1 1aa ",
      }),
      "24 Example Road, Wolverhampton, WV1 1AA",
    );
  });

  test("produces the same lines everywhere the address appears", () => {
    const address = buildPropertyAddress({
      houseOrName: "24",
      street: "Example Road",
      postcode: IN_AREA_POSTCODE,
      confirmedByCustomer: true,
    });
    assert.deepEqual(formatAddressLines(address), [
      "24 Example Road",
      "Wolverhampton",
      "WV99 1AA",
    ]);
    assert.equal(
      address.formattedAddress,
      "24 Example Road, Wolverhampton, WV99 1AA",
    );
  });

  test("the town comes from the postcode, not from typing", () => {
    const address = buildPropertyAddress({
      houseOrName: "24",
      street: "Example Road",
      postcode: IN_AREA_POSTCODE,
      confirmedByCustomer: true,
    });
    assert.equal(address.town, "Wolverhampton");
  });

  test("the canonical postcode and the confirmation are recorded", () => {
    const address = buildPropertyAddress({
      houseOrName: "24",
      street: "Example Road",
      postcode: IN_AREA_POSTCODE,
      confirmedByCustomer: true,
    });
    assert.equal(address.postcode, "WV99 1AA");
    assert.equal(address.postcodeValidated, true);
    assert.equal(address.confirmedByCustomer, true);
    assert.equal(address.latitude, IN_AREA_POSTCODE.latitude);
  });

  test("a validated postcode never implies the house exists", () => {
    const address = buildPropertyAddress({
      houseOrName: "24",
      street: "Example Road",
      postcode: IN_AREA_POSTCODE,
      confirmedByCustomer: false,
    });
    // postcodeValidated is about the postcode only. The customer's own
    // confirmation is the separate, and only, check on the property itself.
    assert.equal(address.postcodeValidated, true);
    assert.equal(address.confirmedByCustomer, false);
  });

  test("control characters cannot survive into an address", () => {
    const dirty = normaliseLine("24\u0000 Example\u001f Road");
    assert.ok(!/[\u0000-\u001f]/.test(dirty));
    assert.equal(dirty, "24 Example Road");
  });

  test("comparison form ignores case and punctuation", () => {
    assert.equal(comparable("St. Mark's Road"), "st marks road");
  });
});
