import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { customers, jobs, properties, schedulingTokens } from "@/lib/db/schema";
import { parsePriceSnapshot } from "@/lib/pricing/snapshot";

/**
 * An agency reading its own jobs.
 *
 * `organisationId` is the first argument of both functions and is in both
 * `WHERE` clauses. It comes from `requireAgent()`; there is no unscoped
 * variant, and consumer jobs — which have no organisation — are excluded by
 * construction, because null never equals a uuid.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listAgencyJobs(organisationId: string, limit = 100) {
  const db = getDb();
  if (!db) return null;

  return db
    .select({
      id: jobs.id,
      reference: jobs.reference,
      productId: jobs.productId,
      lifecycleStatus: jobs.lifecycleStatus,
      requestedAsap: jobs.requestedAsap,
      completeByDate: jobs.completeByDate,
      priceTotalPence: jobs.priceTotalPence,
      createdAt: jobs.createdAt,
      houseOrName: properties.houseOrName,
      street: properties.street,
      postcode: properties.postcode,
      propertyId: properties.id,
    })
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .where(eq(jobs.agentOrganisationId, organisationId))
    .orderBy(desc(jobs.createdAt))
    .limit(limit);
}

/**
 * One job, or null.
 *
 * Null covers "no such job" and "not yours" alike — distinguishing them turns
 * an id into a probe for which records exist.
 */
export async function getAgencyJob(organisationId: string, id: string) {
  const db = getDb();
  if (!db || !UUID.test(id)) return null;

  const [row] = await db
    .select({ job: jobs, property: properties, landlord: customers })
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .where(
      and(eq(jobs.id, id), eq(jobs.agentOrganisationId, organisationId)),
    )
    .limit(1);

  if (!row) return null;

  /*
    Whether an invitation exists, and nothing about it. The hash is never
    selected: a value that is never loaded cannot be leaked by a later change
    to what this page renders.
  */
  const [invitation] = await db
    .select({ expiresAt: schedulingTokens.expiresAt, usedAt: schedulingTokens.usedAt })
    .from(schedulingTokens)
    .where(eq(schedulingTokens.jobId, id))
    .limit(1);

  return {
    ...row,
    priceSnapshot: parsePriceSnapshot(row.job.priceSnapshot),
    invitation: invitation ?? null,
  };
}
