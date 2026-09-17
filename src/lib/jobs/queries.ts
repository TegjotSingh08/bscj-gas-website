import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { customers, jobs, properties, tenancies } from "@/lib/db/schema";
import { organisationCondition, type AccessScope } from "@/lib/auth/scope";
import { parsePriceSnapshot } from "@/lib/pricing/snapshot";

/**
 * Reading jobs, scoped to the caller.
 *
 * **Every read here goes through `organisationCondition`.** An administrator
 * gets no filter and therefore sees consumer work too, which is the point of
 * this screen; an agency user would be filtered to their own organisation, and
 * an engineer to nothing — the helper decides, not the page. A handler that
 * built its own `WHERE` is the failure the whole scope design exists to make
 * hard, so there is deliberately no query in this file that does not take a
 * scope.
 */

export type JobListRow = {
  id: string;
  reference: string;
  productId: string;
  lifecycleStatus: string;
  appointmentStart: Date | null;
  priceTotalPence: number;
  source: string;
  customerName: string | null;
  postcode: string | null;
  createdAt: Date;
};

export async function listJobs(
  scope: AccessScope,
  limit = 50,
): Promise<JobListRow[] | null> {
  const db = getDb();
  if (!db) return null;

  return db
    .select({
      id: jobs.id,
      reference: jobs.reference,
      productId: jobs.productId,
      lifecycleStatus: jobs.lifecycleStatus,
      appointmentStart: jobs.appointmentStart,
      priceTotalPence: jobs.priceTotalPence,
      source: jobs.source,
      customerName: customers.name,
      postcode: properties.postcode,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .leftJoin(customers, eq(customers.id, jobs.customerId))
    .leftJoin(properties, eq(properties.id, jobs.propertyId))
    .where(organisationCondition(jobs.agentOrganisationId, scope))
    .orderBy(desc(jobs.createdAt))
    .limit(limit);
}

export type JobDetail = NonNullable<Awaited<ReturnType<typeof getJob>>>;

/** Anything that is not a UUID is not a job id; Postgres would throw on it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One job, or null.
 *
 * Null covers both "no such job" and "not yours". They are deliberately the
 * same answer: distinguishing them turns an id into a probe for which records
 * exist. The scope filter is applied in the query rather than checked after,
 * so an out-of-scope row is never loaded in the first place.
 */
export async function getJob(scope: AccessScope, id: string) {
  const db = getDb();
  if (!db) return null;
  if (!UUID.test(id)) return null;

  const scopeFilter = organisationCondition(jobs.agentOrganisationId, scope);

  const [row] = await db
    .select({
      job: jobs,
      customer: customers,
      property: properties,
      tenancy: tenancies,
    })
    .from(jobs)
    .leftJoin(customers, eq(customers.id, jobs.customerId))
    .leftJoin(properties, eq(properties.id, jobs.propertyId))
    .leftJoin(tenancies, eq(tenancies.id, jobs.tenancyId))
    .where(scopeFilter ? and(eq(jobs.id, id), scopeFilter) : eq(jobs.id, id))
    .limit(1);

  if (!row) return null;

  return {
    ...row,
    priceSnapshot: parsePriceSnapshot(row.job.priceSnapshot),
  };
}
