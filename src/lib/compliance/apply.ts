import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { activities, certificates, complianceCycles } from "@/lib/db/schema";
import { productFor } from "@/lib/booking/products";
import {
  certifiedProductsFor,
  decidePosition,
  describeDecision,
  type ActivePosition,
  type PositionDecision,
  type ReleasedCertificate,
} from "./position";

/**
 * Moving a property's renewal when a certificate is released.
 *
 * The decision is in `position.ts` and is pure. This is the part that reads the
 * position the property currently holds and writes the new one, and everything
 * awkward about it is here rather than there.
 *
 * **It is idempotent on purpose.** Releasing is one act, but the certificate
 * row and the compliance row cannot be written in one statement — the cycle
 * needs the certificate's id, which only exists once the certificate is
 * inserted. So the cycle write is a second step, and a second step can fail on
 * its own. Making this safe to call again turns "released, renewal not moved"
 * from a silent inconsistency into a state the administrator can see on the
 * job and clear with a button, and turns a double submit into a no-op.
 *
 * Nothing here derives a date. The inspection date and the next due date are
 * the ones an administrator read off the certificate and typed.
 */

export type ComplianceApplication =
  | { status: "ok"; decisions: { productId: string; decision: PositionDecision }[]; message: string | null }
  /** The job's service produces no certificate position — a boiler service. */
  | { status: "not_applicable" }
  | { status: "not_configured" }
  /**
   * This certificate has been corrected since, so it is not the one that
   * governs. Nothing was written, and that is the correct outcome rather than
   * a failure to retry.
   */
  | { status: "superseded_certificate" }
  /** Written nothing. The certificate stands; the renewal did not move. */
  | { status: "failed" };

/**
 * Applies a released certificate to the property's renewal position(s).
 *
 * `organisationId` is null for a consumer booking, which has no agency. That is
 * a real case and is matched with `IS NULL` rather than skipped: a private
 * customer's CP12 renewal is exactly as real as an agency's.
 */
