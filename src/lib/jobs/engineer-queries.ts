import "server-only";

import { and, asc, eq, gte, isNotNull, lt, notInArray } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  agentOrganisations,
  appUsers,
  customers,
  jobs,
  properties,
  tenancies,
} from "@/lib/db/schema";
import { assignmentCondition, type AccessScope } from "@/lib/auth/scope";
import { bookingConfig } from "@/lib/booking/config";
import { dayBoundsInZone } from "@/lib/booking/time";
import { TERMINAL_STATUSES, type JobLifecycleStatus } from "./lifecycle";

/**
 * The engineer's own work.
 *
 * **Every read here goes through `assignmentCondition`**, the mirror of the
 * organisation helper the admin queries use, and for the same reason: a
 * handler that built its own `WHERE` is how an engineer ends up holding
 * somebody else's day. Assignment is the entire permission — an engineer who
 * is not on a job has no more access to it than a stranger.
 *
 * **No money is selected anywhere in this file.** Not the total, not the
 * snapshot, not the appliance count that implies it. The engineer role has
 * neither `pricing:read` nor `invoice:read`, and a restricted interface that
 * happens to carry an agency's negotiated rate is not restricted. Leaving the
 * columns out of the query is stronger than leaving them out of the markup: a
 * value that is never loaded cannot be leaked by a later change to what the
 * page renders.
 */

/** Anything that is not a UUID is not a job id; Postgres would throw on it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EngineerJobRow = {
  id: string;
  reference: string;
  productId: string;
  lifecycleStatus: JobLifecycleStatus;
  appointmentStart: Date | null;
  appointmentEnd: Date | null;
  durationMinutes: number | null;
  houseOrName: string | null;
  street: string | null;
  town: string | null;
  postcode: string;
  accessNotes: string | null;
  tenantName: string | null;
  tenantPhone: string | null;
  customerName: string | null;
  customerPhone: string | null;
  workStartedAt: Date | null;
  completedAt: Date | null;
};

const ROW = {
  id: jobs.id,
  reference: jobs.reference,
  productId: jobs.productId,
  lifecycleStatus: jobs.lifecycleStatus,
  appointmentStart: jobs.appointmentStart,
  appointmentEnd: jobs.appointmentEnd,
  durationMinutes: jobs.durationMinutes,
  houseOrName: properties.houseOrName,
  street: properties.street,
  town: properties.town,
  postcode: properties.postcode,
  accessNotes: properties.accessNotes,
  tenantName: tenancies.name,
  tenantPhone: tenancies.phone,
  customerName: customers.name,
  customerPhone: customers.phone,
  workStartedAt: jobs.workStartedAt,
  completedAt: jobs.completedAt,
} as const;

/**
 * One day's work, in the order it happens.
 *
 * Completed and cancelled jobs are kept rather than hidden: an engineer
 * looking at today wants to see what they have already done as well as what
 * is left, and a list that empties itself as the day goes on gives no sense
 * of whether the day is finished.
 */
export async function listDayJobs(
  scope: AccessScope,
  isoDate: string,
): Promise<EngineerJobRow[]> {
  const db = getDb();
  if (!db) return [];

  const bounds = dayBoundsInZone(isoDate, bookingConfig.timeZone);
  if (!bounds) return [];

  const rows = await db
    .select(ROW)
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .leftJoin(tenancies, eq(tenancies.id, jobs.tenancyId))
    .leftJoin(customers, eq(customers.id, jobs.customerId))
    .where(
      assignmentCondition(
        jobs.assignedEngineerId,
        scope,
        and(
          gte(jobs.appointmentStart, bounds.start),
          lt(jobs.appointmentStart, bounds.end),
        ),
      ),
    )
    .orderBy(asc(jobs.appointmentStart));

  return rows as EngineerJobRow[];
}

/**
 * What is still to come after today.
 *
 * A short look-ahead rather than a second diary: enough for "nothing
 * tomorrow, two on Thursday" without turning the day view into a calendar.
 */
export async function listUpcomingJobs(
  scope: AccessScope,
  after: Date,
  limit = 10,
): Promise<EngineerJobRow[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db
    .select(ROW)
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .leftJoin(tenancies, eq(tenancies.id, jobs.tenancyId))
    .leftJoin(customers, eq(customers.id, jobs.customerId))
    .where(
      assignmentCondition(
        jobs.assignedEngineerId,
        scope,
        and(
          gte(jobs.appointmentStart, after),
          notInArray(jobs.lifecycleStatus, [...TERMINAL_STATUSES]),
        ),
      ),
    )
    .orderBy(asc(jobs.appointmentStart))
    .limit(limit);

  return rows as EngineerJobRow[];
}

