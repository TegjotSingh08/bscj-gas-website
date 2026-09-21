import "server-only";

import { and, asc, eq, inArray, notInArray, or, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  agentOrganisations,
  complianceCycles,
  customers,
  jobs,
  properties,
} from "@/lib/db/schema";
import { products, type ProductId } from "@/lib/booking/products";
import { TERMINAL_STATUSES, type JobLifecycleStatus } from "@/lib/jobs/lifecycle";
import { parseCalendarDate } from "./renewal";

/**
 * What is due, what is overdue, and what nobody knows about.
 *
 * **The unit is a property *and a service*, not a property.** A house can owe a
 * CP12 in March and a boiler service in September; collapsing those into one
 * row would have to pick a date, and picking one hides the other. A property
 * with no compliance position at all appears once, as the "we do not know"
 * unit, because that is a real and actionable state rather than an absence.
 *
 * Three restraints, because this is where a renewal product would start
 * inventing things:
 *
 * 1. **No thresholds are invented.** "Due soon" is the date range the person
 *    looking chose, shown back to them. No cadence, no escalation.
 * 2. **Nothing is contacted.** This lists and links.
 * 3. **An open job is only shown against the service it actually covers.** A
 *    boiler-service job says nothing about an outstanding CP12, and showing it
 *    beside one would tell an operator the work was in hand when it was not.
 *
 * ---
 *
 * **What was wrong with the first version**, because each fault produced a
 * different flavour of wrong number:
 *
 * - Open jobs were joined to active cycles, so a property with two cycles and
 *   three open jobs became six rows and counted six times.
 * - Any open job matched any cycle, so a boiler service made a CP12 look
 *   covered.
 * - `LIMIT 500` was applied to those multiplied rows *before* anything was
 *   bucketed, and unknown dates sort last — so on a portfolio of any size the
 *   properties with no date on file, which are the ones most worth seeing,
 *   were the first to fall off the end.
 * - Widening the date range could not bring back a row the limit had already
 *   discarded, so the filter silently did not work.
 *
 * The filtering and the counting are now the database's, the page is a real
 * page of a known total, and jobs are gathered per visible row rather than
 * joined.
 */

/** Where a property's renewal sits relative to the range being looked at. */
export type DueBucket = "overdue" | "in_range" | "later" | "unknown";

/** One open job, as a row needs to show it. */
export type RelevantJob = {
  id: string;
  reference: string;
  status: JobLifecycleStatus;
  productId: string;
};

export type DueWorkRow = {
  /**
   * Stable and unique across the whole list: the property and the service.
   *
   * `<propertyId>:<productId>` for a real position, `<propertyId>:unknown` for
   * a property that has none. Two rows can never collide, which a property id
   * alone could not promise once a property owes two services.
   */
  key: string;
  propertyId: string;
  houseOrName: string;
  street: string;
  town: string | null;
  postcode: string;
  organisationId: string | null;
  organisationName: string | null;
  landlordName: string;
  /** Null when the property has no active position at all. */
  productId: string | null;
  /** Null when nothing is on file. */
  dueDate: string | null;
  cycleId: string | null;
  bucket: DueBucket;
  /**
   * Open jobs that cover **this** service, newest first.
   *
   * A list rather than one, because "there are two open jobs on this" is the
   * truth and choosing one of them arbitrarily is not.
   */
  jobs: RelevantJob[];
};

export type DueWorkRange = { from: string; to: string };

export type DueWorkSummary = {
  /** Totals over everything that matches, not over the page being shown. */
  overdue: number;
  inRange: number;
  unknown: number;
  later: number;
  /** Rows matching the current filter, of which this page is a slice. */
  matching: number;
};

export type DueWorkPage = {
  rows: DueWorkRow[];
  summary: DueWorkSummary;
  /** Zero-based. */
  page: number;
  pageSize: number;
  totalPages: number;
};

