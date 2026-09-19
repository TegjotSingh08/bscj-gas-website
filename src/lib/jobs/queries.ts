import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  activities,
  appUsers,
  customers,
  jobs,
  properties,
  tenancies,
} from "@/lib/db/schema";
import { organisationCondition, type AccessScope } from "@/lib/auth/scope";
import { parsePriceSnapshot } from "@/lib/pricing/snapshot";
import { bookingConfig } from "@/lib/booking/config";
import { dayBoundsInZone, isoDateInZone } from "@/lib/booking/time";
import {
  DEFAULT_DEADLINE_WINDOWS,
  type DeadlineRisk,
} from "@/lib/compliance/renewal";
import {
  attentionReasons,
  type AttentionInput,
  type AttentionReason,
} from "./attention";
import {
  clampPage,
  ENGINEER_ANY,
  ENGINEER_NONE,
  likePattern,
  type JobFilters,
} from "./filters";
import { jobDeadlineRisk } from "./derived";
import { TERMINAL_STATUSES, type JobLifecycleStatus } from "./lifecycle";

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
 *
 * The filters and the search below narrow *within* that scope and can never
 * widen it. The scope condition is the first term of every `WHERE`, and the
 * user's filters are additional `AND`s on top of it — so the worst a
 * hand-edited query string can do is show its author fewer of their own rows.
 */

export type JobListRow = {
  id: string;
  reference: string;
  productId: string;
  lifecycleStatus: JobLifecycleStatus;
  appointmentStart: Date | null;
  priceTotalPence: number;
  source: string;
  customerName: string | null;
  postcode: string | null;
  town: string | null;
  createdAt: Date;
  /** Null for consumer work. The private/agency distinction, on every row. */
  organisationName: string | null;
  engineerName: string | null;
  assignedEngineerId: string | null;
  completeByDate: string | null;
  requestedAsap: boolean;
  /** Computed from `completeByDate`, never stored. */
  risk: DeadlineRisk | null;
  attention: readonly AttentionReason[];
};

export type JobListPage = {
  rows: JobListRow[];
  /** Matching the filters, across every page. */
  total: number;
  /** After clamping — an out-of-range request lands on the last page. */
  page: number;
  pageSize: number;
};

// ---------------------------------------------------------------------------
// The conditions the filters turn into
// ---------------------------------------------------------------------------

/**
 * A job nobody has finished with.
 *
 * Used by the "open" view and by the totals. Terminal statuses are named from
 * `lifecycle.ts` rather than listed again, so adding one cannot leave this
 * quietly counting it as live work.
 */
function openCondition(): SQL {
  return notInArray(jobs.lifecycleStatus, [...TERMINAL_STATUSES]);
}

/**
 * Something is wrong or waiting on a person.
 *
 * The same signals `attention.ts` names, expressed once as SQL so the queue,
 * the filter and the dashboard count cannot disagree about what is on the
 * list. A deadline that has merely gone urgent is included here; the
 * per-row reasons then say which of these actually applied.
 */
function attentionCondition(today: string): SQL {
  const urgentBy = addDays(today, DEFAULT_DEADLINE_WINDOWS.urgentDays);

  return and(
    openCondition(),
    or(
      inArray(jobs.calendarSyncState, ["pending", "failed"]),
      isNotNull(jobs.calendarPreviousEventId),
      isNotNull(jobs.deadlineExceptionAt),
      and(isNotNull(jobs.completeByDate), lte(jobs.completeByDate, urgentBy)),
      sql`EXISTS (
        SELECT 1 FROM "outbound_email"
        WHERE "outbound_email"."job_id" = ${jobs.id}
          AND "outbound_email"."state" = 'failed'
      )`,
      sql`EXISTS (
        SELECT 1 FROM "remedial"
        WHERE "remedial"."job_id" = ${jobs.id}
          AND "remedial"."status" = 'awaiting_approval'
      )`,
    )!,
  )!;
}

