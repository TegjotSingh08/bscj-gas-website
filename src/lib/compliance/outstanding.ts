import "server-only";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { certificates, complianceCycles, jobs, properties } from "@/lib/db/schema";
import {
  certifiedProductsFor,
  decidePosition,
  type ActivePosition,
} from "./position";

/**
 * Certificates that were released without their renewal moving.
 *
 * **Why this is a query and not a flag.** Releasing writes the certificate and
 * then the compliance position, and the two cannot be one statement — the cycle
 * has to point at the certificate's id, which does not exist until the
 * certificate is inserted. So the second write can fail on its own, or the
 * process can stop between them. A response is transient; the unresolved state
 * has to be discoverable from the records themselves.
 *
 * ---
 *
 * **What the first version got wrong, and it mattered.** It asked "is there an
 * active cycle pointing at this certificate", and called everything else an
 * unresolved repair. That is true of a genuine failure. It is equally true of:
 *
 * - **a certificate a later visit legitimately replaced.** Job A establishes
 *   the position; next year job B supersedes it. A's certificate is still
 *   `issued` — a different job's release does not supersede it, and should not
 *   — and no cycle points at it any more. It is history, not a repair.
 * - **a certificate the rules correctly declined to apply.** An older job
 *   released late, where `decidePosition` answers `keep_newer`. Retrying it
 *   declines again, so the alert could never be cleared by the one button
 *   offered to clear it.
 *
 * Both would have sat on the reconciliation page permanently, advertising work
 * nobody could do, until everyone learned to ignore the list — which would then
 * hide the genuine failures too.
 *
 * So the question is not "does a cycle point at this" but **"would applying
 * this certificate now actually establish or supersede a position"**, and that
 * is a question `decidePosition` already answers. The same rule decides what is
 * outstanding and what a retry would do, so the list can only ever contain
 * repairs the button can make.
 *
 * Nothing is deleted, nothing unrelated is marked superseded, and no genuine
 * failure is hidden: the narrowing happens on the decision, not on the history.
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
 * Whether one certificate's renewal is outstanding.
 *
 * `unavailable` is its own answer, not a comfortable `resolved`. A page that
 * cannot read this must not tell an administrator there is nothing wrong — the
 * one thing it does not know is exactly that.
 */
export type RenewalState = "outstanding" | "resolved" | "unavailable";

/** A certificate that might need applying, before the rules have judged it. */
type Candidate = {
  certificateId: string;
  version: number;
  certificateNumber: string;
  jobId: string;
  jobReference: string;
  jobProductId: string;
  propertyId: string;
  houseOrName: string;
  postcode: string;
  organisationId: string | null;
  inspectionDate: string;
  nextDueDate: string;
  issuedAt: Date;
};

/**
 * The cheap part, in SQL: certificates that *could* be outstanding.
 *
 * Issued, on a job whose product a certificate evidences, and with no active
 * cycle already pointing at them — a cycle that does point at one is
 * `already_current` by definition, and excluding those here keeps the set small
 * before the rules are applied per row.
 */
