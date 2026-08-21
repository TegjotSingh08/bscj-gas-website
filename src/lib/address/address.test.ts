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
import {
  bestMatch,
  classifyMatch,
  expandStreet,
  houseNumbersMatch,
  isHouseNumber,
  outcodesMatch,
  postcodesMatch,
  streetsMatch,
} from "./match";
import {
  checkServiceArea,
  isWithinServiceArea,
  outcodeOf,
  SERVICE_AREA_OUTCODES,
} from "./service-area";
import {
  DEFAULT_POSTCODE,
  FakeAddressVerificationProvider,
  FakePostcodeProvider,
  OUT_OF_AREA_POSTCODE,
} from "./fakes";

/**
 * Nothing here touches a live provider. Postcodes.io and the public Nominatim
 * service are both free, donated infrastructure, and Nominatim's usage policy
 * explicitly forbids automated testing against it.
 */

describe("postcode normalisation", () => {
  test("uppercases and inserts the missing space", () => {
    assert.equal(normalisePostcode("wv60ar"), "WV6 0AR");
  });

  test("accepts a postcode already spaced", () => {
    assert.equal(normalisePostcode("WV6 0AR"), "WV6 0AR");
  });

  test("tolerates messy whitespace and casing", () => {
    assert.equal(normalisePostcode("  wV6   0aR "), "WV6 0AR");
  });

  test("handles the shortest and longest UK formats", () => {
    assert.equal(normalisePostcode("m11ae"), "M1 1AE");
    assert.equal(normalisePostcode("ec1a1bb"), "EC1A 1BB");
  });

  test("recognises well-formed postcodes", () => {
    for (const value of ["WV6 0AR", "wv60ar", "B1 1AA", "EC1A 1BB"]) {
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
    provider = new FakePostcodeProvider([DEFAULT_POSTCODE, OUT_OF_AREA_POSTCODE]);
  });

  test("a known postcode returns canonical data", async () => {
    const result = await provider.lookup("wv60ar");
    assert.equal(result.status, "valid");
    if (result.status === "valid") {
      assert.equal(result.postcode.postcode, "WV6 0AR");
      assert.equal(result.postcode.outcode, "WV6");
      assert.equal(result.postcode.areaName, "Wolverhampton");
      assert.equal(typeof result.postcode.latitude, "number");
      assert.equal(typeof result.postcode.longitude, "number");
    }
  });

  test("the canonical form is used, not what the customer typed", async () => {
    const result = await provider.lookup("  wv6   0ar ");
    assert.equal(result.status === "valid" && result.postcode.postcode, "WV6 0AR");
  });

  test("an unknown postcode is not found", async () => {
    assert.equal((await provider.lookup("WV6 9ZZ")).status, "not_found");
  });

  test("nonsense is reported as malformed, not as not found", async () => {
    assert.equal((await provider.lookup("banana")).status, "malformed");
  });

  test("a provider outage is distinct from an invalid postcode", async () => {
    provider.setUnavailable(true);
    const result = await provider.lookup("wv60ar");
    assert.equal(result.status, "provider_unavailable");
    assert.notEqual(result.status, "not_found");
  });
});

describe("service area", () => {
  test("the four named towns are covered", () => {
    for (const outcode of ["WV1", "WV6", "WV10", "WV11", "WV12", "WV13", "WV14"]) {
      assert.ok(isWithinServiceArea(outcode), `${outcode} should be covered`);
    }
  });

  test("WV postcodes outside the named towns are not covered", () => {
    // Albrighton, Codsall, Coven and Bridgnorth share the prefix only.
    for (const outcode of ["WV7", "WV8", "WV9", "WV15", "WV16"]) {
      assert.ok(!isWithinServiceArea(outcode), `${outcode} should not be covered`);
    }
  });

  test("other cities are not covered", () => {
    for (const outcode of ["B1", "M1", "SW1A", "DY1"]) {
      assert.ok(!isWithinServiceArea(outcode));
    }
  });

  test("the check is case and whitespace tolerant", () => {
    assert.ok(isWithinServiceArea(" wv6 "));
  });

  test("a valid postcode outside the area is still a valid postcode", () => {
    const area = checkServiceArea(OUT_OF_AREA_POSTCODE.outcode);
    assert.equal(area.covered, false);
    // The two ideas stay separate: nothing here says the postcode is wrong.
    assert.equal(area.covered === false && area.reason, "outside_area");
  });

  test("the outcode is derived from the canonical postcode", () => {
    assert.equal(outcodeOf("wv60ar"), "WV6");
    assert.equal(outcodeOf("EC1A 1BB"), "EC1A");
  });

  test("the configured list is not accidentally empty", () => {
    assert.ok(SERVICE_AREA_OUTCODES.length >= 7);
  });
});

describe("street comparison", () => {
  test("expands the Royal Mail abbreviations", () => {
    assert.equal(expandStreet("Sweetman St"), "sweetman street");
    assert.equal(expandStreet("Tettenhall Rd"), "tettenhall road");
    assert.equal(expandStreet("Oak Cl"), "oak close");
  });

  test("matches across casing, punctuation and abbreviation", () => {
    assert.ok(streetsMatch("Sweetman Street", "sweetman st"));
    assert.ok(streetsMatch("St. Mark's Road", "St Marks Road"));
  });

  test("does not match a different street", () => {
    assert.ok(!streetsMatch("Sweetman Street", "Sweetbriar Street"));
    assert.ok(!streetsMatch("Sweetman Street", "Sweetman Avenue"));
  });

  test("an empty side never matches", () => {
    assert.ok(!streetsMatch("", "Sweetman Street"));
    assert.ok(!streetsMatch("Sweetman Street", ""));
  });

  test("house numbers compare exactly, including letter suffixes", () => {
    assert.ok(houseNumbersMatch("197", "197"));
    assert.ok(houseNumbersMatch("12a", "12A"));
    assert.ok(!houseNumbersMatch("197", "179"));
  });

  test("a number is distinguished from a property name", () => {
    assert.ok(isHouseNumber("197"));
    assert.ok(isHouseNumber("12a"));
    assert.ok(!isHouseNumber("Rose Cottage"));
  });

  test("postcodes compare canonically", () => {
    assert.ok(postcodesMatch("wv60ar", "WV6 0AR"));
    assert.ok(!postcodesMatch("WV6 0AR", "WV6 0AS"));
  });

  test("districts compare on the outward code only", () => {
    assert.ok(outcodesMatch("WV6 0AR", "WV6 0AA"));
    assert.ok(!outcodesMatch("WV6 0AR", "WV11 1AA"));
    assert.ok(!outcodesMatch("WV6 0AR", "B1 1AA"));
  });
});

describe("match classification", () => {
  const entered = {
    enteredHouseOrName: "197",
    enteredStreet: "Sweetman Street",
    enteredPostcode: "WV6 0AR",
  };

  test("street, postcode and house number all agreeing is verified", () => {
    assert.equal(
      classifyMatch({
        ...entered,
        returnedStreet: "Sweetman Street",
        returnedHouseNumber: "197",
        returnedPostcode: "WV6 0AR",
      }),
      "verified",
    );
  });

  test("a nearby postcode on the same street is a partial match", () => {
    // Open mapping data tags street segments with whichever postcode is
    // nearest, so the exact property postcode is usually absent. Real data for
    // Sweetman Street WV6 0AR comes back as WV6 0AA, WV6 0AX and WV6 0DN.
    assert.equal(
      classifyMatch({
        ...entered,
        returnedStreet: "Sweetman Street",
        returnedHouseNumber: null,
        returnedPostcode: "WV6 0AA",
      }),
      "partial_match",
    );
  });

  test("a different postcode district is never a match", () => {
    assert.equal(
      classifyMatch({
        ...entered,
        returnedStreet: "Sweetman Street",
        returnedHouseNumber: "197",
        returnedPostcode: "B1 1AA",
      }),
      "unverified",
    );
  });

  test("a missing returned postcode is unverified", () => {
    assert.equal(
      classifyMatch({
        ...entered,
        returnedStreet: "Sweetman Street",
        returnedHouseNumber: "197",
        returnedPostcode: null,
      }),
      "unverified",
    );
  });

  test("a different street is unverified", () => {
    assert.equal(
      classifyMatch({
        ...entered,
        returnedStreet: "Sweetbriar Street",
        returnedHouseNumber: "197",
        returnedPostcode: "WV6 0AR",
      }),
      "unverified",
    );
  });

  test("the street matching but the house number missing is a partial match", () => {
    // Open mapping data very often lacks individual house numbers.
    assert.equal(
      classifyMatch({
        ...entered,
        returnedStreet: "Sweetman Street",
        returnedHouseNumber: null,
        returnedPostcode: "WV6 0AR",
      }),
      "partial_match",
    );
  });

  test("the real Sweetman Street data grades as a partial match, not unverified", () => {
    // The exact response seen from the live service during implementation.
    const result = bestMatch(
      [
        { street: "Sweetman Street", houseNumber: null, postcode: "WV6 0AA" },
        { street: "Sweetman Street", houseNumber: null, postcode: "WV6 0AX" },
        { street: "Sweetman Street", houseNumber: null, postcode: "WV6 0DN" },
      ],
      { houseOrName: "197", street: "Sweetman Street", postcode: "WV6 0AR" },
    );
    assert.equal(result.status, "partial_match");
  });

  test("a misspelled street is still unverified", () => {
    const result = bestMatch(
      [{ street: "Sweetman Street", houseNumber: null, postcode: "WV6 0AA" }],
      { houseOrName: "197", street: "Sweetmun Streat", postcode: "WV6 0AR" },
    );
    assert.equal(result.status, "unverified");
  });

  test("a different house number on the right street is a partial match", () => {
    assert.equal(
      classifyMatch({
        ...entered,
        returnedStreet: "Sweetman Street",
        returnedHouseNumber: "195",
        returnedPostcode: "WV6 0AR",
      }),
      "partial_match",
    );
  });

  test("a named property can only ever reach a partial match", () => {
    // Names are recorded inconsistently, so claiming a full match would be
    // dishonest even when the street and postcode agree.
    assert.equal(
      classifyMatch({
        enteredHouseOrName: "Rose Cottage",
        enteredStreet: "Sweetman Street",
        enteredPostcode: "WV6 0AR",
        returnedStreet: "Sweetman Street",
        returnedHouseNumber: null,
        returnedPostcode: "WV6 0AR",
      }),
      "partial_match",
    );
  });

  test("the best of several candidates wins", () => {
    const result = bestMatch(
      [
        { street: "Sweetbriar Street", houseNumber: "1", postcode: "WV6 0AR" },
        { street: "Sweetman Street", houseNumber: "197", postcode: "WV6 0AR" },
      ],
      { houseOrName: "197", street: "Sweetman Street", postcode: "WV6 0AR" },
    );
    assert.equal(result.status, "verified");
    assert.equal(result.matchedHouseNumber, "197");
  });

  test("no candidates is unverified, not an error", () => {
    const result = bestMatch([], {
      houseOrName: "197",
      street: "Sweetman Street",
      postcode: "WV6 0AR",
    });
    assert.equal(result.status, "unverified");
  });
});

describe("address verification provider", () => {
  let provider: FakeAddressVerificationProvider;
  const address = {
    houseOrName: "197",
    street: "Sweetman Street",
    postcode: "WV6 0AR",
  };

  beforeEach(() => {
    provider = new FakeAddressVerificationProvider();
  });

  test("a strong match verifies", async () => {
    provider.setCandidates([
      { street: "Sweetman Street", houseNumber: "197", postcode: "WV6 0AR" },
    ]);
    assert.equal((await provider.verify(address)).status, "verified");
  });

  test("a result from another postcode district does not verify", async () => {
    provider.setCandidates([
      { street: "Sweetman Street", houseNumber: "197", postcode: "B1 1AA" },
    ]);
    assert.equal((await provider.verify(address)).status, "unverified");
  });

  test("a road mismatch does not verify", async () => {
    provider.setCandidates([
      { street: "Sweetbriar Street", houseNumber: "197", postcode: "WV6 0AR" },
    ]);
    assert.equal((await provider.verify(address)).status, "unverified");
  });

  test("a house number absent from the data is a partial match", async () => {
    provider.setCandidates([
      { street: "Sweetman Street", houseNumber: null, postcode: "WV6 0AR" },
    ]);
    assert.equal((await provider.verify(address)).status, "partial_match");
  });

  test("the exact postcode plus the house number is a full match", async () => {
    provider.setCandidates([
      { street: "Sweetman Street", houseNumber: "197", postcode: "WV6 0AR" },
    ]);
    assert.equal((await provider.verify(address)).status, "verified");
  });

  test("zero results is unverified, never a rejection", async () => {
    provider.setCandidates([]);
    const result = await provider.verify(address);
    assert.equal(result.status, "unverified");
    assert.notEqual(result.status, "unavailable");
  });

  test("an outage reports unavailable, distinct from unverified", async () => {
    provider.setUnavailable(true);
    assert.equal((await provider.verify(address)).status, "unavailable");
  });
});

describe("address formatting is done in one place", () => {
  test("assembles a readable single line", () => {
    assert.equal(
      formatAddress({
        houseOrName: "197",
        street: "Sweetman Street",
        town: "Wolverhampton",
        postcode: "wv60ar",
      }),
      "197 Sweetman Street, Wolverhampton, WV6 0AR",
    );
  });

  test("tidies messy input rather than repeating it", () => {
    assert.equal(
      formatAddress({
        houseOrName: "  197 ",
        street: "  Sweetman   Street ",
        town: " Wolverhampton ",
        postcode: " wv6 0ar ",
      }),
      "197 Sweetman Street, Wolverhampton, WV6 0AR",
    );
  });

  test("produces the same lines for the email and the calendar", () => {
    const address = buildPropertyAddress({
      houseOrName: "197",
      street: "Sweetman Street",
      postcode: DEFAULT_POSTCODE,
      verificationStatus: "verified",
      confirmedByCustomer: false,
    });
    assert.deepEqual(formatAddressLines(address), [
      "197 Sweetman Street",
      "Wolverhampton",
      "WV6 0AR",
    ]);
    assert.equal(
      address.formattedAddress,
      "197 Sweetman Street, Wolverhampton, WV6 0AR",
    );
  });

  test("the town comes from the postcode, not from typing", () => {
    const address = buildPropertyAddress({
      houseOrName: "197",
      street: "Sweetman Street",
      postcode: DEFAULT_POSTCODE,
      verificationStatus: "verified",
      confirmedByCustomer: false,
    });
    assert.equal(address.town, "Wolverhampton");
  });

  test("the canonical postcode is stored, not the typed one", () => {
    const address = buildPropertyAddress({
      houseOrName: "197",
      street: "Sweetman Street",
      postcode: DEFAULT_POSTCODE,
      verificationStatus: "partial_match",
      confirmedByCustomer: true,
    });
    assert.equal(address.postcode, "WV6 0AR");
    assert.equal(address.postcodeValidated, true);
    assert.equal(address.confirmedByCustomer, true);
  });

  test("control characters cannot survive into an address", () => {
    const dirty = normaliseLine("197\u0000 Sweetman\u001f Street");
    assert.ok(!/[\u0000-\u001f]/.test(dirty));
    assert.equal(dirty, "197 Sweetman Street");
  });

  test("comparison form ignores case and punctuation", () => {
    assert.equal(comparable("St. Mark's Road"), "st marks road");
  });
});