/** Plain date arithmetic on `YYYY-MM-DD`, for a bound in a `WHERE`. */
function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** Everything the filters add on top of the scope. */
function filterConditions(
  filters: JobFilters,
  now: Date,
): (SQL | undefined)[] {
  const conditions: (SQL | undefined)[] = [];
  const timeZone = bookingConfig.timeZone;
  const today = isoDateInZone(now, timeZone);

  if (filters.query) {
    const pattern = likePattern(filters.query);
    /*
      Four columns, because those are the four things somebody actually has
      in front of them: a reference from an email, a name from a phone call,
      a postcode from a diary, a street from a conversation.

      `ilike` with a leading wildcard cannot use an index. That is a
      deliberate trade at this size — the alternative is full-text search
      infrastructure for a business with hundreds of jobs — and it is bounded
      by the same pagination as everything else.
    */
    conditions.push(
      or(
        ilike(jobs.reference, pattern),
        ilike(customers.name, pattern),
        ilike(properties.postcode, pattern),
        ilike(properties.street, pattern),
        ilike(properties.houseOrName, pattern),
      ),
    );
  }

  if (filters.client === "private") conditions.push(isNull(jobs.agentOrganisationId));
  if (filters.client === "agency") conditions.push(isNotNull(jobs.agentOrganisationId));

  if (filters.status) conditions.push(eq(jobs.lifecycleStatus, filters.status));

  if (filters.engineer === ENGINEER_NONE) {
    conditions.push(isNull(jobs.assignedEngineerId));
  } else if (filters.engineer !== ENGINEER_ANY) {
    conditions.push(eq(jobs.assignedEngineerId, filters.engineer));
  }

  switch (filters.view) {
    case "open":
      conditions.push(openCondition());
      break;
    case "today": {
      const bounds = dayBoundsInZone(today, timeZone);
      if (bounds) {
        conditions.push(
          and(
            gte(jobs.appointmentStart, bounds.start),
            lt(jobs.appointmentStart, bounds.end),
          ),
        );
      }
      break;
    }
    case "upcoming":
      conditions.push(
        and(gte(jobs.appointmentStart, now), openCondition()),
      );
      break;
    case "unassigned":
      conditions.push(
        and(
          isNull(jobs.assignedEngineerId),
          isNotNull(jobs.appointmentStart),
          openCondition(),
        ),
      );
      break;
    case "attention":
      conditions.push(attentionCondition(today));
      break;
    case "closed":
      conditions.push(inArray(jobs.lifecycleStatus, [...TERMINAL_STATUSES]));
      break;
    case "all":
      break;
  }

  return conditions.filter(Boolean);
}

/**
 * How the list is ordered, per view.
 *
 * A diary reads forwards and a backlog reads backwards, and using one order
 * for both is how "today" opens on last March. Not configurable from the
 * URL: an order the caller can choose is one more thing to validate for no
 * operational gain.
 */
