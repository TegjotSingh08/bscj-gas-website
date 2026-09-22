import type { Metadata } from "next";
import Link from "next/link";

import { requireAdmin } from "@/lib/auth/session";
import { isDatabaseConfigured } from "@/lib/db/client";
import { jobTotals, type JobTotals } from "@/lib/jobs/queries";
import { readOutboxSummary } from "@/lib/notifications/outbox";
import { countPendingReview } from "@/lib/documents/certificates";
import { STATUS_LABELS } from "@/components/jobs/JobLabels";
import { JOB_LIFECYCLE_STATUSES } from "@/lib/jobs/lifecycle";
import { AdminNav } from "./AdminNav";

export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * What is on, and what needs somebody.
 *
 * Two rules shape this page.
 *
 * **Every number is clickable.** A figure nobody can open is a figure nobody
 * can check, and a dashboard that cannot be checked gets distrusted at the
 * first surprise. Each tile links to the job list filtered to exactly the
 * rows it counted, so "7 need attention" and the seven jobs are the same
 * query rather than two that might disagree.
 *
 * **Private and agency work are shown apart.** It is the distinction BSCJ
 * actually runs on: a homeowner who booked a £45 CP12 off the website and an
 * agency's twelfth property this month are different work, with different
 * people to chase, and one combined figure hides which kind is growing.
 */
