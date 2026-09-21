/**
 * What a released certificate does to a property's renewal position.
 *
 * **The gap this closes.** `releaseCertificate` wrote a `certificate` row —
 * number, version, inspection date, next due date — and stopped. The portfolio
 * screens, the deadline lookup and any due-work view all read
 * `compliance_cycle`, which nothing updated. So an administrator could review
 * and release a perfectly good CP12 and the property would still show the old
 * due date, or none at all. The record said the work was done; the renewal did
 * not know.
 *
 * Four rules shape everything below, and each of them is a thing that must not
 * happen rather than a feature:
 *
 * 1. **Only a release moves a renewal.** Uploading a PDF and marking work
 *    complete are different acts, done by different people, and neither is a
 *    review. Nothing outside the release path calls this.
 * 2. **The dates are the reviewed ones.** An administrator reads them off the
 *    certificate and types them; `compliance/renewal.ts` is deliberately *not*
 *    applied here. A renewal derived on somebody's behalf and a renewal printed
 *    on the document they are holding are two answers to one question, and only
 *    one of them is on the certificate.
 * 3. **A certificate proves the service it is a certificate for.** A CP12
 *    establishes a CP12 position. It says nothing about whether a boiler was
 *    serviced, so a boiler-service-only job establishes no position at all
 *    rather than a CP12 nobody carried out.
 * 4. **Newer evidence is never quietly overwritten by older.** Releasing or
 *    correcting a certificate on last year's job must not replace the position
 *    this year's job established. Where that would happen the position is left
 *    alone and the caller is told, rather than the history quietly moving
 *    backwards.
 *
 * Pure. The reads and writes are in `portfolio/mutations.ts`, and the call
 * comes from `documents/certificates.ts`.
 */

import { products, type ProductId } from "@/lib/booking/products";

/**
 * The services a released **gas safety certificate** may establish a position
 * for, given the product the job was raised as.
 *
 * Derived from the product registry rather than written out, so a new bundle
 * is covered by defining the product. The rule is "which of this job's
 * services does a CP12 evidence", and the answer is only ever the CP12 itself:
 *
 * - `cp12` → the CP12 position.
 * - `cp12-boiler-service` → the CP12 position. The service was carried out on
 *   the same visit, and **no certificate attests to it**, so recording a
 *   twelve-month service position from this document would be inventing a
 *   compliance claim out of an appointment.
 * - `boiler-service` → nothing. There is no certificate for a service, so a
 *   document released against one of these jobs must not create a CP12
 *   position for a gas safety check that was never part of the work.
 */
export function certifiedProductsFor(jobProductId: string): ProductId[] {
  const product = products[jobProductId as ProductId];
  if (!product) return [];

  const covered: readonly ProductId[] = product.componentIds ?? [product.id];
  return covered.filter((id) => id === "cp12");
}

/** The position a property currently holds for one service. */
export type ActivePosition = {
  id: string;
  /** Null for a position imported from a spreadsheet, where only the due date was known. */
  inspectionDate: string | null;
  dueDate: string;
  /** The job that established it, when one did. */
  establishedByJobId: string | null;
  /** The certificate that established it, when one did. */
  certificateId: string | null;
};

/** The certificate asking to establish a position. */
export type ReleasedCertificate = {
  id: string;
  jobId: string;
  inspectionDate: string;
  nextDueDate: string;
};

export type PositionDecision =
  /** Nothing holds this service's position yet. */
  | { kind: "establish" }
  /** Replace the active position, keeping it as history. */
  | { kind: "supersede"; supersedes: string }
  /** Already recorded from exactly this certificate. Nothing to do. */
  | { kind: "already_current" }
  /** A newer position holds, and older evidence does not displace it. */
  | { kind: "keep_newer"; heldDueDate: string };

/**
 * Whether the certificate being released should take the position.
 *
 * The comparison is on the **inspection date** where both are known, because
 * that is when the property was actually looked at. It falls back to the due
 * date for a position imported from a spreadsheet, which carries no inspection
 * date — all such a row says is "something is due then".
 *
 * A correction to the certificate that established the current position is
 * always applied, however its dates move: that is the whole point of a
 * correction, and refusing to let a date go backwards would make a typo
 * permanent.
 */
export function decidePosition(
  active: ActivePosition | null,
  releasing: ReleasedCertificate,
): PositionDecision {
  if (!active) return { kind: "establish" };

  // Idempotent: releasing twice, or retrying after a partial failure, is not
  // a second position.
  if (active.certificateId === releasing.id) return { kind: "already_current" };

  /*
    Our own job's position. A correction supersedes it whichever way the dates
    move — including backwards, which is exactly what correcting a mistyped
    date means.
  */
  if (active.establishedByJobId === releasing.jobId) {
    return { kind: "supersede", supersedes: active.id };
  }

  const newer =
    active.inspectionDate !== null
      ? releasing.inspectionDate > active.inspectionDate
      : releasing.nextDueDate > active.dueDate;

  if (!newer) return { kind: "keep_newer", heldDueDate: active.dueDate };

  return { kind: "supersede", supersedes: active.id };
}

/** What to tell the administrator, in one sentence, about each outcome. */
export function describeDecision(
  decision: PositionDecision,
  productName: string,
): string | null {
  switch (decision.kind) {
    case "establish":
      return `The ${productName} renewal is now recorded against this property.`;
    case "supersede":
      return `The ${productName} renewal has been updated. The previous position is kept as history.`;
    case "already_current":
      return null;
    case "keep_newer":
      return `The ${productName} renewal was left as it is: this property already holds a more recent position, due ${decision.heldDueDate}. Nothing was overwritten.`;
  }
}
