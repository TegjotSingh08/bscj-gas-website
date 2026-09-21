import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { certificates, complianceCycles, jobs, properties } from "@/lib/db/schema";
import { certifiedProductsFor } from "./position";

/**
 * Certificates that were released without their renewal moving.
 *
 * **Why this is a query and not a flag.** Releasing writes the certificate and
 * then the compliance position, and the two cannot be one statement — the cycle
 * has to point at the certificate's id, which does not exist until the
 * certificate is inserted. So the second write can fail on its own, or the
 * process can stop between them.
 *
 * The release already reported that in its response. A response is transient:
 * the administrator refreshes, or closes the tab, or somebody else looks at the
 * job tomorrow, and the only record that anything was left undone is gone.
 * **The unresolved state has to be discoverable from the records themselves**,
 * and it is — an issued certificate for a service with no active position
 * pointing at it *is* the state, with nothing extra stored to go stale.
 *
 * No new table and no second queue. The existing `certificate` and
 * `compliance_cycle` rows already say it; this only asks the question.
 */

export type OutstandingRenewal = {
  certificateId: string;
  version: number;
  certificateNumber: string;
  jobId: string;
  jobReference: string;
  propertyId: string;
  houseOrName: string;
  postcode: string;
  organisationId: string | null;
  nextDueDate: string;
  issuedAt: Date;
};

/**
 * The one condition, expressed once.
 *
 * An issued certificate on a job whose product a CP12 evidences, where no
 * active compliance cycle for that service points at this certificate.
 * `boiler-service` jobs are excluded by construction, because a released
 * document on one of those is *supposed* to move nothing.
 */
function outstandingWhere() {
  return and(
    eq(certificates.status, "issued"),
    /*
      Only jobs whose product a certificate actually certifies. Everything
      `certifiedProductsFor` returns nothing for would otherwise be reported as
      permanently outstanding, which is the opposite of the truth.
    */
    sql`${jobs.productId} in ${certifiedJobProducts()}`,
    isNull(complianceCycles.id),
  );
}

/** Job products for which a released certificate should establish a position. */
function certifiedJobProducts() {
  const ids = ["cp12", "boiler-service", "cp12-boiler-service"].filter(
    (id) => certifiedProductsFor(id).length > 0,
  );
  return sql`(${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

/**
 * Every certificate whose renewal did not land, oldest first.
 *
 * Oldest first because the one that has been outstanding longest is the one
 * worth looking at — the opposite of what a newest-first list shows.
 */
export async function listOutstandingRenewals(
  limit = 50,
): Promise<OutstandingRenewal[] | null> {
  const db = getDb();
  if (!db) return null;

  try {
    return await db
      .select({
        certificateId: certificates.id,
        version: certificates.version,
        certificateNumber: certificates.certificateNumber,
        jobId: jobs.id,
        jobReference: jobs.reference,
        propertyId: properties.id,
        houseOrName: properties.houseOrName,
        postcode: properties.postcode,
        organisationId: properties.agentOrganisationId,
        nextDueDate: certificates.nextDueDate,
        issuedAt: certificates.issuedAt,
      })
      .from(certificates)
      .innerJoin(jobs, eq(jobs.id, certificates.jobId))
      .innerJoin(properties, eq(properties.id, certificates.propertyId))
      .leftJoin(
        complianceCycles,
        and(
          eq(complianceCycles.certificateId, certificates.id),
          eq(complianceCycles.status, "active"),
        ),
      )
      .where(outstandingWhere())
      .orderBy(asc(certificates.issuedAt))
      .limit(limit);
  } catch {
    return null;
  }
}

/**
 * Whether this one certificate's renewal is outstanding.
 *
 * For the job page, which already has the certificate in hand and only needs to
 * know whether to say so beside it.
 */
export async function renewalIsOutstanding(
  certificateId: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  try {
    const [row] = await db
      .select({ id: certificates.id })
      .from(certificates)
      .innerJoin(jobs, eq(jobs.id, certificates.jobId))
      .leftJoin(
        complianceCycles,
        and(
          eq(complianceCycles.certificateId, certificates.id),
          eq(complianceCycles.status, "active"),
        ),
      )
      .where(and(eq(certificates.id, certificateId), outstandingWhere()))
      .limit(1);

    return Boolean(row);
  } catch {
    // Unknown is not outstanding. A page that cannot read this should not
    // invent an alarm, and the reconciliation list is the backstop.
    return false;
  }
}
