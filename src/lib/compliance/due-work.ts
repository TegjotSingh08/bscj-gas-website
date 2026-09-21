import "server-only";

import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  agentOrganisations,
  complianceCycles,
  customers,
  jobs,
  properties,
} from "@/lib/db/schema";
import { TERMINAL_STATUSES, type JobLifecycleStatus } from "@/lib/jobs/lifecycle";
import { parseCalendarDate } from "./renewal";

/**
 * What is due, what is overdue, and what nobody knows about.
 *
 * The operational question BSCJ actually has to answer every week, and until
 * now there was no screen that answered it: the portfolio list shows one
 * agency's properties with their due dates, and nothing showed the work itself
 * across agencies, ordered by how late it is.
 *
 * Three deliberate restraints, because this is the surface where a renewal
 * product would start inventing things:
 *
 * 1. **No thresholds are invented.** "Due soon" is whatever date range the
 *    person looking chose, shown back to them explicitly. There is no
 *    thirty-day rule here, no reminder cadence and no escalation ladder,
 *    because none of those has been decided.
 * 2. **Nothing is contacted.** This lists and links. It sends nothing to a
 *    tenant, a landlord or an agency, and it starts nothing on a schedule.
 * 3. **A property with work already in hand says so.** The failure mode of a
 *    due list is BSCJ chasing an agency for a job that was raised last week,
 *    so the open job is on the row with its reference and its status.
 *
 * A property with **no** active cycle is not silently absent. "We do not know
 * when this is due" is a real and actionable state — usually an import that
 * carried no expiry column — and hiding it would make the list look complete
 * when it is not.
 */

/** Where a property's renewal sits relative to the range being looked at. */
export type DueBucket = "overdue" | "in_range" | "later" | "unknown";

export type DueWorkRow = {
  propertyId: string;
  houseOrName: string;
  street: string;
  town: string | null;
  postcode: string;
  organisationId: string | null;
  organisationName: string | null;
  landlordName: string;
  /** Null when nothing is on file. */
  dueDate: string | null;
  productId: string | null;
  /** The most recent job on this property that has not finished. */
  openJobId: string | null;
  openJobReference: string | null;
  openJobStatus: JobLifecycleStatus | null;
  bucket: DueBucket;
};

export type DueWorkRange = { from: string; to: string };

/**
 * Where a due date sits, given the range the operator chose and today.
 *
 * `overdue` beats everything: a date that has gone by is overdue whether or
 * not it happens to fall inside the chosen window.
 */
export function bucketFor(
  dueDate: string | null,
  range: DueWorkRange,
  today: string,
): DueBucket {
  if (!dueDate || !parseCalendarDate(dueDate)) return "unknown";
  if (dueDate < today) return "overdue";
  if (dueDate >= range.from && dueDate <= range.to) return "in_range";
  return "later";
}

/**
 * A range the operator asked for, or a sensible one to start from.
 *
 * The default is **today to sixty days ahead**, and it is a starting view
 * rather than a policy: it is shown on the screen, it is editable, and nothing
 * anywhere acts on it. A malformed or inverted range falls back rather than
 * returning nothing, so a mistyped URL is not an empty screen.
 */
export function resolveRange(
  from: unknown,
  to: unknown,
  today: string,
): DueWorkRange {
  const valid = (value: unknown): string | null =>
    typeof value === "string" && parseCalendarDate(value) ? value : null;

  const fallbackFrom = today;
  const fallbackTo = addDays(today, 60);

  const start = valid(from) ?? fallbackFrom;
  const end = valid(to) ?? fallbackTo;

  if (end < start) return { from: fallbackFrom, to: fallbackTo };
  return { from: start, to: end };
}

/** Plain date arithmetic on `YYYY-MM-DD`, in UTC, with no time of day. */
function addDays(date: string, days: number): string {
  const parsed = parseCalendarDate(date);
  if (!parsed) return date;
  const shifted = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day + days),
  );
  return shifted.toISOString().slice(0, 10);
}

export type DueWorkSummary = {
  overdue: number;
  inRange: number;
  unknown: number;
};

/**
 * Every property BSCJ tracks, with its renewal position and any open job.
 *
 * One query, left-joined throughout: a property with no cycle, no agency or no
 * job still appears, because each of those absences is something to act on.
 * Admin-only by construction — there is no organisation filter, and the page
 * calling it has already required an administrator.
 */
export async function listDueWork(input: {
  range: DueWorkRange;
  today: string;
  /** Rows returned. The screen pages by tightening the range, not by scrolling. */
  limit?: number;
}): Promise<{ rows: DueWorkRow[]; summary: DueWorkSummary } | null> {
  const db = getDb();
  if (!db) return null;

  /*
    The property's active position. Left-joined, so a property with none is
    still listed — "we do not know when this is due" is the state an imported
    portfolio arrives in and the one most worth seeing.
  */
  const activeCycle = and(
    eq(complianceCycles.propertyId, properties.id),
    eq(complianceCycles.status, "active"),
  );

  /*
    An unfinished job on the property, so nobody chases work already in hand.
    `notInArray` over the terminal statuses rather than a list of open ones, so
    a status added later is treated as open — which is the safe default for a
    check whose purpose is "is something already happening here".
  */
  const openJob = and(
    eq(jobs.propertyId, properties.id),
    notInArray(jobs.lifecycleStatus, [...TERMINAL_STATUSES]),
  );

  try {
    const rows = await db
      .select({
        propertyId: properties.id,
        houseOrName: properties.houseOrName,
        street: properties.street,
        town: properties.town,
        postcode: properties.postcode,
        organisationId: properties.agentOrganisationId,
        organisationName: agentOrganisations.name,
        landlordName: customers.name,
        dueDate: complianceCycles.dueDate,
        productId: complianceCycles.productId,
        openJobId: jobs.id,
        openJobReference: jobs.reference,
        openJobStatus: jobs.lifecycleStatus,
      })
      .from(properties)
      .innerJoin(customers, eq(customers.id, properties.customerId))
      .leftJoin(agentOrganisations, eq(agentOrganisations.id, properties.agentOrganisationId))
      .leftJoin(complianceCycles, activeCycle)
      .leftJoin(jobs, openJob)
      .where(eq(properties.isActive, true))
      /*
        Nulls last, so "due soonest" leads and "we do not know" collects at the
        bottom rather than at the top where it would crowd out the work.
      */
      .orderBy(sql`${complianceCycles.dueDate} asc nulls last`, asc(properties.postcode))
      .limit(input.limit ?? 500);

    const withBuckets: DueWorkRow[] = rows.map((row) => ({
      ...row,
      openJobStatus: (row.openJobStatus as JobLifecycleStatus | null) ?? null,
      bucket: bucketFor(row.dueDate, input.range, input.today),
    }));

    return {
      rows: withBuckets,
      summary: {
        overdue: withBuckets.filter((row) => row.bucket === "overdue").length,
        inRange: withBuckets.filter((row) => row.bucket === "in_range").length,
        unknown: withBuckets.filter((row) => row.bucket === "unknown").length,
      },
    };
  } catch {
    return null;
  }
}

/** Properties with no agency at all — a consumer booking's own record. */
export const CONSUMER_PROPERTY = isNull(properties.agentOrganisationId);