/**
 * One assigned job, or null.
 *
 * Null covers "no such job", "not yours" and "not assigned to you" alike.
 * They are the same answer for the same reason they are everywhere else:
 * distinguishing them turns an id into a probe.
 */
export async function getAssignedJob(
  scope: AccessScope,
  id: string,
): Promise<(EngineerJobRow & { assignedEngineerId: string | null; completionNotes: string | null }) | null> {
  const db = getDb();
  if (!db || !UUID.test(id)) return null;

  const [row] = await db
    .select({
      ...ROW,
      assignedEngineerId: jobs.assignedEngineerId,
      completionNotes: jobs.completionNotes,
    })
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .leftJoin(tenancies, eq(tenancies.id, jobs.tenancyId))
    .leftJoin(customers, eq(customers.id, jobs.customerId))
    .where(assignmentCondition(jobs.assignedEngineerId, scope, eq(jobs.id, id)))
    .limit(1);

  return (row as (EngineerJobRow & { assignedEngineerId: string | null; completionNotes: string | null }) | undefined) ?? null;
}

/**
 * The next job with a time on it, whenever that is.
 *
 * Used when today is empty, so the day view says "next: Thursday at 10:00"
 * rather than nothing at all.
 */
export async function nextAssignedJob(
  scope: AccessScope,
  after: Date,
): Promise<EngineerJobRow | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select(ROW)
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .leftJoin(tenancies, eq(tenancies.id, jobs.tenancyId))
    .leftJoin(customers, eq(customers.id, jobs.customerId))
    .where(
      assignmentCondition(
        jobs.assignedEngineerId,
        scope,
        and(
          isNotNull(jobs.appointmentStart),
          gte(jobs.appointmentStart, after),
          notInArray(jobs.lifecycleStatus, [...TERMINAL_STATUSES]),
        ),
      ),
    )
    .orderBy(asc(jobs.appointmentStart))
    .limit(1);

  return (row as EngineerJobRow | undefined) ?? null;
}

/**
 * Everything the CP12 prefill needs, for one assigned job.
 *
 * A separate read from `getAssignedJob` because it reaches wider — the
 * customer's company, the agency's name and billing postcode, the allocated
 * engineer's name — and there is no reason for the job screen to pay for any
 * of that on every view.
 *
 * Scoped by `assignmentCondition` like everything else here, so an engineer
 * cannot produce a payload for a job that is not theirs. Still no money
 * column: a certificate carries no price and neither does this.
 */
export async function getJobForPrefill(
  scope: AccessScope,
  id: string,
): Promise<{
  reference: string;
  houseOrName: string | null;
  street: string | null;
  town: string | null;
  postcode: string;
  tenantName: string | null;
  tenantPhone: string | null;
  customerName: string | null;
  customerCompany: string | null;
  customerPhone: string | null;
  organisationName: string | null;
  organisationPostcode: string | null;
  engineerName: string | null;
} | null> {
  const db = getDb();
  if (!db || !UUID.test(id)) return null;

  const [row] = await db
    .select({
      reference: jobs.reference,
      houseOrName: properties.houseOrName,
      street: properties.street,
      town: properties.town,
      postcode: properties.postcode,
      tenantName: tenancies.name,
      tenantPhone: tenancies.phone,
      customerName: customers.name,
      customerCompany: customers.company,
      customerPhone: customers.phone,
      organisationName: agentOrganisations.name,
      organisationPostcode: agentOrganisations.billingPostcode,
      engineerName: appUsers.name,
    })
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .leftJoin(tenancies, eq(tenancies.id, jobs.tenancyId))
    .leftJoin(customers, eq(customers.id, jobs.customerId))
    .leftJoin(
      agentOrganisations,
      eq(agentOrganisations.id, jobs.agentOrganisationId),
    )
    .leftJoin(appUsers, eq(appUsers.id, jobs.assignedEngineerId))
    .where(assignmentCondition(jobs.assignedEngineerId, scope, eq(jobs.id, id)))
    .limit(1);

  return row ?? null;
}
