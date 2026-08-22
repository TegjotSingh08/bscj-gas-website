import "server-only";

import { serviceRadiusMiles } from "@/lib/business";
import { haversineMiles, isValidCoordinates, type Coordinates } from "./geo";
import type { ValidatedPostcode } from "./types";

/**
 * Whether a property is inside the area we take instant online bookings for.
 *
 * A radius around a configured operating centre, measured from the coordinates
 * a postcode lookup returns. Radius rather than a list of postcode districts
 * because district boundaries have nothing to do with how far the engineer
 * actually travels — WV16 shares a prefix with Wolverhampton and is 15 miles
 * away, while a DY postcode can be closer than a WV one.
 *
 * The centre is a rounded neighbourhood coordinate held in server-side
 * configuration. It is deliberately never a street name and never precise
 * enough to identify a property, and it is not exposed to the browser.
 */

/**
 * Fallback operating centre.
 *
 * A neighbourhood point in the Wolverhampton operating area, rounded to three
 * decimal places — roughly a 100 metre grid — and deliberately offset so it
 * does not correspond to any particular building. With a twelve mile radius
 * this level of precision makes no practical difference to coverage.
 *
 * Override in server-side configuration with SERVICE_AREA_LAT and
 * SERVICE_AREA_LNG. Never expose these to the browser.
 */
const DEFAULT_LATITUDE = 52.594;
const DEFAULT_LONGITUDE = -2.145;

/**
 * The radius the public copy advertises, so the site and the booking rule
 * cannot drift apart. SERVICE_AREA_RADIUS_MILES overrides it at runtime.
 */
const DEFAULT_RADIUS_MILES = serviceRadiusMiles;

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function serviceAreaCentre(): Coordinates {
  return {
    latitude: readNumber("SERVICE_AREA_LAT", DEFAULT_LATITUDE),
    longitude: readNumber("SERVICE_AREA_LNG", DEFAULT_LONGITUDE),
  };
}

export function serviceAreaRadiusMiles(): number {
  return readNumber("SERVICE_AREA_RADIUS_MILES", DEFAULT_RADIUS_MILES);
}

export type ServiceAreaResult =
  | { covered: true; distanceMiles: number }
  | { covered: false; reason: "outside_radius"; distanceMiles: number }
  /** The postcode is valid but carries no coordinates, so distance is unknown. */
  | { covered: false; reason: "no_coordinates"; distanceMiles: null };

/**
 * Decides coverage from a validated postcode.
 *
 * Takes the whole postcode rather than raw numbers so a caller cannot
 * accidentally pass coordinates the customer supplied.
 */
export function checkServiceArea(
  postcode: Pick<ValidatedPostcode, "latitude" | "longitude">,
  options?: { centre?: Coordinates; radiusMiles?: number },
): ServiceAreaResult {
  const property = {
    latitude: postcode.latitude,
    longitude: postcode.longitude,
  };

  if (!isValidCoordinates(property)) {
    // Without coordinates there is no honest way to decide, so it routes to
    // the phone rather than being waved through.
    return { covered: false, reason: "no_coordinates", distanceMiles: null };
  }

  const centre = options?.centre ?? serviceAreaCentre();
  const radius = options?.radiusMiles ?? serviceAreaRadiusMiles();
  const distanceMiles = haversineMiles(centre, property);

  return distanceMiles <= radius
    ? { covered: true, distanceMiles }
    : { covered: false, reason: "outside_radius", distanceMiles };
}
