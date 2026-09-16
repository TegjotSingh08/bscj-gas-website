/**
 * What an organisation pays for one job.
 *
 * The public list prices stay in `lib/booking/products.ts` and are what the
 * consumer booking flow charges — nothing here touches that path. This layer
 * applies only to work commissioned by an agent organisation, and its job is
 * to answer one question: given an agreement and a committed volume, what is
 * the unit price?
 *
 * Pure. It is handed the agreement lines rather than fetching them, so every
 * rule below is testable without a database and the one place that reads the
 * database stays small.
 *
 * Money is integer pence throughout. The registry holds whole pounds, and the
 * conversion happens here, once.
 */

import { productFor, type ProductId } from "@/lib/booking/products";
import { tierContains, type VolumeTier } from "./tiers";

/** The list price of a service, in pence. */
export function listPricePence(productId: ProductId): number {
  return Math.round(productFor(productId).price * 100);
}

/** One priced band from an organisation's agreement. */
export type AgreementLine = {
  id: string;
  productId: string;
  tierMinJobs: number;
  tierMaxJobs: number | null;
  unitPricePence: number;
};

export type PriceSource = "list" | "agreement" | "override";

export type ResolvedPrice = {
  productId: ProductId;
  unitPricePence: number;
  listPricePence: number;
  source: PriceSource;
  /** Present only when an agreement line decided it. */
  agreementId: string | null;
  agreementLineId: string | null;
  tier: VolumeTier | null;
  /** The committed volume the tier was selected with. */
  committedJobs: number | null;
  /** Why an administrator overrode the price. Required when they did. */
  overrideReason: string | null;
};

export type ResolveInput = {
  productId: ProductId;
  /** Null for consumer work, or an organisation with no agreement. */
  agreementId?: string | null;
  lines?: readonly AgreementLine[];
  /** The volume committed for the month this job falls in. */
  committedJobs?: number | null;
  /** An administrator's explicit price for this one job, in pence. */
  overridePricePence?: number | null;
  overrideReason?: string | null;
};

/**
 * Resolves the unit price.
 *
 * Precedence, and the reason for each step:
 *
 * 1. **An administrator's override** wins outright. It is a deliberate,
 *    attributable decision about one job, and a tier must not quietly undo it.
 *    It requires a reason: an unexplained price on an invoice is a question
 *    nobody can answer six months later.
 * 2. **The agreement line whose band contains the committed volume.** Exactly
 *    one line may match; overlapping bands are refused when the agreement is
 *    saved, not silently resolved here.
 * 3. **The list price.** An organisation with no agreement, no commitment, or
 *    no line for this service pays list. That fallback is what makes this
 *    whole mechanism safe to ship before a single tier figure is approved.
 *
 * Never throws for missing configuration. Missing configuration means list
 * price, which is the honest answer and the one that cannot undercharge.
 */
export function resolvePrice(input: ResolveInput): ResolvedPrice {
  const listPence = listPricePence(input.productId);

  const base: ResolvedPrice = {
    productId: input.productId,
    unitPricePence: listPence,
    listPricePence: listPence,
    source: "list",
    agreementId: null,
    agreementLineId: null,
    tier: null,
    committedJobs: input.committedJobs ?? null,
    overrideReason: null,
  };

  if (
    typeof input.overridePricePence === "number" &&
    Number.isInteger(input.overridePricePence) &&
    input.overridePricePence >= 0
  ) {
    return {
      ...base,
      unitPricePence: input.overridePricePence,
      source: "override",
      overrideReason: input.overrideReason ?? null,
    };
  }

  const committed = input.committedJobs;
  if (!input.agreementId || !input.lines?.length || typeof committed !== "number") {
    return base;
  }

  const match = input.lines.find(
    (line) =>
      line.productId === input.productId &&
      tierContains(
        { minJobs: line.tierMinJobs, maxJobs: line.tierMaxJobs },
        committed,
      ),
  );

  if (!match) return base;

  return {
    ...base,
    unitPricePence: match.unitPricePence,
    source: "agreement",
    agreementId: input.agreementId,
    agreementLineId: match.id,
    tier: { minJobs: match.tierMinJobs, maxJobs: match.tierMaxJobs },
  };
}

/**
 * Whether an agreement is in force on a given date.
 *
 * Dates are `YYYY-MM-DD` strings, which compare correctly as strings — an
 * ISO date is designed so that lexical order is chronological order.
 */
export function isAgreementEffective(
  agreement: { status: string; effectiveFrom: string; effectiveTo: string | null },
  onDate: string,
): boolean {
  if (agreement.status !== "active") return false;
  if (onDate < agreement.effectiveFrom) return false;
  if (agreement.effectiveTo && onDate > agreement.effectiveTo) return false;
  return true;
}

/** The first day of the month a date falls in, as `YYYY-MM-01`. */
export function periodStartFor(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}
