import "server-only";

import { and, eq, lte, or, isNull, gte, desc } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  pricingAgreementLines,
  pricingAgreements,
  volumeCommitments,
} from "@/lib/db/schema";
import { periodStartFor, type AgreementLine } from "./resolve";

/**
 * Loading what an agency has agreed to pay.
 *
 * The only code that reads the pricing tables. `resolvePrice` stays pure and is
 * handed the result, so the rules are testable without a database and this
 * file has one job.
 *
 * **Everything is scoped to the organisation**, and the organisation comes from
 * `requireAgent()` at the call site. An agency cannot be priced under another's
 * agreement because no query here will look one up without being told whose.
 *
 * Absent configuration is not an error. No agreement, no commitment, or no line
 * for the service means `resolvePrice` charges the published list price — which
 * is what makes the whole mechanism safe to run before a single tier figure has
 * been approved.
 */

export type ResolvedAgreement = {
  agreementId: string | null;
  lines: AgreementLine[];
  committedJobs: number | null;
};

export async function loadAgreement(
  organisationId: string,
  onDate: string,
): Promise<ResolvedAgreement> {
  const empty: ResolvedAgreement = {
    agreementId: null,
    lines: [],
    committedJobs: null,
  };

  const db = getDb();
  if (!db) return empty;

  try {
    const [agreement] = await db
      .select({ id: pricingAgreements.id })
      .from(pricingAgreements)
      .where(
        and(
          eq(pricingAgreements.agentOrganisationId, organisationId),
          eq(pricingAgreements.status, "active"),
          lte(pricingAgreements.effectiveFrom, onDate),
          // Open-ended agreements have no end date.
          or(
            isNull(pricingAgreements.effectiveTo),
            gte(pricingAgreements.effectiveTo, onDate),
          ),
        ),
      )
      // The most recently effective one wins if two somehow overlap.
      .orderBy(desc(pricingAgreements.effectiveFrom))
      .limit(1);

    if (!agreement) return empty;

    const lines = await db
      .select({
        id: pricingAgreementLines.id,
        productId: pricingAgreementLines.productId,
        tierMinJobs: pricingAgreementLines.tierMinJobs,
        tierMaxJobs: pricingAgreementLines.tierMaxJobs,
        unitPricePence: pricingAgreementLines.unitPricePence,
      })
      .from(pricingAgreementLines)
      .where(eq(pricingAgreementLines.pricingAgreementId, agreement.id));

    /*
      The tier comes from the volume committed **in advance** for the month the
      job falls in, not from what the agency has actually done. A price that is
      only knowable at month end cannot be quoted before a job is submitted.
    */
    const [commitment] = await db
      .select({ committedJobs: volumeCommitments.committedJobs })
      .from(volumeCommitments)
      .where(
        and(
          eq(volumeCommitments.agentOrganisationId, organisationId),
          eq(volumeCommitments.periodStart, periodStartFor(onDate)),
        ),
      )
      .limit(1);

    return {
      agreementId: agreement.id,
      lines,
      committedJobs: commitment?.committedJobs ?? null,
    };
  } catch {
    // A pricing table that cannot be read must not become a guessed price.
    // List price is the honest answer and the one that cannot undercharge.
    return empty;
  }
}