function orderFor(view: JobFilters["view"]) {
  if (view === "today" || view === "upcoming" || view === "unassigned") {
    return [asc(jobs.appointmentStart), asc(jobs.reference)];
  }
  return [desc(jobs.createdAt), desc(jobs.reference)];
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * One page of jobs, and how many there are in total.
 *
 * The count is a second query rather than a window function, deliberately:
 * a window count over a filtered join is the kind of query that is fine at
 * this size and quietly terrible later, and two plain statements are easier
 * to read and to explain than one clever one.
 *
 * `now` is a parameter so "today" is testable without waiting for tomorrow.
 */
export async function listJobs(
  scope: AccessScope,
  filters: JobFilters,
  now: Date = new Date(),
): Promise<JobListPage | null> {
  const db = getDb();
  if (!db) return null;

  const conditions = filterConditions(filters, now);
  const where = organisationCondition(
    jobs.agentOrganisationId,
    scope,
    conditions.length ? and(...conditions) : undefined,
  );

  const [{ total }] = await db
    .select({ total: count() })
    .from(jobs)
    .leftJoin(customers, eq(customers.id, jobs.customerId))
    .leftJoin(properties, eq(properties.id, jobs.propertyId))
    .where(where);

  const page = clampPage(filters.page, total, filters.pageSize);

  const rows = await db
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
      town: properties.town,
      createdAt: jobs.createdAt,
      organisationName: sql<string | null>`(
        SELECT "name" FROM "agent_organisation"
        WHERE "agent_organisation"."id" = ${jobs.agentOrganisationId}
      )`,
      engineerName: sql<string | null>`(
        SELECT "name" FROM "app_user"
        WHERE "app_user"."id" = ${jobs.assignedEngineerId}
      )`,
      assignedEngineerId: jobs.assignedEngineerId,
      completeByDate: jobs.completeByDate,
      requestedAsap: jobs.requestedAsap,
      calendarSyncState: jobs.calendarSyncState,
      calendarPreviousEventId: jobs.calendarPreviousEventId,
      deadlineExceptionAt: jobs.deadlineExceptionAt,
      messageFailed: sql<boolean>`EXISTS (
        SELECT 1 FROM "outbound_email"
        WHERE "outbound_email"."job_id" = ${jobs.id}
          AND "outbound_email"."state" = 'failed'
      )`,
      remedialAwaitingApproval: sql<boolean>`EXISTS (
        SELECT 1 FROM "remedial"
        WHERE "remedial"."job_id" = ${jobs.id}
          AND "remedial"."status" = 'awaiting_approval'
      )`,
    })
    .from(jobs)
    .leftJoin(customers, eq(customers.id, jobs.customerId))
    .leftJoin(properties, eq(properties.id, jobs.propertyId))
    .where(where)
    .orderBy(...orderFor(filters.view))
    .limit(filters.pageSize)
    .offset((page - 1) * filters.pageSize);

  const today = isoDateInZone(now, bookingConfig.timeZone);

  return {
    total,
    page,
    pageSize: filters.pageSize,
    rows: rows.map((row) => {
      const lifecycleStatus = row.lifecycleStatus as JobLifecycleStatus;
      const risk = jobDeadlineRisk(
        { completeByDate: row.completeByDate, lifecycleStatus },
        today,
      );
      const input: AttentionInput = {
        lifecycleStatus,
        calendarSyncPending:
          row.calendarSyncState === "pending" || row.calendarSyncState === "failed",
        calendarCleanupOutstanding: row.calendarPreviousEventId !== null,
        messageFailed: Boolean(row.messageFailed),
        hasDeadlineException: row.deadlineExceptionAt !== null,
        risk,
        hasRemedialAwaitingApproval: Boolean(row.remedialAwaitingApproval),
      };

      return {
        id: row.id,
        reference: row.reference,
        productId: row.productId,
        lifecycleStatus,
        appointmentStart: row.appointmentStart,
        priceTotalPence: row.priceTotalPence,
        source: row.source,
        customerName: row.customerName,
        postcode: row.postcode,
        town: row.town,
        createdAt: row.createdAt,
        organisationName: row.organisationName,
        engineerName: row.engineerName,
        assignedEngineerId: row.assignedEngineerId,
        completeByDate: row.completeByDate,
        requestedAsap: row.requestedAsap,
        risk,
        attention: attentionReasons(input),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// The totals
// ---------------------------------------------------------------------------

/**
 * What the dashboard says.
 *
 * Every figure is a count of rows the caller can already see, and each one
 * corresponds to a link into the list that shows exactly those rows — a
 * number nobody can click through to is a number nobody can check.
 *
 * The private/agency split is first because it is the distinction BSCJ runs
 * on: a homeowner who booked a £45 CP12 and an agency's twelfth property this
 * month need different things from the same screen.
 */
export type JobTotals = {
  all: number;
  open: number;
  /** Consumer work: no organisation. */
  private: number;
  privateOpen: number;
  /** Commissioned by a letting agency. */
  agency: number;
  agencyOpen: number;
  today: number;
  unassigned: number;
  attention: number;
  completed: number;
  cancelled: number;
  /** Open jobs by lifecycle status, for the breakdown. */
  byStatus: Partial<Record<JobLifecycleStatus, number>>;
};

export async function jobTotals(
  scope: AccessScope,
  now: Date = new Date(),
): Promise<JobTotals | null> {
  const db = getDb();
  if (!db) return null;

  const timeZone = bookingConfig.timeZone;
  const today = isoDateInZone(now, timeZone);
  const bounds = dayBoundsInZone(today, timeZone);

  /*
    One pass over the caller's rows, with the buckets as conditional sums.
    Nine separate counts would be nine table scans for a page that is opened
    on every visit, and they could disagree with each other if a job moved
    between them.
  */
  const scopeOnly = organisationCondition(jobs.agentOrganisationId, scope);
  const open = openCondition();
  const isPrivate = isNull(jobs.agentOrganisationId);

  const [totals] = await db
    .select({
      all: count(),
      open: sum(open),
      private: sum(isPrivate),
      privateOpen: sum(and(isPrivate, open)!),
      agency: sum(isNotNull(jobs.agentOrganisationId)),
      agencyOpen: sum(and(isNotNull(jobs.agentOrganisationId), open)!),
      today: bounds
        ? sum(
            and(
              gte(jobs.appointmentStart, bounds.start),
              lt(jobs.appointmentStart, bounds.end),
            )!,
          )
        : sql<number>`0`,
      unassigned: sum(
        and(isNull(jobs.assignedEngineerId), isNotNull(jobs.appointmentStart), open)!,
      ),
      attention: sum(attentionCondition(today)),
      completed: sum(eq(jobs.lifecycleStatus, "completed")),
      cancelled: sum(eq(jobs.lifecycleStatus, "cancelled")),
    })
    .from(jobs)
    .where(scopeOnly);

  const statusRows = await db
    .select({ status: jobs.lifecycleStatus, n: count() })
    .from(jobs)
    .where(organisationCondition(jobs.agentOrganisationId, scope, open))
    .groupBy(jobs.lifecycleStatus);

  const byStatus: Partial<Record<JobLifecycleStatus, number>> = {};
  for (const row of statusRows) {
    byStatus[row.status as JobLifecycleStatus] = Number(row.n);
  }

  return {
    all: Number(totals.all),
    open: Number(totals.open),
    private: Number(totals.private),
    privateOpen: Number(totals.privateOpen),
    agency: Number(totals.agency),
    agencyOpen: Number(totals.agencyOpen),
    today: Number(totals.today),
    unassigned: Number(totals.unassigned),
    attention: Number(totals.attention),
    completed: Number(totals.completed),
    cancelled: Number(totals.cancelled),
    byStatus,
  };
}

/** Counts rows matching a condition, in the same pass as the total. */
function sum(condition: SQL) {
  return sql<number>`COUNT(*) FILTER (WHERE ${condition})`;
}

// ---------------------------------------------------------------------------
// One job
// ---------------------------------------------------------------------------

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
      engineerName: sql<string | null>`(
        SELECT "name" FROM "app_user"
        WHERE "app_user"."id" = ${jobs.assignedEngineerId}
      )`,
      organisationName: sql<string | null>`(
        SELECT "name" FROM "agent_organisation"
        WHERE "agent_organisation"."id" = ${jobs.agentOrganisationId}
      )`,
      messageFailed: sql<boolean>`EXISTS (
        SELECT 1 FROM "outbound_email"
        WHERE "outbound_email"."job_id" = ${jobs.id}
          AND "outbound_email"."state" = 'failed'
      )`,
      remedialAwaitingApproval: sql<boolean>`EXISTS (
        SELECT 1 FROM "remedial"
        WHERE "remedial"."job_id" = ${jobs.id}
          AND "remedial"."status" = 'awaiting_approval'
      )`,
    })
    .from(jobs)
    .leftJoin(customers, eq(customers.id, jobs.customerId))
    .leftJoin(properties, eq(properties.id, jobs.propertyId))
    .leftJoin(tenancies, eq(tenancies.id, jobs.tenancyId))
    .where(scopeFilter ? and(eq(jobs.id, id), scopeFilter) : eq(jobs.id, id))
    .limit(1);

  if (!row) return null;

  const lifecycleStatus = row.job.lifecycleStatus as JobLifecycleStatus;
  const risk = jobDeadlineRisk(
    { completeByDate: row.job.completeByDate, lifecycleStatus },
    isoDateInZone(new Date(), bookingConfig.timeZone),
  );

  return {
    ...row,
    priceSnapshot: parsePriceSnapshot(row.job.priceSnapshot),
    risk,
    attention: attentionReasons({
      lifecycleStatus,
      calendarSyncPending:
        row.job.calendarSyncState === "pending" ||
        row.job.calendarSyncState === "failed",
      calendarCleanupOutstanding: row.job.calendarPreviousEventId !== null,
      messageFailed: Boolean(row.messageFailed),
      hasDeadlineException: row.job.deadlineExceptionAt !== null,
      risk,
      hasRemedialAwaitingApproval: Boolean(row.remedialAwaitingApproval),
    }),
  };
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

export type TimelineEntry = {
  id: string;
  kind: string;
  actor: string;
  actorName: string | null;
  detail: unknown;
  createdAt: Date;
};

/**
 * What has happened to a job, newest first.
 *
 * Read through the job rather than straight off `activity`, so the caller's
 * scope decides here exactly as it does everywhere else — a timeline is a
 * record of somebody's property and tenant, and reaching it by job id must
 * not be easier than reaching the job.
 *
 * Actors are stored as `"user:<uuid>"`, `"tenant"` or `"system"`. The user's
 * name is resolved for display; nothing else about them is loaded.
 */
export async function jobTimeline(
  scope: AccessScope,
  jobId: string,
  limit = 50,
): Promise<TimelineEntry[]> {
  const db = getDb();
  if (!db || !UUID.test(jobId)) return [];

  const scopeFilter = organisationCondition(jobs.agentOrganisationId, scope);

  const rows = await db
    .select({
      id: activities.id,
      kind: activities.kind,
      actor: activities.actor,
      detail: activities.detail,
      createdAt: activities.createdAt,
      actorName: appUsers.name,
    })
    .from(activities)
    // The scope check. An activity row is only reachable through a job the
    // caller can already see.
    .innerJoin(
      jobs,
      scopeFilter
        ? and(eq(jobs.id, activities.jobId), scopeFilter)
        : eq(jobs.id, activities.jobId),
    )
    .leftJoin(
      appUsers,
      sql`${appUsers.id}::text = substring(${activities.actor} from 6)
          AND ${activities.actor} LIKE 'user:%'`,
    )
    .where(eq(activities.jobId, jobId))
    .orderBy(desc(activities.createdAt))
    .limit(limit);

  return rows;
}

// ---------------------------------------------------------------------------
// Engineers
// ---------------------------------------------------------------------------

export type EngineerOption = { id: string; name: string; email: string };

/**
 * Who work can be allocated to.
 *
 * Scoped like everything else here, and for a reason that is not obvious:
 * the list of BSCJ's engineers is staff data, and an agency user asking for
 * it must get nothing rather than a staff directory. Only an unfiltered
 * scope — an administrator — is answered.
 */
export async function listEngineers(
  scope: AccessScope,
): Promise<EngineerOption[]> {
  const db = getDb();
  if (!db) return [];

  // `organisationCondition` answers `undefined` only for an administrator.
  // Anyone else gets a filter, and a filter on a staff list means nothing.
  if (organisationCondition(jobs.agentOrganisationId, scope) !== undefined) {
    return [];
  }

  return db
    .select({ id: appUsers.id, name: appUsers.name, email: appUsers.email })
    .from(appUsers)
    .where(and(eq(appUsers.role, "engineer"), eq(appUsers.isActive, true)))
    .orderBy(asc(appUsers.name));
}
