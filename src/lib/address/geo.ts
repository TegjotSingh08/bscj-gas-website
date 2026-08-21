/**
 * Straight-line distance between two points on the Earth.
 *
 * Pure and dependency-free so the service-area rules can be tested exactly.
 */

/** Mean Earth radius in miles, as used by the standard haversine formula. */
const EARTH_RADIUS_MILES = 3958.7613;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export type Coordinates = { latitude: number; longitude: number };

export function isValidCoordinates(value: {
  latitude?: number | null;
  longitude?: number | null;
} | null | undefined): value is Coordinates {
  if (!value) return false;
  const { latitude, longitude } = value;
  if (typeof latitude !== "number" || typeof longitude !== "number") return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

/**
 * Great-circle distance in miles.
 *
 * This is straight-line distance, not driving distance. A 12 mile radius is
 * not a 12 mile drive and certainly not a fixed travel time — the site never
 * claims otherwise.
 */
export function haversineMiles(from: Coordinates, to: Coordinates): number {
  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);

  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLongitude / 2) ** 2;

  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
