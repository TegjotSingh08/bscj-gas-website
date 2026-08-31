/**
 * The bookable products.
 *
 * One server-side registry, and the only place a price, an appliance rate or an
 * appointment length is ever read from. The browser sends a product *id* and
 * nothing else: a submitted price or duration is ignored everywhere, because
 * neither is ever taken off the request.
 *
 * The facts themselves stay in `business.ts`, which mirrors
 * `docs/business-details.md`. This module only arranges them into the shape the
 * booking engine, the emails and the calendar need.
 *
 * `cp12` is the default. Every entry point falls back to it when no product is
 * named, so a request written before this registry existed still books exactly
 * the £45 CP12 it always did.
 */

import { boilerService, boilerServiceBundle, cp12 } from "@/lib/business";

/**
 * Offered in this order: the entry certificate, the standalone service, then
 * the combined visit. The bundle sits last because it is the second question,
 * not a louder version of the first.
 */
export const PRODUCT_IDS = [
  "cp12",
  "boiler-service",
  "cp12-boiler-service",
] as const;

export type ProductId = (typeof PRODUCT_IDS)[number];

/** The entry product, and the backwards-compatible fallback. */
export const DEFAULT_PRODUCT_ID: ProductId = "cp12";

export type Product = {
  id: ProductId;
  /** Full customer-facing name. Used on screen and in the emails. */
  name: string;
  /** Short form for an email subject line, where width is scarce. */
  subjectName: string;
  /** Short form for the calendar event summary, read at a glance on a phone. */
  calendarName: string;
  /**
   * What the engineer will do, as a sentence fragment: "carry out the {this}".
   * Kept deliberately plain — it must stay true without describing procedures
   * that have never been confirmed.
   */
  workDescription: string;
  price: number;
  /** "£45" */
  priceDisplay: string;
  /** "£45 total" */
  priceTotalDisplay: string;
  /** What the base price covers, before any extra-appliance charge. */
  includes: string;
  extraAppliancePrice: number;
  /** "£15" */
  extraApplianceDisplay: string;
  /**
   * The calendar allocation for the appointment. Excludes the internal buffer.
   *
   * For the CP12 this is a real, documented typical duration. For anything
   * involving the boiler service it is an allocation — the length the diary
   * reserves — and must never be published as how long the work takes.
   */
  durationMinutes: number;
  /**
   * Whether the +£15 extra-appliance rule applies.
   *
   * True for anything that includes a CP12, because the certificate covers
   * every gas appliance in the property. False for the standalone boiler
   * service, which is one boiler at a fixed price however many other
   * appliances the property happens to have.
   */
  appliancePricing: boolean;
  /**
   * For a bundle: the products it replaces. The advertised saving is derived
   * from these, so it can never drift from what those products actually cost.
   */
  componentIds?: readonly ProductId[];
  /** One line of difference, for the selector and the pricing cards. */
  tagline: string;
  /** The full pricing sentence for legal and pricing copy. */
  priceSentence: string;
};

export const products: Readonly<Record<ProductId, Product>> = {
  cp12: {
    id: "cp12",
    name: "Gas Safety Certificate (CP12)",
    subjectName: "CP12",
    calendarName: "CP12",
    workDescription: "gas safety check",
    tagline: "CP12 for up to 3 appliances.",
    price: cp12.price,
    priceDisplay: cp12.priceDisplay,
    priceTotalDisplay: cp12.priceTotalDisplay,
    includes: cp12.includes,
    extraAppliancePrice: cp12.extraAppliancePrice,
    extraApplianceDisplay: cp12.extraApplianceDisplay,
    durationMinutes: cp12.durationMinutes,
    appliancePricing: true,
    priceSentence: cp12.priceSentence,
  },
  "boiler-service": {
    id: "boiler-service",
    name: "Annual Boiler Service",
    subjectName: "Boiler Service",
    calendarName: "Boiler Service",
    workDescription: "annual boiler service",
    tagline: "Annual boiler servicing in one convenient appointment.",
    price: boilerService.price,
    priceDisplay: boilerService.priceDisplay,
    priceTotalDisplay: boilerService.priceTotalDisplay,
    /*
      One boiler, one fixed price. The certificate's appliance rule does not
      apply here and the fields below say so: the rate is zero and
      `appliancePricing` is false, so there is no arithmetic path — and no
      copy — that can put a surcharge on a standalone service.
    */
    includes: "one boiler",
    extraAppliancePrice: 0,
    extraApplianceDisplay: "£0",
    durationMinutes: boilerService.durationMinutes,
    appliancePricing: false,
    priceSentence: boilerService.priceSentence,
  },
  "cp12-boiler-service": {
    id: "cp12-boiler-service",
    name: "CP12 + Annual Boiler Service",
    subjectName: "CP12 + boiler service",
    calendarName: "CP12 + Boiler Service",
    workDescription: "gas safety check and annual boiler service",
    tagline: "Gas safety check and annual boiler service in one visit.",
    price: boilerServiceBundle.price,
    priceDisplay: boilerServiceBundle.priceDisplay,
    priceTotalDisplay: boilerServiceBundle.priceTotalDisplay,
    includes: boilerServiceBundle.includes,
    extraAppliancePrice: boilerServiceBundle.extraAppliancePrice,
    extraApplianceDisplay: boilerServiceBundle.extraApplianceDisplay,
    durationMinutes: boilerServiceBundle.durationMinutes,
    appliancePricing: true,
    /** What it replaces, and therefore what the saving is measured against. */
    componentIds: ["cp12", "boiler-service"],
    priceSentence: boilerServiceBundle.priceSentence,
  },
} as const;

/**
 * What a bundle saves against buying its parts separately.
 *
 * Derived, never written down. Both component prices are genuinely published
 * and bookable — £45 and £60 — so "save £15" is a statement of arithmetic
 * about real prices rather than a marketing claim, and it cannot drift if any
 * of the three ever changes. Returns null for a product that is not a bundle.
 */
export type BundleSaving = {
  separateTotal: number;
  bundlePrice: number;
  saving: number;
  /** "£15" */
  savingDisplay: string;
  /** "£105" */
  separateTotalDisplay: string;
};

export function bundleSavingFor(id: ProductId): BundleSaving | null {
  const product = products[id];
  if (!product.componentIds?.length) return null;

  const separateTotal = product.componentIds.reduce(
    (total, componentId) => total + products[componentId].price,
    0,
  );
  const saving = separateTotal - product.price;
  if (saving <= 0) return null;

  return {
    separateTotal,
    bundlePrice: product.price,
    saving,
    savingDisplay: `£${saving}`,
    separateTotalDisplay: `£${separateTotal}`,
  };
}

/** Every product, in the order they are offered. */
export const productList: readonly Product[] = PRODUCT_IDS.map(
  (id) => products[id],
);

export function isProductId(value: unknown): value is ProductId {
  return (
    typeof value === "string" &&
    (PRODUCT_IDS as readonly string[]).includes(value)
  );
}

/**
 * The product for an id, falling back to the CP12 for anything unrecognised.
 *
 * Deliberately total: this is called after validation has already refused an
 * unknown id, so it exists to make the *type* honest rather than to forgive a
 * bad request. Routes reject unknown ids before they get here.
 */
export function productFor(id: unknown): Product {
  return isProductId(id) ? products[id] : products[DEFAULT_PRODUCT_ID];
}
