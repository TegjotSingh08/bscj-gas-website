/**
 * Structured property address.
 *
 * Provider-neutral by design: nothing here names Postcodes.io, Nominatim or
 * OpenStreetMap, so a commercial PAF provider can be swapped in later without
 * the booking flow, the calendar event or the email changing shape.
 */

/** What a postcode lookup tells us. Only the fields we actually use. */
export type ValidatedPostcode = {
  /** Canonical form as returned by the provider, e.g. "WV6 0AR". */
  postcode: string;
  /** e.g. "WV6" — the part service-area rules are decided on. */
  outcode: string;
  /** Nearest town or administrative area, for display. */
  areaName: string;
  latitude: number | null;
  longitude: number | null;
};

/**
 * How much confidence we have that the address exists as entered.
 *
 * Deliberately three states. "unverified" is a perfectly normal outcome — open
 * mapping data does not contain every new build, flat or private road — and it
 * never blocks a booking.
 */
export type AddressVerificationStatus =
  | "verified"
  | "partial_match"
  | "unverified";

export type PropertyAddress = {
  /** "197" or "Rose Cottage". */
  houseOrName: string;
  street: string;
  town: string;
  postcode: string;
  /** The single display form used everywhere. */
  formattedAddress: string;
  /** True only when a postcode provider confirmed the postcode is live. */
  postcodeValidated: boolean;
  addressVerificationStatus: AddressVerificationStatus;
  /** Present when the customer explicitly confirmed an unverified address. */
  confirmedByCustomer: boolean;
  latitude: number | null;
  longitude: number | null;
};

/** Outcome of a postcode lookup, distinguishing "invalid" from "we could not ask". */
export type PostcodeLookupResult =
  | { status: "valid"; postcode: ValidatedPostcode }
  | { status: "not_found" }
  | { status: "malformed" }
  | { status: "provider_unavailable" };

/** Outcome of the secondary address confidence check. */
export type AddressVerificationResult =
  | {
      status: "verified" | "partial_match";
      /** What the provider matched, for our own comparison only. */
      matchedStreet: string | null;
      matchedHouseNumber: string | null;
    }
  | { status: "unverified" }
  /** Provider down, throttled, or no safe way to call it. Never a rejection. */
  | { status: "unavailable" };

export interface PostcodeProvider {
  lookup(postcode: string): Promise<PostcodeLookupResult>;
}

export interface AddressVerificationProvider {
  verify(input: {
    houseOrName: string;
    street: string;
    postcode: string;
  }): Promise<AddressVerificationResult>;
}
