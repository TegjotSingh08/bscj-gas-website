import "server-only";

import { and, asc, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  complianceCycles,
  customers,
  jobs,
  properties,
  tenancies,
} from "@/lib/db/schema";

/**
 * Reading an agency's portfolio.
 *
 * **Every function here takes `organisationId` as its first argument, and
 * every query filters on it.** The value comes from `requireAgent()` at the
 * call site and never from a form, a search param or a route segment — an id
 * in a URL is only ever the *subject* of a check, never the authority for one.
 *
 * That is why there is no unscoped variant of anything below, and why the
 * organisation is a required parameter rather than an option: a query that
 * could be called without one is a query somebody eventually calls without one.
 *
 * Consumer records have no organisation, so `eq(column, organisationId)`
 * excludes them by construction — null never equals a uuid.
 */

/** Anything that is not a UUID is not an id; Postgres would throw on it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isId = (value: string): boolean => UUID.test(value);

/** The current tenancy is the one that has not ended. */
const currentTenancy = and(
  eq(tenancies.propertyId, properties.id),
  isNull(tenancies.endedOn),
);

/** The active compliance cycle, if the property has one. */
const activeCycle = and(
  eq(complianceCycles.propertyId, properties.id),
  eq(complianceCycles.status, "active"),
);

export type PortfolioRow = {
  id: string;
  houseOrName: string;
  street: string;
  town: string | null;
  postcode: string;
  landlordId: string;
  landlordName: string;
  tenantName: string | null;
  tenantEmail: string | null;
  tenantPhone: string | null;
  tenancyId: string | null;
  dueDate: string | null;
  openJobs: number;
};

/**
 * The portfolio list.
 *
 * One query rather than a list plus a lookup per row: a hundred properties
 * would otherwise be a hundred round trips, and an agency with a hundred
 * properties is exactly the customer this product is for.
 */
export async function listPortfolio(
  organisationId: string,
  search = "",
): Promise<PortfolioRow[] | null> {
  const db = getDb();
  if (!db) return null;

  const term = search.trim();
  const like = `%${term}%`;

  const filter = term
    ? and(
        eq(properties.agentOrganisationId, organisationId),
        eq(properties.isActive, true),
        or(
          ilike(properties.houseOrName, like),
          ilike(properties.street, like),
          ilike(properties.postcode, like),
          ilike(properties.town, like),
          ilike(customers.name, like),
          ilike(tenancies.name, like),
        ),
      )
    : and(
        eq(properties.agentOrganisationId, organisationId),
        eq(properties.isActive, true),
      );

  return db
    .select({
      id: properties.id,
      houseOrName: properties.houseOrName,
      street: properties.street,
      town: properties.town,
      postcode: properties.postcode,
      landlordId: customers.id,
      landlordName: customers.name,
      tenantName: tenancies.name,
      tenantEmail: tenancies.email,
      tenantPhone: tenancies.phone,
      tenancyId: tenancies.id,
      dueDate: complianceCycles.dueDate,
      openJobs: sql<number>`0`,
    })
    .from(properties)
    .innerJoin(customers, eq(customers.id, properties.customerId))
    .leftJoin(tenancies, currentTenancy)
    .leftJoin(complianceCycles, activeCycle)
    .where(filter)
    .orderBy(asc(properties.postcode), asc(properties.houseOrName))
    .limit(500);
}

export type PortfolioSummary = {
  properties: number;
  landlords: number;
  withTenant: number;
  withCompliance: number;
};

/** The counts the overview header shows. Scoped like everything else. */
export async function portfolioSummary(
  organisationId: string,
): Promise<PortfolioSummary | null> {
  const db = getDb();
  if (!db) return null;

  const [propertyCount] = await db
    .select({ n: count() })
    .from(properties)
    .where(
      and(
        eq(properties.agentOrganisationId, organisationId),
        eq(properties.isActive, true),
      ),
    );

  const [landlordCount] = await db
    .select({ n: count() })
    .from(customers)
    .where(
      and(
        eq(customers.agentOrganisationId, organisationId),
        eq(customers.isActive, true),
      ),
    );

  const [tenanted] = await db
    .select({ n: count() })
    .from(properties)
    .innerJoin(tenancies, currentTenancy)
    .where(
      and(
        eq(properties.agentOrganisationId, organisationId),
        eq(properties.isActive, true),
      ),
    );

  const [compliant] = await db
    .select({ n: count() })
    .from(properties)
    .innerJoin(complianceCycles, activeCycle)
    .where(
      and(
        eq(properties.agentOrganisationId, organisationId),
        eq(properties.isActive, true),
      ),
    );

  return {
    properties: propertyCount?.n ?? 0,
    landlords: landlordCount?.n ?? 0,
    withTenant: tenanted?.n ?? 0,
    withCompliance: compliant?.n ?? 0,
  };
}

