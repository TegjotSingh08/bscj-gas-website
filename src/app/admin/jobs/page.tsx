import type { Metadata } from "next";
import Link from "next/link";

import { requireAdmin } from "@/lib/auth/session";
import { listJobs, listEngineers, type JobListRow } from "@/lib/jobs/queries";
import { productFor } from "@/lib/booking/products";
import { bookingConfig } from "@/lib/booking/config";
import { JOB_LIFECYCLE_STATUSES } from "@/lib/jobs/lifecycle";
import {
  ENGINEER_ANY,
  ENGINEER_NONE,
  isFiltered,
  jobListHref,
  JOB_VIEWS,
  pageCount,
  pageRange,
  parseJobFilters,
  type JobFilters,
  type JobView,
} from "@/lib/jobs/filters";
import {
  AttentionChips,
  ClientPill,
  DeadlineNote,
  StatusPill,
  STATUS_LABELS,
} from "@/components/jobs/JobLabels";
import { AdminNav } from "../AdminNav";

export const metadata: Metadata = {
  title: "Jobs",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * Every job, findable.
 *
 * The list used to be "the fifty most recent, in the order they arrived",
 * which was right while the question was "did the booking I just took get
 * recorded" and stops being right the moment there are more jobs than fit on
 * a screen. Somebody on the phone has a reference, a surname or a postcode
 * and needs the job now.
 *
 * Three controls, and they are deliberately different kinds of thing:
 *
 * - **The views** are the questions somebody opens this page with — today,
 *   unassigned, needs attention. They are not statuses; "today" is true of
 *   jobs in four different statuses at once.
 * - **The filters** narrow by a fact about the row: who it is for, where it
 *   has got to, whose it is.
 * - **The search** is free text over the four things a person actually has:
 *   a reference, a name, a postcode, a street.
 *
 * It is a plain `GET` form. No JavaScript is needed to search, filter or
 * page, every state of this screen is a URL somebody can send to somebody
 * else, and the back button does what a back button should.
 *
 * **Nothing here decides what may be seen.** The scope comes from the
 * verified session; the query string can only ever narrow it further.
 */
export default async function AdminJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The scope comes from the verified session, not from the request.
  const { user, scope } = await requireAdmin();
  const filters = parseJobFilters(await searchParams);

  const [page, engineers] = await Promise.all([
    listJobs(scope, filters),
    listEngineers(scope),
  ]);

  return (
    <>
      <AdminNav userName={user.name} current="jobs" />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-extrabold text-navy-900">Jobs</h1>

        {page === null ? (
          <p className="mt-6 rounded-xl bg-white px-4 py-3 text-sm text-navy-700">
            The database is not configured, so no jobs can be listed. The
            public booking flow is unaffected.
          </p>
        ) : (
          <>
            <Views filters={filters} />
            <Controls filters={filters} engineers={engineers} />

            <p className="mt-4 text-sm text-navy-700" role="status">
              {page.total === 0 ? (
                <>Nothing matches.</>
              ) : (
                <>
                  <strong className="font-extrabold text-navy-900">
                    {page.total}
                  </strong>{" "}
                  {page.total === 1 ? "job" : "jobs"}
                  {isFiltered(filters) && " matching"}
                </>
              )}
              {isFiltered(filters) && (
                <>
                  {" · "}
                  <Link href="/admin/jobs" className="font-bold text-flame-600 underline">
                    clear
                  </Link>
                </>
              )}
            </p>

            {page.total === 0 ? (
              <p className="mt-4 rounded-2xl border-2 border-navy-200 bg-white px-5 py-4 text-sm text-navy-700">
                {isFiltered(filters)
                  ? "No job matches those filters. Try clearing them."
                  : "No jobs recorded yet. A booking taken on the website appears here once its calendar event has been written."}
              </p>
            ) : (
              <>
                <JobTable rows={page.rows} />
                <Pager filters={filters} page={page.page} total={page.total} />
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------

const VIEW_LABELS: Readonly<Record<JobView, string>> = {
  all: "All",
  open: "Open",
  today: "Today",
  upcoming: "Upcoming",
  unassigned: "Nobody allocated",
  attention: "Needs attention",
  closed: "Closed",
};

/** The questions somebody opens this page with. Links, so each is a URL. */
function Views({ filters }: { filters: JobFilters }) {
  return (
    <nav className="mt-4 -mx-4 overflow-x-auto px-4" aria-label="Views">
      <ul className="flex gap-2">
        {JOB_VIEWS.map((view) => (
          <li key={view}>
            <Link
              href={jobListHref(filters, { view })}
              aria-current={filters.view === view ? "page" : undefined}
              className={
                filters.view === view
                  ? "inline-block whitespace-nowrap rounded-full bg-navy-900 px-4 py-2 text-sm font-bold text-white"
                  : "inline-block whitespace-nowrap rounded-full border-2 border-navy-200 bg-white px-4 py-2 text-sm font-bold text-navy-700 hover:border-flame-500"
              }
            >
              {VIEW_LABELS[view]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Search and the narrowing filters.
 *
 * A `GET` form, so submitting it produces a URL. The current view is carried
 * in a hidden field rather than re-selected, because it is a different kind
 * of control and losing it on every search would be maddening.
 */
function Controls({
  filters,
  engineers,
}: {
  filters: JobFilters;
  engineers: { id: string; name: string }[];
}) {
  const field =
    "w-full rounded-xl border-2 border-navy-200 bg-white px-3 py-2 text-sm font-semibold text-navy-900 focus:border-flame-500";

  return (
    <form
      method="get"
      action="/admin/jobs"
      className="mt-4 grid gap-3 rounded-2xl border-2 border-navy-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-5"
    >
      {filters.view !== "all" && (
        <input type="hidden" name="view" value={filters.view} />
      )}

      <div className="sm:col-span-2">
        <label
          htmlFor="q"
          className="block text-xs font-bold uppercase tracking-wide text-navy-600"
        >
          Search
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={filters.query}
          placeholder="Reference, name, postcode or street"
          className={`mt-1 ${field}`}
        />
      </div>

      <div>
        <label
          htmlFor="client"
          className="block text-xs font-bold uppercase tracking-wide text-navy-600"
        >
          Who it is for
        </label>
        <select
          id="client"
          name="client"
          defaultValue={filters.client}
          className={`mt-1 ${field}`}
        >
          <option value="all">Everyone</option>
          <option value="private">Private only</option>
          <option value="agency">Agency only</option>
        </select>
      </div>

      <div>
        <label
          htmlFor="status"
          className="block text-xs font-bold uppercase tracking-wide text-navy-600"
        >
          Stage
        </label>
        <select
          id="status"
          name="status"
          defaultValue={filters.status ?? ""}
          className={`mt-1 ${field}`}
        >
          <option value="">Any stage</option>
          {JOB_LIFECYCLE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label
          htmlFor="engineer"
          className="block text-xs font-bold uppercase tracking-wide text-navy-600"
        >
          Engineer
        </label>
        <select
          id="engineer"
          name="engineer"
          defaultValue={filters.engineer}
          className={`mt-1 ${field}`}
        >
          <option value={ENGINEER_ANY}>Anybody</option>
          <option value={ENGINEER_NONE}>Nobody yet</option>
          {engineers.map((engineer) => (
            <option key={engineer.id} value={engineer.id}>
              {engineer.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-5">
        <button
          type="submit"
          className="rounded-xl bg-flame-500 px-5 py-2.5 text-sm font-extrabold text-navy-900 hover:bg-flame-400"
        >
          Apply
        </button>
        <Link
          href={jobListHref(filters, {
            query: "",
            client: "all",
            status: null,
            engineer: ENGINEER_ANY,
          })}
          className="rounded-xl border-2 border-navy-200 px-5 py-2.5 text-sm font-bold text-navy-700 hover:border-flame-500"
        >
          Reset filters
        </Link>
      </div>
    </form>
  );
}

function JobTable({ rows }: { rows: JobListRow[] }) {
  const when = (value: Date | null) =>
    value
      ? value.toLocaleString("en-GB", {
          timeZone: bookingConfig.timeZone,
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "—";

  return (
    <div className="mt-4 overflow-x-auto rounded-2xl border-2 border-navy-200 bg-white">
      <table className="w-full min-w-[56rem] text-left text-sm">
        <thead className="bg-navy-50 text-xs uppercase tracking-wide text-navy-600">
          <tr>
            <th className="px-4 py-3 font-bold">Reference</th>
            <th className="px-4 py-3 font-bold">Customer</th>
            <th className="px-4 py-3 font-bold">For</th>
            <th className="px-4 py-3 font-bold">Service</th>
            <th className="px-4 py-3 font-bold">Appointment</th>
            <th className="px-4 py-3 font-bold">Where</th>
            <th className="px-4 py-3 font-bold">Engineer</th>
            <th className="px-4 py-3 font-bold">Stage</th>
            <th className="px-4 py-3 text-right font-bold">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-navy-100">
          {rows.map((job) => (
            <tr key={job.id} className="align-top hover:bg-navy-50">
              <td className="px-4 py-3">
                <Link
                  href={`/admin/jobs/${job.id}`}
                  className="font-bold text-flame-600 underline"
                >
                  {job.reference}
                </Link>
                <AttentionChips reasons={job.attention} />
              </td>
              <td className="px-4 py-3 text-navy-900">
                {job.customerName ?? "—"}
              </td>
              <td className="px-4 py-3">
                <ClientPill organisationName={job.organisationName} />
              </td>
              <td className="px-4 py-3 text-navy-700">
                {productFor(job.productId).subjectName}
              </td>
              <td className="px-4 py-3 text-navy-700">
                <span className="whitespace-nowrap">
                  {when(job.appointmentStart)}
                </span>
                <span className="block">
                  <DeadlineNote
                    risk={job.risk}
                    completeByDate={job.completeByDate}
                  />
                </span>
              </td>
              <td className="px-4 py-3 text-navy-700">
                <span className="font-semibold">{job.postcode ?? "—"}</span>
                {job.town && (
                  <span className="block text-xs text-navy-600">{job.town}</span>
                )}
              </td>
              <td className="px-4 py-3 text-navy-700">
                {job.engineerName ?? (
                  <span className="text-navy-600">Nobody yet</span>
                )}
              </td>
              <td className="px-4 py-3">
                <StatusPill status={job.lifecycleStatus} />
              </td>
              <td className="px-4 py-3 text-right font-bold text-navy-900">
                £{(job.priceTotalPence / 100).toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Paging.
 *
 * Previous and next only, plus where you are. A numbered pager over an
 * unbounded list is a row of buttons nobody presses; "showing 26–50 of 214"
 * is the part people actually read.
 */
function Pager({
  filters,
  page,
  total,
}: {
  filters: JobFilters;
  page: number;
  total: number;
}) {
  const pages = pageCount(total, filters.pageSize);
  const { from, to } = pageRange(page, filters.pageSize, total);

  return (
    <nav
      className="mt-4 flex flex-wrap items-center justify-between gap-3"
      aria-label="Pagination"
    >
      <p className="text-sm text-navy-700">
        Showing {from}–{to} of {total}
        {pages > 1 && ` · page ${page} of ${pages}`}
      </p>
      {pages > 1 && (
        <div className="flex gap-2">
          {page > 1 ? (
            <Link
              href={jobListHref(filters, { page: page - 1 })}
              rel="prev"
              className="rounded-xl border-2 border-navy-200 bg-white px-4 py-2 text-sm font-bold text-navy-900 hover:border-flame-500"
            >
              ← Previous
            </Link>
          ) : (
            <span className="rounded-xl border-2 border-navy-100 px-4 py-2 text-sm font-bold text-navy-600">
              ← Previous
            </span>
          )}
          {page < pages ? (
            <Link
              href={jobListHref(filters, { page: page + 1 })}
              rel="next"
              className="rounded-xl border-2 border-navy-200 bg-white px-4 py-2 text-sm font-bold text-navy-900 hover:border-flame-500"
            >
              Next →
            </Link>
          ) : (
            <span className="rounded-xl border-2 border-navy-100 px-4 py-2 text-sm font-bold text-navy-600">
              Next →
            </span>
          )}
        </div>
      )}
    </nav>
  );
}