export default async function AdminDashboardPage() {
  const { user, scope } = await requireAdmin();

  const [totals, outbox, pendingCertificates] = await Promise.all([
    jobTotals(scope),
    readOutboxSummary(),
    countPendingReview(),
  ]);

  return (
    <>
      <AdminNav userName={user.name} current="dashboard" />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-extrabold text-navy-900 sm:text-3xl">
          Dashboard
        </h1>

        {totals === null ? (
          <p className="mt-6 rounded-2xl border-2 border-navy-200 bg-white px-5 py-4 text-sm text-navy-700">
            The database is{" "}
            {isDatabaseConfigured() ? "unavailable" : "not configured"}, so
            nothing can be counted. The public booking flow is unaffected: it
            writes to Google Calendar first and a database failure cannot fail
            a booking.
          </p>
        ) : (
          <>
            <Today totals={totals} />
            <Attention
              totals={totals}
              outbox={outbox}
              pendingCertificates={pendingCertificates}
            />
            <Split totals={totals} />
            <Pipeline totals={totals} />
          </>
        )}
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------

/** A number, what it counts, and the list that shows it. */
function Tile({
  label,
  value,
  href,
  note,
  emphasis,
}: {
  label: string;
  value: number;
  href: string;
  note?: string;
  emphasis?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`block rounded-2xl border-2 bg-white px-4 py-4 transition-colors hover:border-flame-500 ${
        emphasis && value > 0 ? "border-flame-500" : "border-navy-200"
      }`}
    >
      <p className="text-xs font-bold uppercase tracking-wide text-navy-600">
        {label}
      </p>
      <p className="mt-1 text-3xl font-extrabold text-navy-900">{value}</p>
      {note && <p className="mt-1 text-xs text-navy-600">{note}</p>}
    </Link>
  );
}

function Today({ totals }: { totals: JobTotals }) {
  return (
    <section className="mt-6">
      <h2 className="sr-only">Today</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Today"
          value={totals.today}
          href="/admin/jobs?view=today"
          note="Appointments on today’s date"
        />
        <Tile
          label="Open"
          value={totals.open}
          href="/admin/jobs?view=open"
          note="Neither done nor cancelled"
        />
        <Tile
          label="Nobody allocated"
          value={totals.unassigned}
          href="/admin/jobs?view=unassigned"
          note="Has a time, has no engineer"
          emphasis
        />
        <Tile
          label="Needs attention"
          value={totals.attention}
          href="/admin/jobs?view=attention"
          note="Something is waiting on a person"
          emphasis
        />
      </div>
    </section>
  );
}

/**
 * The queue, and the one thing this page deliberately cannot count.
 *
 * Bookings that exist in the calendar but were never recorded here live in
 * the reservation store, not in Postgres, and reading it can fail. The
 * reconciliation page already reports that honestly — "unknown rather than
 * absent" — so this links there instead of quietly showing a zero that might
 * be a read failure.
 */
function Attention({
  totals,
  outbox,
  pendingCertificates,
}: {
  totals: JobTotals;
  outbox: { pending: number; failed: number; missingRecipient: number };
  /** Certificates submitted or uploaded and not yet reviewed, across every job. */
  pendingCertificates: number;
}) {
  const quiet =
    totals.attention === 0 && outbox.failed === 0 && pendingCertificates === 0;

  return (
    <section className="mt-8 rounded-2xl border-2 border-navy-200 bg-white p-5">
      <h2 className="text-lg font-extrabold text-navy-900">Needs attention</h2>
      {quiet ? (
        <p className="mt-2 text-sm text-navy-700">
          Nothing is waiting on a person that this page can see.
        </p>
      ) : (
        <ul className="mt-3 grid gap-2 text-sm text-navy-800">
          {totals.attention > 0 && (
            <li>
              <Link
                href="/admin/jobs?view=attention"
                className="font-bold text-flame-600 underline"
              >
                {totals.attention}{" "}
                {totals.attention === 1 ? "job needs" : "jobs need"} somebody
              </Link>{" "}
              — a calendar entry not written, a message given up on, a deadline
              at risk, or a remedial awaiting approval.
            </li>
          )}
          {pendingCertificates > 0 && (
            <li>
              <Link
                href="/admin/jobs?view=certificate_review"
                className="font-bold text-flame-600 underline"
              >
                {pendingCertificates}{" "}
                {pendingCertificates === 1 ? "certificate" : "certificates"} to
                review
              </Link>{" "}
              — uploaded or submitted by an engineer, not yet opened.
            </li>
          )}
          {outbox.failed > 0 && (
            <li>
              {outbox.failed} {outbox.failed === 1 ? "message" : "messages"}{" "}
              given up on after every retry.
            </li>
          )}
          {outbox.missingRecipient > 0 && (
            <li className="font-bold text-flame-600">
              {outbox.missingRecipient} cannot be sent at all: no address is
              configured for that recipient.
            </li>
          )}
        </ul>
      )}
      <p className="mt-4 text-xs text-navy-600">
        Bookings that exist in the calendar but were never recorded here are
        not counted on this page — they live in the reservation store, and a
        failed read there must not show as a zero.{" "}
        <Link href="/admin/reconcile" className="font-bold text-flame-600 underline">
          Reconciliation
        </Link>{" "}
        reports them, and says so when it cannot.
      </p>
    </section>
  );
}

/**
 * The whole book of work, and the two kinds it is made of.
 *
 * The total is shown **with** the split rather than somewhere else on the
 * page, because the two figures below it are exactly its parts: a job either
 * belongs to an agency or it does not, so `private + agency` is `all` and a
 * reader can check the page by adding it up. Putting the total in the row of
 * tiles above would have invited reading it as a fourth bucket alongside
 * "today" and "open", which overlap each other and would not add to anything.
 *
 * All three counts come from **one pass over the same scoped rows** in
 * `jobTotals` — `COUNT(*)`, and two conditional counts on
 * `agent_organisation_id IS NULL` / `IS NOT NULL`. Same `WHERE`, mutually
 * exclusive, exhaustive: nothing is counted twice and nothing is missed. The
 * identity is asserted in `jobTotals`' own tests rather than trusted here.
 */
function Split({ totals }: { totals: JobTotals }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-extrabold text-navy-900">Who the work is for</h2>
      <p className="mt-1 text-sm text-navy-700">
        Private is a customer who booked on the website. Agency work is
        commissioned by a letting agent and belongs to their organisation.
        Every job is one or the other, so the two add up to the total.
      </p>

      <div className="mt-3 rounded-2xl border-2 border-navy-200 bg-white p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-navy-600">
              All jobs
            </p>
            <p className="mt-1 text-4xl font-extrabold text-navy-900">
              {totals.all}
            </p>
          </div>
          <p className="text-sm text-navy-700">
            {totals.open} open · {totals.completed} done ·{" "}
            {totals.cancelled} cancelled
          </p>
        </div>
        <p className="mt-3 text-sm">
          <Link href="/admin/jobs" className="font-bold text-flame-600 underline">
            Every job recorded
          </Link>
        </p>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border-2 border-navy-200 bg-white p-5">
          <p className="text-xs font-bold uppercase tracking-wide text-trust-600">
            Private
          </p>
          <p className="mt-1 text-3xl font-extrabold text-navy-900">
            {totals.private}
          </p>
          <p className="mt-1 text-sm text-navy-700">
            {totals.privateOpen} still open
          </p>
          <p className="mt-3 flex gap-3 text-sm">
            <Link
              href="/admin/jobs?client=private"
              className="font-bold text-flame-600 underline"
            >
              All
            </Link>
            <Link
              href="/admin/jobs?client=private&view=open"
              className="font-bold text-flame-600 underline"
            >
              Open
            </Link>
          </p>
        </div>
        <div className="rounded-2xl border-2 border-navy-200 bg-white p-5">
          <p className="text-xs font-bold uppercase tracking-wide text-navy-600">
            Agency
          </p>
          <p className="mt-1 text-3xl font-extrabold text-navy-900">
            {totals.agency}
          </p>
          <p className="mt-1 text-sm text-navy-700">
            {totals.agencyOpen} still open
          </p>
          <p className="mt-3 flex gap-3 text-sm">
            <Link
              href="/admin/jobs?client=agency"
              className="font-bold text-flame-600 underline"
            >
              All
            </Link>
            <Link
              href="/admin/jobs?client=agency&view=open"
              className="font-bold text-flame-600 underline"
            >
              Open
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

/** Where the open work has got to. Empty statuses are left out. */
function Pipeline({ totals }: { totals: JobTotals }) {
  const rows = JOB_LIFECYCLE_STATUSES.filter(
    (status) => (totals.byStatus[status] ?? 0) > 0,
  );

  return (
    <section className="mt-8 rounded-2xl border-2 border-navy-200 bg-white p-5">
      <h2 className="text-lg font-extrabold text-navy-900">Open work by stage</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-navy-700">
          Nothing open. {totals.completed} done, {totals.cancelled} cancelled.
        </p>
      ) : (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {rows.map((status) => (
            <li key={status}>
              <Link
                href={`/admin/jobs?status=${status}`}
                className="flex items-baseline justify-between gap-3 rounded-xl bg-navy-50 px-4 py-2 hover:bg-navy-100"
              >
                <span className="text-sm font-semibold text-navy-800">
                  {STATUS_LABELS[status]}
                </span>
                <span className="text-lg font-extrabold text-navy-900">
                  {totals.byStatus[status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {/*
        Only the link. The done and cancelled figures are stated once, beside
        the total they belong to — repeating them here invited the reading
        that they were a second, separately-derived pair.
      */}
      <p className="mt-4 text-sm text-navy-700">
        <Link href="/admin/jobs?view=closed" className="font-bold text-flame-600 underline">
          See closed jobs
        </Link>
      </p>
    </section>
  );
}