export const DEFAULT_PAGE_SIZE = 50;
/** A guard against a hand-edited URL asking for the whole portfolio at once. */
export const MAX_PAGE_SIZE = 200;

/**
 * Where a due date sits, given the range the operator chose and today.
 *
 * `overdue` beats everything: a date that has gone by is overdue whether or not
 * it happens to fall inside the chosen window.
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
 * The default is today to sixty days ahead, and it is a starting view rather
 * than a policy: it is shown on the screen, it is editable, and nothing acts on
 * it. A malformed or inverted range falls back rather than returning nothing.
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

/**
 * Which job products count as covering which compliance service.
 *
 * Derived from the product registry rather than written out, so a new bundle is
 * covered by defining the product. A job covers a service when it **is** that
 * service, or when it is a bundle that contains it — which is what stops a
 * boiler-service job from standing in for an outstanding CP12.
 */
export function jobProductsCovering(cycleProductId: string): string[] {
  return Object.values(products)
    .filter((product) => {
      if (product.id === cycleProductId) return true;
      return (product.componentIds ?? []).includes(cycleProductId as ProductId);
    })
    .map((product) => product.id);
}

/** Every (service, job product) pair, for the SQL that matches them. */
function coveringPairs(): { cycleProductId: string; jobProductId: string }[] {
  const pairs: { cycleProductId: string; jobProductId: string }[] = [];
  for (const cycleProductId of Object.keys(products)) {
    for (const jobProductId of jobProductsCovering(cycleProductId)) {
      pairs.push({ cycleProductId, jobProductId });
    }
  }
  return pairs;
}

/**
 * Everything BSCJ tracks, filtered and counted by the database.
 *
 * Admin-only by construction: no organisation filter, and the page calling it
 * has already required an administrator.
 */
