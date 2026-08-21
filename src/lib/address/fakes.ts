import { normalisePostcode } from "./format";
import { bestMatch } from "./match";
import type {
  AddressVerificationProvider,
  AddressVerificationResult,
  PostcodeLookupResult,
  PostcodeProvider,
  ValidatedPostcode,
} from "./types";

/**
 * Test doubles.
 *
 * The automated suite must never touch live Postcodes.io or the public
 * Nominatim service — running hundreds of tests against donated
 * infrastructure would be an abuse of it, and the policy forbids automated
 * testing against the public endpoint. Every test uses these instead.
 */

export class FakePostcodeProvider implements PostcodeProvider {
  /** Every call made, so tests can assert on caching and call counts. */
  readonly calls: string[] = [];

  private readonly known: Map<string, ValidatedPostcode>;
  private behaviour: "normal" | "provider_unavailable" = "normal";

  constructor(known: ValidatedPostcode[] = [DEFAULT_POSTCODE]) {
    this.known = new Map(
      known.map((entry) => [normalisePostcode(entry.postcode), entry]),
    );
  }

  setUnavailable(unavailable: boolean): void {
    this.behaviour = unavailable ? "provider_unavailable" : "normal";
  }

  async lookup(raw: string): Promise<PostcodeLookupResult> {
    this.calls.push(raw);

    if (this.behaviour === "provider_unavailable") {
      return { status: "provider_unavailable" };
    }

    const postcode = normalisePostcode(raw);
    if (!/^[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}$/.test(postcode)) {
      return { status: "malformed" };
    }

    const found = this.known.get(postcode);
    return found ? { status: "valid", postcode: found } : { status: "not_found" };
  }
}

export class FakeAddressVerificationProvider
  implements AddressVerificationProvider
{
  readonly calls: { houseOrName: string; street: string; postcode: string }[] =
    [];

  private candidates: {
    street: string | null;
    houseNumber: string | null;
    postcode: string | null;
  }[] = [];
  private behaviour: "normal" | "unavailable" = "normal";

  /** What the mapping service will claim to have found. */
  setCandidates(
    candidates: {
      street: string | null;
      houseNumber: string | null;
      postcode: string | null;
    }[],
  ): void {
    this.candidates = candidates;
  }

  setUnavailable(unavailable: boolean): void {
    this.behaviour = unavailable ? "unavailable" : "normal";
  }

  async verify(input: {
    houseOrName: string;
    street: string;
    postcode: string;
  }): Promise<AddressVerificationResult> {
    this.calls.push(input);

    if (this.behaviour === "unavailable") return { status: "unavailable" };

    const match = bestMatch(this.candidates, input);
    if (match.status === "unverified") return { status: "unverified" };
    return {
      status: match.status,
      matchedStreet: match.matchedStreet,
      matchedHouseNumber: match.matchedHouseNumber,
    };
  }
}

export const DEFAULT_POSTCODE: ValidatedPostcode = {
  postcode: "WV6 0AR",
  outcode: "WV6",
  areaName: "Wolverhampton",
  latitude: 52.592901,
  longitude: -2.143953,
};

/** A valid postcode outside the configured service area. */
export const OUT_OF_AREA_POSTCODE: ValidatedPostcode = {
  postcode: "B1 1AA",
  outcode: "B1",
  areaName: "Birmingham",
  latitude: 52.47944,
  longitude: -1.90269,
};
