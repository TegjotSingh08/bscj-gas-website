import { normalisePostcode } from "./format";
import type {
  PostcodeLookupResult,
  PostcodeProvider,
  ValidatedPostcode,
} from "./types";

/**
 * Test doubles.
 *
 * The automated suite must never touch the live postcode service — running
 * hundreds of tests against free public infrastructure would be an abuse of
 * it. Every test uses these instead.
 */

export class FakePostcodeProvider implements PostcodeProvider {
  /** Every call made, so tests can assert on caching and call counts. */
  readonly calls: string[] = [];

  private readonly known: Map<string, ValidatedPostcode>;
  private behaviour: "normal" | "provider_unavailable" = "normal";

  constructor(known: ValidatedPostcode[] = [IN_AREA_POSTCODE]) {
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

/**
 * Fictional fixtures. The postcodes are deliberately in the unallocated WV99
 * range so no test data can correspond to a real property, and the
 * coordinates are chosen to sit at known distances from the operating centre.
 */
export const IN_AREA_POSTCODE: ValidatedPostcode = {
  postcode: "WV99 1AA",
  outcode: "WV99",
  areaName: "Wolverhampton",
  // Roughly a mile from the configured centre.
  latitude: 52.6,
  longitude: -2.12,
};

/** Valid, but far enough away to fall outside the radius. */
export const OUT_OF_AREA_POSTCODE: ValidatedPostcode = {
  postcode: "WV99 9ZZ",
  outcode: "WV99",
  areaName: "Birmingham",
  // Birmingham city centre, about 13 miles away.
  latitude: 52.4796,
  longitude: -1.9027,
};

/** A valid postcode the provider returned without coordinates. */
export const NO_COORDINATES_POSTCODE: ValidatedPostcode = {
  postcode: "WV99 2BB",
  outcode: "WV99",
  areaName: "Wolverhampton",
  latitude: null,
  longitude: null,
};
