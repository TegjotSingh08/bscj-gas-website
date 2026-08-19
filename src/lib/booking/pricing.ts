/**
 * Price is always derived here, on the server, from the verified business
 * rules. A price submitted by the browser is never trusted.
 */

import { cp12 } from "@/lib/business";

/** Appliances covered by the base price: one boiler plus two others. */
export const APPLIANCES_INCLUDED = 3;
export const MAX_APPLIANCES = 12;

export type PriceBreakdown = {
  applianceCount: number;
  basePrice: number;
  extraAppliances: number;
  extraCharge: number;
  total: number;
  totalDisplay: string;
};

export function calculatePrice(applianceCount: number): PriceBreakdown {
  const clamped = Math.min(
    Math.max(Math.trunc(applianceCount) || 1, 1),
    MAX_APPLIANCES,
  );
  const extraAppliances = Math.max(0, clamped - APPLIANCES_INCLUDED);
  const extraCharge = extraAppliances * cp12.extraAppliancePrice;
  const total = cp12.price + extraCharge;

  return {
    applianceCount: clamped,
    basePrice: cp12.price,
    extraAppliances,
    extraCharge,
    total,
    totalDisplay: `£${total} total`,
  };
}