/** Landlords, with how many properties each holds. For the picker and the list. */
export async function listLandlords(organisationId: string) {
  const db = getDb();
  if (!db) return null;

  return db
    .select({
      id: customers.id,
      name: customers.name,
      company: customers.company,
      email: customers.email,
      phone: customers.phone,
      isActive: customers.isActive,
      propertyCount: count(properties.id),
    })
    .from(customers)
    .leftJoin(properties, eq(properties.customerId, customers.id))
    .where(eq(customers.agentOrganisationId, organisationId))
    .groupBy(customers.id)
    .orderBy(asc(customers.name));
}

/**
 * One landlord and their properties, or null.
 *
 * Null covers both "no such landlord" and "not yours". They are deliberately
 * the same answer: distinguishing them turns an id into a probe for which
 * records exist. The organisation is in the `WHERE`, so an out-of-scope row is
 * never loaded in the first place rather than loaded and then checked.
 */
export async function getLandlord(organisationId: string, id: string) {
  const db = getDb();
  if (!db || !isId(id)) return null;

  const [landlord] = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.id, id),
        eq(customers.agentOrganisationId, organisationId),
      ),
    )
    .limit(1);

  if (!landlord) return null;

  const owned = await db
    .select({
      id: properties.id,
      houseOrName: properties.houseOrName,
      street: properties.street,
      postcode: properties.postcode,
      isActive: properties.isActive,
    })
    .from(properties)
    .where(
      and(
        eq(properties.customerId, id),
        eq(properties.agentOrganisationId, organisationId),
      ),
    )
    .orderBy(asc(properties.postcode));

  return { landlord, properties: owned };
}

/** One property, its landlord, its tenancy history and its compliance position. */
export async function getProperty(organisationId: string, id: string) {
  const db = getDb();
  if (!db || !isId(id)) return null;

  const [row] = await db
    .select({ property: properties, landlord: customers })
    .from(properties)
    .innerJoin(customers, eq(customers.id, properties.customerId))
    .where(
      and(
        eq(properties.id, id),
        eq(properties.agentOrganisationId, organisationId),
      ),
    )
    .limit(1);

  if (!row) return null;

  /*
    Every tenancy, not just the current one. A property's letting history is
    what makes "who did we contact last year" answerable, and it is the reason
    a tenant change ends one row and starts another rather than overwriting.
  */
  const history = await db
    .select()
    .from(tenancies)
    .where(eq(tenancies.propertyId, id))
    .orderBy(desc(tenancies.createdAt));

  const cycles = await db
    .select()
    .from(complianceCycles)
    .where(
      and(
        eq(complianceCycles.propertyId, id),
        eq(complianceCycles.agentOrganisationId, organisationId),
      ),
    )
    .orderBy(desc(complianceCycles.dueDate));

  const propertyJobs = await db
    .select({
      id: jobs.id,
      reference: jobs.reference,
      productId: jobs.productId,
      lifecycleStatus: jobs.lifecycleStatus,
      appointmentStart: jobs.appointmentStart,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.propertyId, id),
        eq(jobs.agentOrganisationId, organisationId),
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(20);

  return {
    property: row.property,
    landlord: row.landlord,
    tenancies: history,
    current: history.find((tenancy) => tenancy.endedOn === null) ?? null,
    cycles,
    activeCycle: cycles.find((cycle) => cycle.status === "active") ?? null,
    jobs: propertyJobs,
  };
}

/** Whether this agency already holds this address. Used before an insert. */
export async function findDuplicateProperty(
  organisationId: string,
  postcode: string,
  houseOrName: string,
): Promise<string | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(
      and(
        eq(properties.agentOrganisationId, organisationId),
        eq(properties.postcode, postcode),
        sql`lower(${properties.houseOrName}) = lower(${houseOrName})`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}
