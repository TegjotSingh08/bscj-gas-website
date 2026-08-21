import type { PropertyAddress, ValidatedPostcode } from "./types";

/**
 * The single source of address formatting.
 *
 * Every surface — review screen, calendar event, confirmation page, email —
 * renders the `formattedAddress` built here, so the same property can never
 * appear as "197 sweetman st" in one place and "197 Sweetman Street" in
 * another.
 */

/** Collapses whitespace and strips control characters. */
export function normaliseLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercased, punctuation-free form used only for comparing, never for display. */
export function comparable(value: string): string {
  return normaliseLine(value)
    .toLowerCase()
    .replace(/[.,'’`-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Uppercase, single-spaced postcode. Accepts "wv60ar" and "WV6 0AR" alike. */
export function normalisePostcode(value: string): string {
  const bare = normaliseLine(value).toUpperCase().replace(/\s+/g, "");
  if (bare.length < 5) return bare;
  return `${bare.slice(0, -3)} ${bare.slice(-3)}`;
}

/** Loose shape check, used to avoid pointless lookups. Not a validity claim. */
export function looksLikePostcode(value: string): boolean {
  return /^[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}$/.test(normalisePostcode(value));
}

/** "197 Sweetman Street, Wolverhampton, WV6 0AR" */
export function formatAddress(parts: {
  houseOrName: string;
  street: string;
  town: string;
  postcode: string;
}): string {
  const firstLine = [
    normaliseLine(parts.houseOrName),
    normaliseLine(parts.street),
  ]
    .filter(Boolean)
    .join(" ");

  return [firstLine, normaliseLine(parts.town), normalisePostcode(parts.postcode)]
    .filter(Boolean)
    .join(", ");
}

/** Multi-line form, for the email's property card and the calendar location. */
export function formatAddressLines(address: {
  houseOrName: string;
  street: string;
  town: string;
  postcode: string;
}): string[] {
  const firstLine = [
    normaliseLine(address.houseOrName),
    normaliseLine(address.street),
  ]
    .filter(Boolean)
    .join(" ");
  return [
    firstLine,
    normaliseLine(address.town),
    normalisePostcode(address.postcode),
  ].filter(Boolean);
}

/** Assembles the stored address from validated pieces. */
export function buildPropertyAddress(input: {
  houseOrName: string;
  street: string;
  postcode: ValidatedPostcode;
  verificationStatus: PropertyAddress["addressVerificationStatus"];
  confirmedByCustomer: boolean;
  town?: string;
}): PropertyAddress {
  const town = normaliseLine(input.town || input.postcode.areaName);
  const houseOrName = normaliseLine(input.houseOrName);
  const street = normaliseLine(input.street);

  return {
    houseOrName,
    street,
    town,
    postcode: input.postcode.postcode,
    formattedAddress: formatAddress({
      houseOrName,
      street,
      town,
      postcode: input.postcode.postcode,
    }),
    postcodeValidated: true,
    addressVerificationStatus: input.verificationStatus,
    confirmedByCustomer: input.confirmedByCustomer,
    latitude: input.postcode.latitude,
    longitude: input.postcode.longitude,
  };
}
