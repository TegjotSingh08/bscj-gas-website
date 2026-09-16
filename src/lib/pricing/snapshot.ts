/**
 * The price, frozen onto the job.
 *
 * `job.price_snapshot` is what makes a later pricing change unable to alter
 * work that has already been taken. Renegotiate a tier, retire an agreement,
 * change the list price: every job written before that keeps charging what it
 * was quoted, and its invoice can still explain itself.
 *
 * Without this, "what did we charge for that job last March" would be answered
 * by re-running today's configuration against last March's job — which is not
 * an answer, it is a guess that happens to be right until something changes.
 *
 * The shape is defined and parsed here rather than trusted, because it comes
 * back out of a `jsonb` column where nothing enforces it.
 *
 * Pure and dependency-free.
 */

import { isProductId, type ProductId } from "@/lib/booking/products";
import type { PriceSource, ResolvedPrice } from "./resolve";
import type { VolumeTier } from "./tiers";

/** The version of this shape, so an older snapshot stays readable. */
export const PRICE_SNAPSHOT_VERSION = 1;

export type PriceSnapshot = {
  version: number;
  productId: ProductId;
  /** What the public price list said at the time. */
  listPricePence: number;
  /** What this organisation actually pays per job. */
  unitPricePence: number;
  source: PriceSource;
  agreementId: string | null;
  agreementLineId: string | null;
  tier: VolumeTier | null;
  committedJobs: number | null;
  overrideReason: string | null;
  /** Appliance pricing, where the service has it. */
  applianceCount: number | null;
  extraAppliances: number;
  extraAppliancePence: number;
  extraChargePence: number;
  /** Unit price plus extras. The figure that reaches an invoice line. */
  totalPence: number;
  /** When it was resolved, as an ISO instant. */
  resolvedAt: string;
};

export type BuildSnapshotInput = {
  resolved: ResolvedPrice;
  /** Null for services that do not price by appliance. */
  applianceCount?: number | null;
  /** Chargeable appliances beyond those included, from `calculatePrice`. */
  extraAppliances?: number;
  /** Per-appliance rate in pence, from the registry. */
  extraAppliancePence?: number;
  resolvedAt?: Date;
};

/**
 * Builds the snapshot.
 *
 * The extra-appliance charge is added to the *agreed* unit price rather than
 * to the list price. An agent who negotiated £39.99 for a CP12 and has a
 * four-appliance property pays their rate plus the extra, not the public £45
 * plus the extra.
 */
export function buildPriceSnapshot(input: BuildSnapshotInput): PriceSnapshot {
  const extraAppliances = Math.max(0, input.extraAppliances ?? 0);
  const extraAppliancePence = Math.max(0, input.extraAppliancePence ?? 0);
  const extraChargePence = extraAppliances * extraAppliancePence;

  return {
    version: PRICE_SNAPSHOT_VERSION,
    productId: input.resolved.productId,
    listPricePence: input.resolved.listPricePence,
    unitPricePence: input.resolved.unitPricePence,
    source: input.resolved.source,
    agreementId: input.resolved.agreementId,
    agreementLineId: input.resolved.agreementLineId,
    tier: input.resolved.tier,
    committedJobs: input.resolved.committedJobs,
    overrideReason: input.resolved.overrideReason,
    applianceCount: input.applianceCount ?? null,
    extraAppliances,
    extraAppliancePence,
    extraChargePence,
    totalPence: input.resolved.unitPricePence + extraChargePence,
    resolvedAt: (input.resolvedAt ?? new Date()).toISOString(),
  };
}

/**
 * Reads a snapshot back out of the database.
 *
 * Returns null rather than throwing, and the caller decides what a job with an
 * unreadable price means. Every field is checked: a `jsonb` column will hand
 * back whatever was put in it, including something written by an older version
 * of this code.
 */
export function parsePriceSnapshot(value: unknown): PriceSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const pence = (key: string): number | null => {
    const found = raw[key];
    return typeof found === "number" && Number.isFinite(found) ? found : null;
  };

  const productId = raw.productId;
  if (!isProductId(productId)) return null;

  const unitPricePence = pence("unitPricePence");
  const totalPence = pence("totalPence");
  if (unitPricePence === null || totalPence === null) return null;

  const source = raw.source;
  if (source !== "list" && source !== "agreement" && source !== "override") {
    return null;
  }

  const nullableString = (key: string): string | null => {
    const found = raw[key];
    return typeof found === "string" ? found : null;
  };
  const nullableNumber = (key: string): number | null => pence(key);

  const tier = raw.tier;
  const parsedTier: VolumeTier | null =
    typeof tier === "object" &&
    tier !== null &&
    typeof (tier as Record<string, unknown>).minJobs === "number"
      ? {
          minJobs: (tier as Record<string, unknown>).minJobs as number,
          maxJobs:
            typeof (tier as Record<string, unknown>).maxJobs === "number"
              ? ((tier as Record<string, unknown>).maxJobs as number)
              : null,
        }
      : null;

  return {
    version: pence("version") ?? 1,
    productId,
    listPricePence: pence("listPricePence") ?? unitPricePence,
    unitPricePence,
    source,
    agreementId: nullableString("agreementId"),
    agreementLineId: nullableString("agreementLineId"),
    tier: parsedTier,
    committedJobs: nullableNumber("committedJobs"),
    overrideReason: nullableString("overrideReason"),
    applianceCount: nullableNumber("applianceCount"),
    extraAppliances: pence("extraAppliances") ?? 0,
    extraAppliancePence: pence("extraAppliancePence") ?? 0,
    extraChargePence: pence("extraChargePence") ?? 0,
    totalPence,
    resolvedAt: nullableString("resolvedAt") ?? "",
  };
}

/**
 * The price an invoice should charge for a job.
 *
 * Always the snapshot, never a fresh resolution. This function exists so that
 * rule has somewhere to live and something to point at in review: anything
 * that prices an invoice by calling `resolvePrice` again is wrong, because it
 * would re-price historical work at today's rates.
 */
export function invoiceablePence(snapshot: PriceSnapshot): number {
  return snapshot.totalPence;
}
