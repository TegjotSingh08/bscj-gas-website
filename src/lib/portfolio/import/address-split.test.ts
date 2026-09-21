import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { describeAddressProblem, splitAddress } from "./address-split";

/**
 * Splitting one address cell.
 *
 * Fictional throughout. The stakes: `house_or_name` plus `postcode` is the key
 * the duplicate check compares on and the unique index enforces, so losing a
 * flat number merges two flats into one property and inventing one splits a
 * house into two.
 */

const ok = (value: string) => {
  const result = splitAddress(value);
  assert.ok(result.ok, `expected a split for: ${value}`);
  return result.value;
};

describe("the shapes an export actually carries", () => {
  test("a plain numbered house", () => {
    assert.deepEqual(ok("14 Example Street, Wolverhampton, WV1 1AA"), {
      houseOrName: "14",
      street: "Example Street",
      town: "Wolverhampton",
      postcode: "WV1 1AA",
    });
  });

  test("house number in its own part", () => {
    assert.deepEqual(ok("14, Example Street, Wolverhampton, WV1 1AA"), {
      houseOrName: "14",
      street: "Example Street",
      town: "Wolverhampton",
      postcode: "WV1 1AA",
    });
  });

  test("a named property needs no number", () => {
    assert.deepEqual(ok("Rose Cottage, Example Lane, Wolverhampton, WV1 1AA"), {
      houseOrName: "Rose Cottage",
      street: "Example Lane",
      town: "Wolverhampton",
      postcode: "WV1 1AA",
    });
  });

  test("no town is fine — it is optional on the record", () => {
    assert.deepEqual(ok("14 Example Street, WV1 1AA"), {
      houseOrName: "14",
      street: "Example Street",
      town: null,
      postcode: "WV1 1AA",
    });
  });

  test("the postcode may be stuck to the town", () => {
    assert.deepEqual(ok("14 Example Street, Wolverhampton WV1 1AA"), {
      houseOrName: "14",
      street: "Example Street",
      town: "Wolverhampton",
      postcode: "WV1 1AA",
    });
  });

  test("newlines separate parts, as a textarea export does", () => {
    assert.deepEqual(ok("14 Example Street\nWolverhampton\nWV1 1AA"), {
      houseOrName: "14",
      street: "Example Street",
      town: "Wolverhampton",
      postcode: "WV1 1AA",
    });
  });

  test("spacing and case in the postcode do not matter", () => {
    assert.equal(ok("14 Example Street, Wolverhampton, wv11aa").postcode, "WV1 1AA");
  });
});

describe("a flat or unit keeps BOTH identifiers", () => {
  test("the unit and the building number travel together", () => {
    /*
      The case the whole module exists for. "Flat 2" alone is not unique within
      a postcode, and "14" alone is the whole building — a different property.
      Only the pair identifies the flat.
    */
    assert.deepEqual(ok("Flat 2, 14 Example Street, Wolverhampton, WV1 1AA"), {
      houseOrName: "Flat 2, 14",
      street: "Example Street",
      town: "Wolverhampton",
      postcode: "WV1 1AA",
    });
  });

  test("the other words that introduce a sub-property", () => {
    for (const word of ["Apartment 3", "Apt 3", "Unit 3", "Room 3", "Studio 3", "Basement"]) {
      const split = ok(`${word}, 14 Example Street, Wolverhampton, WV1 1AA`);
      assert.equal(split.houseOrName, `${word}, 14`, word);
      assert.equal(split.street, "Example Street", word);
    }
  });

  test("two flats at one address stay distinguishable", () => {
    // If this ever collapsed, the unique index would merge them into one.
    const a = ok("Flat 1, 14 Example Street, Wolverhampton, WV1 1AA");
    const b = ok("Flat 2, 14 Example Street, Wolverhampton, WV1 1AA");
    assert.notEqual(a.houseOrName, b.houseOrName);
  });

  test("a flat is not the same property as the building", () => {
    const flat = ok("Flat 1, 14 Example Street, Wolverhampton, WV1 1AA");
    const house = ok("14 Example Street, Wolverhampton, WV1 1AA");
    assert.notEqual(flat.houseOrName, house.houseOrName);
  });
});

describe("it refuses rather than guesses", () => {
  test("a unit with no building number goes to a person", () => {
    /*
      "Flat 2, Example Street" may be complete, or the number may have been
      dropped upstream. Guessing either way merges or splits real properties.
    */
    const result = splitAddress("Flat 2, Example Street, Wolverhampton, WV1 1AA");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem === "ambiguous_unit");
  });

  test("no postcode is refused, not defaulted", () => {
    const result = splitAddress("14 Example Street, Wolverhampton");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem === "no_postcode");
  });

  test("a postcode-shaped value that is not one is named as such", () => {
    // Different mistake, different fix: this is a typo, not an omission.
    const result = splitAddress("14 Example Street, Wolverhampton, WV1 1AAA");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem === "postcode_unrecognised");
  });

  test("an address with nothing to identify it is refused", () => {
    for (const bad of ["", "   ", "WV1 1AA", "Example Street, WV1 1AA"]) {
      assert.equal(splitAddress(bad).ok, false, bad);
    }
  });

  test("every problem has a sentence that says what to do", () => {
    const problems = [
      "empty",
      "no_postcode",
      "postcode_unrecognised",
      "too_few_parts",
      "ambiguous_unit",
    ] as const;
    const messages = problems.map(describeAddressProblem);
    for (const message of messages) assert.ok(message.length > 15);
    assert.equal(new Set(messages).size, messages.length);
  });
});