export async function applyCertificateToCompliance(input: {
  organisationId: string | null;
  propertyId: string;
  jobId: string;
  jobProductId: string;
  certificate: ReleasedCertificate;
  actorUserId: string;
}): Promise<ComplianceApplication> {
  const db = getDb();
  if (!db) return { status: "not_configured" };

  /*
    Which services this certificate actually evidences. A boiler-service-only
    job yields none — there is no certificate for a service, and recording a
    CP12 position from one would claim a gas safety check that was never part
    of the work.
  */
  const productIds = certifiedProductsFor(input.jobProductId);
  if (productIds.length === 0) return { status: "not_applicable" };

  /*
    **Is this certificate still the one that governs?**

    The write that created it and the write that moves the renewal cannot be one
    statement — the cycle has to point at the certificate's id, which does not
    exist until the certificate is inserted. So there is a gap, and in that gap
    somebody can release a correction. When they do, this document is marked
    `superseded`, and applying its dates afterwards would put the property back
    on a date that has already been corrected.

    Re-read rather than trusted from the caller: the caller's copy was true when
    it was fetched, which is exactly the thing in question.
  */
  let releasingVersion: number;
  try {
    const [current] = await db
      .select({
        status: certificates.status,
        version: certificates.version,
      })
      .from(certificates)
      .where(eq(certificates.id, input.certificate.id))
      .limit(1);

    if (!current) return { status: "failed" };
    if (current.status !== "issued") return { status: "superseded_certificate" };
    releasingVersion = current.version;
  } catch {
    return { status: "failed" };
  }

  const releasing = { ...input.certificate, version: releasingVersion };

  const ownership = input.organisationId
    ? eq(complianceCycles.agentOrganisationId, input.organisationId)
    : isNull(complianceCycles.agentOrganisationId);

  const decisions: { productId: string; decision: PositionDecision }[] = [];
  const messages: string[] = [];

  try {
    for (const productId of productIds) {
      const [current] = await db
        .select({
          id: complianceCycles.id,
          inspectionDate: complianceCycles.inspectionDate,
          dueDate: complianceCycles.dueDate,
          establishedByJobId: complianceCycles.establishedByJobId,
          certificateId: complianceCycles.certificateId,
          /*
            Which version put it there. Left-joined, because a position
            imported from a spreadsheet has no certificate at all.
          */
          certificateVersion: certificates.version,
        })
        .from(complianceCycles)
        .leftJoin(certificates, eq(certificates.id, complianceCycles.certificateId))
        .where(
          and(
            eq(complianceCycles.propertyId, input.propertyId),
            eq(complianceCycles.productId, productId),
            eq(complianceCycles.status, "active"),
            ownership,
          ),
        )
        .limit(1);

      const active: ActivePosition | null = current
        ? {
            id: current.id,
            inspectionDate: current.inspectionDate,
            dueDate: current.dueDate,
            establishedByJobId: current.establishedByJobId,
            certificateId: current.certificateId,
            certificateVersion: current.certificateVersion ?? null,
          }
        : null;

      const decision = decidePosition(active, releasing);
      decisions.push({ productId, decision });

      const note = describeDecision(decision, productFor(productId).subjectName);
      if (note) messages.push(note);

      if (
        decision.kind === "already_current" ||
        decision.kind === "keep_newer" ||
        decision.kind === "superseded_by_correction"
      ) {
        /*
          Recorded even though nothing changed, because "we looked at this and
          deliberately left it" is the answer to a question somebody will ask
          when they notice the due date did not move.
        */
        if (decision.kind !== "already_current") {
          await db.insert(activities).values({
            jobId: input.jobId,
            propertyId: input.propertyId,
            agentOrganisationId: input.organisationId,
            kind: "compliance.position_kept",
            actor: `user:${input.actorUserId}`,
            detail:
              decision.kind === "keep_newer"
                ? {
                    productId,
                    heldDueDate: decision.heldDueDate,
                    certificateId: input.certificate.id,
                  }
                : {
                    productId,
                    heldVersion: decision.heldVersion,
                    certificateId: input.certificate.id,
                    reason: "superseded_by_correction",
                  },
          });
        }
        continue;
      }

      /*
        Supersede and establish together. A property with two active positions
        for one service, or none where it had one, are both worse than a
        failure the administrator can retry — and retrying is safe, because a
        cycle already pointing at this certificate is `already_current`.
      */
      const statements = [];
      if (decision.kind === "supersede") {
        statements.push(
          db
            .update(complianceCycles)
            .set({ status: "superseded", supersededAt: new Date() })
            .where(
              and(
                eq(complianceCycles.id, decision.supersedes),
                // Conditional on it still being active, so two callers racing
                // cannot both believe they superseded it.
                eq(complianceCycles.status, "active"),
              ),
            ),
        );
      }

      statements.push(
        db.insert(complianceCycles).values({
          propertyId: input.propertyId,
          agentOrganisationId: input.organisationId,
          productId,
          establishedByJobId: input.jobId,
          certificateId: releasing.id,
          inspectionDate: releasing.inspectionDate,
          dueDate: releasing.nextDueDate,
          /*
            `manual`: a person read this date off the certificate and typed it.
            The renewal rule in `renewal.ts` is not applied — the date on the
            document the customer holds is the date that governs.
          */
          dueDateSource: "manual",
          status: "active",
        }),
        db.insert(activities).values({
          jobId: input.jobId,
          propertyId: input.propertyId,
          agentOrganisationId: input.organisationId,
          kind: "compliance.established",
          actor: `user:${input.actorUserId}`,
          detail: {
            productId,
            dueDate: releasing.nextDueDate,
            inspectionDate: releasing.inspectionDate,
            certificateId: releasing.id,
            version: releasing.version,
            superseded: decision.kind === "supersede" ? decision.supersedes : null,
          },
        }),
      );

      await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
    }
  } catch {
    return { status: "failed" };
  }

  return {
    status: "ok",
    decisions,
    message: messages.length > 0 ? messages.join(" ") : null,
  };
}