export async function listDueWork(input: {
  range: DueWorkRange;
  today: string;
  /** Whether rows due beyond the range are included. */
  includeLater?: boolean;
  page?: number;
  pageSize?: number;
}): Promise<DueWorkPage | null> {
  const db = getDb();
  if (!db) return null;

  const pageSize = Math.min(
    Math.max(1, Math.floor(input.pageSize ?? DEFAULT_PAGE_SIZE)),
    MAX_PAGE_SIZE,
  );
  const page = Math.max(0, Math.floor(input.page ?? 0));

  /*
    The active position, left-joined so a property with none still appears as
    its own row. **No job is joined here** — that is what multiplied the rows
    and inflated every count in the first version.
  */
  const activeCycle = and(
    eq(complianceCycles.propertyId, properties.id),
    eq(complianceCycles.status, "active"),
  );

  const due = complianceCycles.dueDate;

  /*
    Bucketing in SQL, so the limit applies to rows the operator asked for
    rather than to whatever happened to sort first. `overdue` and `unknown` are
    always included: a date that has gone by and a property with no date are
    both work, whatever window is being looked at.
  */
  const inRange = and(
    sql`${due} is not null`,
    sql`${due} >= ${input.today}`,
    sql`${due} >= ${input.range.from}`,
    sql`${due} <= ${input.range.to}`,
  );
  const overdue = and(sql`${due} is not null`, sql`${due} < ${input.today}`);
  const unknown = sql`${due} is null`;
  const later = and(
    sql`${due} is not null`,
    sql`${due} >= ${input.today}`,
    sql`${due} > ${input.range.to}`,
  );

  const visible = input.includeLater
    ? or(overdue, unknown, inRange, later)
    : or(overdue, unknown, inRange);

  const where = and(eq(properties.isActive, true), visible);

  try {
    /*
      The totals are their own query over the same FROM and the same
      conditions. Counting the page would have reported the page, which is the
      number an operator is least interested in.
    */
    const [counts] = await db
      .select({
        matching: sql<number>`count(*)::int`,
        overdue: sql<number>`count(*) filter (where ${overdue})::int`,
        inRange: sql<number>`count(*) filter (where ${inRange})::int`,
        unknown: sql<number>`count(*) filter (where ${unknown})::int`,
        later: sql<number>`count(*) filter (where ${later})::int`,
      })
      .from(properties)
      .leftJoin(complianceCycles, activeCycle)
      .where(and(eq(properties.isActive, true)));

    const [matching] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(properties)
      .leftJoin(complianceCycles, activeCycle)
      .where(where);

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
        productId: complianceCycles.productId,
        dueDate: complianceCycles.dueDate,
        cycleId: complianceCycles.id,
      })
      .from(properties)
      .innerJoin(customers, eq(customers.id, properties.customerId))
      .leftJoin(
        agentOrganisations,
        eq(agentOrganisations.id, properties.agentOrganisationId),
      )
      .leftJoin(complianceCycles, activeCycle)
      .where(where)
      /*
        Soonest first, with "we do not know" collecting at the end — and it can
        be reached now, because it is a page of a filtered set rather than the
        tail of an arbitrary five hundred. The property id is the tie-break, so
        paging is stable rather than dependent on the planner.
      */
      .orderBy(
        sql`${complianceCycles.dueDate} asc nulls last`,
        asc(properties.postcode),
        asc(properties.id),
        asc(complianceCycles.productId),
      )
      .limit(pageSize)
      .offset(page * pageSize);

    const jobsByProperty = await openJobsFor(
      db,
      rows.map((row) => row.propertyId),
    );

    const pairs = coveringPairs();

    const withJobs: DueWorkRow[] = rows.map((row) => {
      const onProperty = jobsByProperty.get(row.propertyId) ?? [];
      /*
        Only the jobs that cover **this** service. A property renewing a CP12
        and carrying an open boiler-service job has no CP12 work in hand, and
        saying otherwise is how a certificate lapses while a screen says it is
        being dealt with.
      */
      const covering = row.productId
        ? onProperty.filter((job) =>
            pairs.some(
              (pair) =>
                pair.cycleProductId === row.productId &&
                pair.jobProductId === job.productId,
            ),
          )
        : onProperty;

      return {
        ...row,
        key: `${row.propertyId}:${row.productId ?? "unknown"}`,
        bucket: bucketFor(row.dueDate, input.range, input.today),
        jobs: covering,
      };
    });

    const total = matching?.n ?? 0;

    return {
      rows: withJobs,
      summary: {
        overdue: counts?.overdue ?? 0,
        inRange: counts?.inRange ?? 0,
        unknown: counts?.unknown ?? 0,
        later: counts?.later ?? 0,
        matching: total,
      },
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  } catch {
    return null;
  }
}

/**
 * Open jobs for the properties on this page, gathered rather than joined.
 *
 * One query for the page, keyed by property. `notInArray` over the terminal
 * statuses rather than a list of open ones, so a status added later is treated
 * as open — the safe default for a check whose question is "is something
 * already happening here".
 */
async function openJobsFor(
  db: NonNullable<ReturnType<typeof getDb>>,
  propertyIds: string[],
): Promise<Map<string, RelevantJob[]>> {
  const byProperty = new Map<string, RelevantJob[]>();
  if (propertyIds.length === 0) return byProperty;

  const rows = await db
    .select({
      id: jobs.id,
      propertyId: jobs.propertyId,
      reference: jobs.reference,
      status: jobs.lifecycleStatus,
      productId: jobs.productId,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .where(
      and(
        inArray(jobs.propertyId, propertyIds),
        notInArray(jobs.lifecycleStatus, [...TERMINAL_STATUSES]),
      ),
    )
    .orderBy(asc(jobs.createdAt));

  for (const row of rows) {
    const list = byProperty.get(row.propertyId) ?? [];
    list.unshift({
      id: row.id,
      reference: row.reference,
      status: row.status as JobLifecycleStatus,
      productId: row.productId,
    });
    byProperty.set(row.propertyId, list);
  }

  return byProperty;
}
