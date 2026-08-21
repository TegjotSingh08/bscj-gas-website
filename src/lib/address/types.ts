/**
 * Structured property address.
 *
 * Provider-neutral by design: nothing here names a postcode provider, so a
 * commercial address provider can be swapped in later without the booking
 * flow, the calendar event or the email changing shape.
 */

/** What a postcode lookup tells us. Only the fields we actually use. */
export type ValidatedPostcode = {
  /** Canonical form as returned by the provider, e.g. "WV1 1AA". */
  postcode: string;
  /** e.g. "WV1". Retained for display and support, not for coverage rules. */
  outcode: string;
  /** Nearest town or administrative area, for display. */
  areaName: string;
  /** Used to measure distance from the operating centre. */
  latitude: number | null;
  longitude: number | null;
};

export type PropertyAddress = {
  /** "24" or "Rose Cottage". */
  houseOrName: string;
  street: string;
  town: string;
  postcode: string;
  /** The single display form used everywhere. */
  formattedAddress: string;
  /**
   * True only when a postcode provider confirmed the postcode is live.
   *
   * This says nothing about whether the property exists at it — no free
   * service can establish that, and the site never claims it can.
   */
  postcodeValidated: boolean;
  /** The customer read the assembled address back and confirmed it. */
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

export interface PostcodeProvider {
  lookup(postcode: string): Promise<PostcodeLookupResult>;
}