function candidateWhere() {
  return and(
    eq(certificates.status, "issued"),
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

const CANDIDATE_COLUMNS = {
  certificateId: certificates.id,
  version: certificates.version,
  certificateNumber: certificates.certificateNumber,
  jobId: jobs.id,
  jobReference: jobs.reference,
  jobProductId: jobs.productId,
  propertyId: properties.id,
  houseOrName: properties.houseOrName,
  postcode: properties.postcode,
  organisationId: properties.agentOrganisationId,
  inspectionDate: certificates.inspectionDate,
  nextDueDate: certificates.nextDueDate,
  issuedAt: certificates.issuedAt,
};

function candidateQuery(db: NonNullable<ReturnType<typeof getDb>>) {
  return db
    .select(CANDIDATE_COLUMNS)
    .from(certificates)
    .innerJoin(jobs, eq(jobs.id, certificates.jobId))
    .innerJoin(properties, eq(properties.id, certificates.propertyId))
    .leftJoin(
      complianceCycles,
      and(
        eq(complianceCycles.certificateId, certificates.id),
        eq(complianceCycles.status, "active"),
      ),
    );
}

/**
 * The positions those candidates would be judged against, in one query.
 *
 * Keyed by property and service, with the version of the certificate that
 * established each — which is what tells two documents of one job apart.
 */
async function activePositionsFor(
  db: NonNullable<ReturnType<typeof getDb>>,
  propertyIds: string[],
): Promise<Map<string, ActivePosition>> {
  const positions = new Map<string, ActivePosition>();
  if (propertyIds.length === 0) return positions;

  const rows = await db
    .select({
      id: complianceCycles.id,
      propertyId: complianceCycles.propertyId,
      productId: complianceCycles.productId,
      inspectionDate: complianceCycles.inspectionDate,
      dueDate: complianceCycles.dueDate,
      establishedByJobId: complianceCycles.establishedByJobId,
      certificateId: complianceCycles.certificateId,
      certificateVersion: certificates.version,
    })
    .from(complianceCycles)
    .leftJoin(certificates, eq(certificates.id, complianceCycles.certificateId))
    .where(
      and(
        inArray(complianceCycles.propertyId, propertyIds),
        eq(complianceCycles.status, "active"),
      ),
    );

  for (const row of rows) {
    positions.set(`${row.propertyId}:${row.productId}`, {
      id: row.id,
      inspectionDate: row.inspectionDate,
      dueDate: row.dueDate,
      establishedByJobId: row.establishedByJobId,
      certificateId: row.certificateId,
      certificateVersion: row.certificateVersion ?? null,
    });
  }

  return positions;
}

/**
 * Whether applying this candidate would actually change something.
 *
 * `establish` and `supersede` are repairs a retry can make. `keep_newer`,
 * `superseded_by_correction` and `already_current` are the rules working —
 * the position that stands is the right one, and no button can or should
 * change it.
 */
function needsApplying(
  candidate: Candidate,
  positions: Map<string, ActivePosition>,
): boolean {
  const productIds = certifiedProductsFor(candidate.jobProductId);
  if (productIds.length === 0) return false;

  return productIds.some((productId) => {
    const active = positions.get(`${candidate.propertyId}:${productId}`) ?? null;
    const decision = decidePosition(active, {
      id: candidate.certificateId,
      jobId: candidate.jobId,
      inspectionDate: candidate.inspectionDate,
      nextDueDate: candidate.nextDueDate,
      version: candidate.version,
    });
    return decision.kind === "establish" || decision.kind === "supersede";
  });
}

/**
 * Every certificate whose renewal did not land, oldest first.
 *
 * Oldest first because the one outstanding longest is the one worth looking at.
 * Null means the records could not be read — which the caller must report as
 * unknown rather than as an empty list.
 */
export async function listOutstandingRenewals(
  limit = 50,
): Promise<OutstandingRenewal[] | null> {
  const db = getDb();
  if (!db) return null;

  try {
    const candidates = (await candidateQuery(db)
      .where(candidateWhere())
      .orderBy(asc(certificates.issuedAt))
      /*
        A wider slice than the caller asked for, because the rules below remove
        the ones that are merely history. Bounded so a portfolio with years of
        certificates cannot turn this into a full scan.
      */
      .limit(Math.max(limit * 4, 200))) as Candidate[];

    if (candidates.length === 0) return [];

    const positions = await activePositionsFor(
      db,
      [...new Set(candidates.map((candidate) => candidate.propertyId))],
    );

    return candidates
      .filter((candidate) => needsApplying(candidate, positions))
      .slice(0, limit)
      .map(({ jobProductId: _jobProductId, inspectionDate: _inspectionDate, ...row }) => row);
  } catch {
    return null;
  }
}

/**
 * Whether this one certificate's renewal is outstanding.
 *
 * For the job page, which already has the certificate in hand. It returns
 * `unavailable` rather than `resolved` when the records cannot be read: a
 * confident "nothing is wrong" from a failed query is the one answer that
 * would let a real failure sit unnoticed.
 */
export async function renewalIsOutstanding(
  certificateId: string,
): Promise<RenewalState> {
  const db = getDb();
  if (!db) return "unavailable";

  try {
    const [candidate] = (await candidateQuery(db)
      .where(and(eq(certificates.id, certificateId), candidateWhere()))
      .limit(1)) as Candidate[];

    // Not a candidate at all: already current, superseded, or a service job.
    if (!candidate) return "resolved";

    const positions = await activePositionsFor(db, [candidate.propertyId]);
    return needsApplying(candidate, positions) ? "outstanding" : "resolved";
  } catch {
    return "unavailable";
  }
}
