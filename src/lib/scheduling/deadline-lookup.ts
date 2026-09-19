import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { complianceCycles, jobs } from "@/lib/db/schema";
import { bookingConfig } from "@/lib/booking/config";
import { resolveDeadline, type SchedulingDeadline } from "./deadline";

/**
 * Reading the two dates a cutoff is made of.
 *
 * Deliberately its own function and **called again at confirmation**. The
 * tenant's page resolves a deadline to decide what to offer; minutes later the
 * confirmation re-reads it, because an agent can change `complete_by_date` and
 * a certificate can be superseded while a tenant is choosing. Filtering in the
 * browser decides what is *shown*; this decides what is *allowed*.
 *
 * The compliance cycle is matched on the property **and the product**: a
 * property can hold an active cycle for a CP12 and another for a boiler
 * service, and the due date of one says nothing about the other. Only `active`
 * cycles count — a superseded or cancelled one describes a position that has
 * already been replaced.
 */

export type JobDeadlineFacts = {
  /** The cutoff, with both underlying dates preserved. */
  deadline: SchedulingDeadline;
  /** The active compliance cycle the certificate date came from, if any. */
  complianceCycleId: string | null;
};

const EMPTY: JobDeadlineFacts = {
  deadline: resolveDeadline(
    { requestedBy: null, certificateDueBy: null },
    bookingConfig.timeZone,
  ),
  complianceCycleId: null,
};

export async function fetchJobDeadline(
  jobId: string,
  timeZone = bookingConfig.timeZone,
): Promise<JobDeadlineFacts> {
  const db = getDb();
  if (!db) return EMPTY;

  try {
    const [job] = await db
      .select({
        completeByDate: jobs.completeByDate,
        propertyId: jobs.propertyId,
        productId: jobs.productId,
      })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);

    if (!job) return EMPTY;

    const [cycle] = await db
      .select({ id: complianceCycles.id, dueDate: complianceCycles.dueDate })
      .from(complianceCycles)
      .where(
        and(
          eq(complianceCycles.propertyId, job.propertyId),
          eq(complianceCycles.productId, job.productId),
          eq(complianceCycles.status, "active"),
        ),
      )
      .limit(1);

    return {
      deadline: resolveDeadline(
        {
          requestedBy: job.completeByDate,
          certificateDueBy: cycle?.dueDate ?? null,
        },
        timeZone,
      ),
      complianceCycleId: cycle?.id ?? null,
    };
  } catch {
    /*
      A read that failed is **not** "no deadline".

      But it cannot be allowed to refuse a tenant an appointment either, so it
      degrades to normal availability and says nothing about a deadline — which
      is the same behaviour every job had before this phase. The one thing it
      must never do is record an exception against a cutoff it could not read.
    */
    return EMPTY;
  }
}
