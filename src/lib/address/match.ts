import { comparable, normalisePostcode } from "./format";
import { outcodeOf } from "./service-area";
import type { AddressVerificationStatus } from "./types";

/**
 * How closely a mapping result matches what the customer typed.
 *
 * Pure, so the rules are testable without a provider. Deliberately
 * conservative: matching is by normalised equality and a small set of
 * well-known street-type abbreviations, never fuzzy distance. Approving the
 * wrong street would be worse than asking the customer to confirm — an
 * engineer sent to the wrong road is a wasted visit and a lost job.
 */

/** Only the abbreviations Royal Mail itself uses. Nothing speculative. */
const STREET_TYPES: Record<string, string> = {
  st: "street",
  rd: "road",
  ave: "avenue",
  av: "avenue",
  ln: "lane",
  dr: "drive",
  cl: "close",
  cres: "crescent",
  ct: "court",
  gdns: "gardens",
  pl: "place",
  sq: "square",
  ter: "terrace",
  pk: "park",
  gr: "grove",
  wlk: "walk",
  yd: "yard",
};

/** Expands "sweetman st" to "sweetman street" so the two compare equal. */
export function expandStreet(value: string): string {
  return comparable(value)
    .split(" ")
    .map((word) => STREET_TYPES[word] ?? word)
    .join(" ");
}

export function streetsMatch(entered: string, returned: string): boolean {
  if (!entered || !returned) return false;
  return expandStreet(entered) === expandStreet(returned);
}

export function postcodesMatch(entered: string, returned: string): boolean {
  if (!entered || !returned) return false;
  return normalisePostcode(entered) === normalisePostcode(returned);
}

/**
 * Same postcode district, e.g. both "WV6".
 *
 * This is the gate rather than full-postcode equality because open mapping
 * data tags each *segment* of a street with whichever postcode is nearest,
 * not with the postcode of an individual property. Real testing of Sweetman
 * Street, WV6 0AR returned WV6 0AA, WV6 0AX and WV6 0DN — all correct for the
 * street, none equal to the property's own postcode. Demanding exact equality
 * made every genuine address score as unverified.
 */
export function outcodesMatch(entered: string, returned: string): boolean {
  if (!entered || !returned) return false;
  const enteredOutcode = outcodeOf(entered);
  const returnedOutcode = outcodeOf(returned);
  return Boolean(enteredOutcode) && enteredOutcode === returnedOutcode;
}

/**
 * House numbers only. A property *name* is not compared: mapping data records
 * names inconsistently, and a mismatch there would be meaningless.
 */
export function houseNumbersMatch(entered: string, returned: string): boolean {
  if (!entered || !returned) return false;
  const enteredNumber = comparable(entered).replace(/\s+/g, "");
  const returnedNumber = comparable(returned).replace(/\s+/g, "");
  return enteredNumber === returnedNumber;
}

export function isHouseNumber(value: string): boolean {
  return /^\d+[a-z]?$/i.test(value.trim());
}

/**
 * Grades a candidate result.
 *
 * The postcode district is the gate: a result from another district is a
 * different place, however plausible the street name looks. Within the right
 * district, a matching street name is meaningful — and the exact postcode and
 * house number are what separate a full match from a partial one.
 */
export function classifyMatch(input: {
  enteredHouseOrName: string;
  enteredStreet: string;
  enteredPostcode: string;
  returnedStreet: string | null;
  returnedHouseNumber: string | null;
  returnedPostcode: string | null;
}): AddressVerificationStatus {
  // A result from another postcode district tells us nothing about this
  // address, whatever the street is called.
  if (
    !input.returnedPostcode ||
    !outcodesMatch(input.enteredPostcode, input.returnedPostcode)
  ) {
    return "unverified";
  }

  if (!input.returnedStreet || !streetsMatch(input.enteredStreet, input.returnedStreet)) {
    return "unverified";
  }

  // The street exists in the right district. A full match additionally needs
  // the exact postcode and the house number to agree — which open mapping data
  // supplies only sometimes.
  const exactPostcode = postcodesMatch(
    input.enteredPostcode,
    input.returnedPostcode,
  );

  if (!exactPostcode) return "partial_match";

  // A named property: the street is as much as can honestly be confirmed.
  if (!isHouseNumber(input.enteredHouseOrName)) return "partial_match";

  if (!input.returnedHouseNumber) return "partial_match";

  return houseNumbersMatch(input.enteredHouseOrName, input.returnedHouseNumber)
    ? "verified"
    : "partial_match";
}

/** Picks the best of several candidates, preferring a full match. */
export function bestMatch(
  candidates: {
    street: string | null;
    houseNumber: string | null;
    postcode: string | null;
  }[],
  entered: { houseOrName: string; street: string; postcode: string },
): {
  status: AddressVerificationStatus;
  matchedStreet: string | null;
  matchedHouseNumber: string | null;
} {
  let best: {
    status: AddressVerificationStatus;
    matchedStreet: string | null;
    matchedHouseNumber: string | null;
  } = { status: "unverified", matchedStreet: null, matchedHouseNumber: null };

  for (const candidate of candidates) {
    const status = classifyMatch({
      enteredHouseOrName: entered.houseOrName,
      enteredStreet: entered.street,
      enteredPostcode: entered.postcode,
      returnedStreet: candidate.street,
      returnedHouseNumber: candidate.houseNumber,
      returnedPostcode: candidate.postcode,
    });

    if (status === "verified") {
      return {
        status,
        matchedStreet: candidate.street,
        matchedHouseNumber: candidate.houseNumber,
      };
    }
    if (status === "partial_match" && best.status === "unverified") {
      best = {
        status,
        matchedStreet: candidate.street,
        matchedHouseNumber: candidate.houseNumber,
      };
    }
  }

  return best;
}
