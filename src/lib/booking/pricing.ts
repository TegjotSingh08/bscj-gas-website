/**
 * Price is always derived here, on the server, from the verified business
 * rules. A price submitted by the browser is never trusted — the request
 * carries a product *id*, and every figure below comes from the registry.
 */

import {
  DEFAULT_PRODUCT_ID,
  productFor,
  type ProductId,
} from "./products";

/** Appliances covered by the base price: one boiler plus two others. */
export const APPLIANCES_INCLUDED = 3;
export const MAX_APPLIANCES = 12;

export type PriceBreakdown = {
  productId: ProductId;
  productName: string;
  /** Whether the appliance count means anything for this product at all. */
  appliancePricing: boolean;
  applianceCount: number;
  basePrice: number;
  extraAppliances: number;
  extraCharge: number;
  total: number;
  totalDisplay: string;
};

/**
 * The total for a product and an appliance count.
 *
 * The appliance rule is shared, not duplicated: both products that include a
 * certificate cover one boiler plus two appliances and charge £15 for each one
 * beyond that, so the only thing that varies is the base. £45 → £60 with one
 * chargeable extra; £90 → £105 with one, £120 with two.
 *
 * The standalone boiler service is outside that rule entirely: it is £60
 * whatever the appliance count says.
 *
 * `productId` defaults to the CP12, so every pre-existing caller is unchanged.
 */
export function calculatePrice(
  applianceCount: number,
  productId: ProductId = DEFAULT_PRODUCT_ID,
): PriceBreakdown {
  const product = productFor(productId);

  const clamped = Math.min(
    Math.max(Math.trunc(applianceCount) || 1, 1),
    MAX_APPLIANCES,
  );

  // The standalone boiler service is one boiler at a fixed price, whatever
  // else the property runs on gas. The surcharge is gated here rather than
  // relying on its rate being zero, so no future edit to a rate can quietly
  // start charging for appliances on a service that does not cover them.
  const extraAppliances = product.appliancePricing
    ? Math.max(0, clamped - APPLIANCES_INCLUDED)
    : 0;
  const extraCharge = extraAppliances * product.extraAppliancePrice;
  const total = product.price + extraCharge;

  return {
    productId: product.id,
    productName: product.name,
    appliancePricing: product.appliancePricing,
    applianceCount: clamped,
    basePrice: product.price,
    extraAppliances,
    extraCharge,
    total,
    totalDisplay: `£${total} total`,
  };
}
