import { serviceAreas } from "@/lib/business";
import { normalisePostcode } from "./format";

/**
 * Which postcodes the site will take an instant online booking for.
 *
 * Decided on the outward code from a validated postcode, never on a town name
 * the customer typed — "Wolverhampton" in a text box proves nothing.
 *
 * NOTE FOR THE OWNER: docs/business-details.md names four towns
 * (Wolverhampton, Bilston, Wednesfield, Willenhall) but does not list
 * postcodes. The mapping below is the standard outward-code coverage of those
 * four towns and should be confirmed before launch. Deliberately excluded:
 * WV7/WV8/WV9 (Albrighton, Codsall, Coven) and WV15/WV16 (Bridgnorth), which
 * share the WV prefix but are not the named towns.
 *
 * Being outside this list is not a rejection — it routes the customer to the
 * phone so the engineer can decide.
 */
export const SERVICE_AREA_OUTCODES: readonly string[] = [
  // Wolverhampton
  "WV1",
  "WV2",
  "WV3",
  "WV4",
  "WV5",
  "WV6",
  "WV10",
  // Wednesfield
  "WV11",
  // Willenhall
  "WV12",
  "WV13",
  // Bilston
  "WV14",
] as const;

export type ServiceAreaResult =
  | { covered: true }
  | { covered: false; reason: "outside_area" };

export function isWithinServiceArea(outcode: string): boolean {
  return SERVICE_AREA_OUTCODES.includes(outcode.trim().toUpperCase());
}

export function checkServiceArea(outcode: string): ServiceAreaResult {
  return isWithinServiceArea(outcode)
    ? { covered: true }
    : { covered: false, reason: "outside_area" };
}

/** The outward code of a postcode, e.g. "WV6 0AR" gives "WV6". */
export function outcodeOf(postcode: string): string {
  const canonical = normalisePostcode(postcode);
  const [outcode] = canonical.split(" ");
  return outcode ?? "";
}

/** Human-readable list of the towns covered, for customer-facing copy. */
export function serviceAreaSummary(): string {
  const areas = [...serviceAreas];
  const last = areas.pop();
  return `${areas.join(", ")} and ${last}`;
}
