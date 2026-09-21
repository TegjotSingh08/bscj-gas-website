import type { Metadata } from "next";
import Link from "next/link";

import { requireAdmin } from "@/lib/auth/session";
import { AdminNav } from "../AdminNav";
import {
  listDueWork,
  resolveRange,
  type DueBucket,
  type DueWorkRow,
} from "@/lib/compliance/due-work";
import { isoDateInZone } from "@/lib/booking/time";
import { bookingConfig } from "@/lib/booking/config";
import { STATUS_LABELS } from "@/components/jobs/JobLabels";

export const metadata: Metadata = {
  title: "Renewals due",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * What is due, what is overdue, and what nobody knows about.
 *
 * The weekly operational question, and until now there was no screen that
 * answered it — the portfolio list shows one agency's properties, and nothing
 * showed the work itself across agencies ordered by how late it is.
 *
 * **It lists and links. It contacts nobody.** No reminder is sent from here,
 * nothing is scheduled, and "due soon" is whatever range the person looking
 * typed — shown back to them explicitly — rather than a threshold somebody
 * invented. A property with work already in hand says so, with the reference
 * and the status, because the failure mode of a list like this is chasing an
 * agency for a job that was raised last week.
 */

const BUCKET_STYLE: Record<DueBucket, string> = {
  overdue: "border-flame-500 bg-flame-400/10",
  in_range: "border-navy-300 bg-white",
  later: "border-navy-100 bg-white",
  unknown: "border-navy-200 bg-navy-50",
};

const BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: "Overdue",
  in_range: "Due in range",
  later: "Later",
  unknown: "No date on file",
};

function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export default async function DueWorkPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; show?: string }>;
}) {
  const session = await requireAdmin();
  const params = await searchParams;

  // London, like every other date in the product. A renewal has no time of day.
  const today = isoDateInZone(new Date(), bookingConfig.timeZone);
  const range = resolveRange(params.from, params.to, today);

  const result = await listDueWork({ range, today });

  const show = params.show === "all" ? "all" : "action";
  /*
    The default hides `later`, which is most of a healthy portfolio and none of
    this week's work. It is a filter on the screen, not on the query — the
    counts underneath have to be the real ones.
  */
  const visible =
    result?.rows.filter((row) => show === "all" || row.bucket !== "later") ?? [];

  return (
    <>
      <AdminNav userName={session.user.name ?? session.user.email} current="due" />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-extrabold text-navy-900 sm:text-3xl">
          Renewals due
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-navy-700">
          Every property BSCJ tracks, ordered by how soon it is due. Nothing on
          this page contacts anybody — it shows what needs arranging and what is
          already in hand.
        </p>

        {result === null ? (
          <p
            role="alert"
            className="mt-6 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
          >
            The renewal list could not be read just now. Nothing is wrong with
            the records; try again shortly.
          </p>
        ) : (
          <>
            <form
              method="get"
              className="mt-6 flex flex-wrap items-end gap-3 rounded-2xl border-2 border-navy-200 bg-white p-4"
            >
              <div>
                <label
                  htmlFor="from"
                  className="block text-xs font-bold text-navy-900"
                >
                  Due from
                </label>
                <input
                  id="from"
                  name="from"
                  type="date"
                  defaultValue={range.from}
                  className="mt-1 rounded-lg border-2 border-navy-200 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label
                  htmlFor="to"
                  className="block text-xs font-bold text-navy-900"
                >
                  Due to
                </label>
                <input
                  id="to"
                  name="to"
                  type="date"
                  defaultValue={range.to}
                  className="mt-1 rounded-lg border-2 border-navy-200 px-3 py-2 text-sm"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-navy-900">
                <input
                  type="checkbox"
                  name="show"
                  value="all"
                  defaultChecked={show === "all"}
                  className="h-4 w-4"
                />
                Include everything due later
              </label>
              <button
                type="submit"
                className="rounded-xl bg-navy-900 px-5 py-2.5 text-sm font-bold text-white hover:bg-navy-800"
              >
                Show
              </button>
            </form>

            <p className="mt-2 text-xs text-navy-600">
              Showing renewals due between{" "}
              <span className="font-bold">{longDate(range.from)}</span> and{" "}
              <span className="font-bold">{longDate(range.to)}</span>, plus
              everything overdue and everything with no date on file. Today is{" "}
              {longDate(today)}.
            </p>

            <dl className="mt-4 grid grid-cols-3 gap-3">
              <Count label="Overdue" value={result.summary.overdue} emphasis />
              <Count label="Due in range" value={result.summary.inRange} />
              <Count label="No date on file" value={result.summary.unknown} />
            </dl>

            {visible.length === 0 ? (
              <p className="mt-6 rounded-xl border-2 border-navy-200 bg-white px-4 py-4 text-sm text-navy-700">
                Nothing is overdue, nothing falls in that range, and every
                property has a date on file. Widen the range, or tick
                &ldquo;include everything due later&rdquo; to see the rest.
              </p>
            ) : (
              <ul className="mt-6 space-y-3">
                {visible.map((row) => (
                  <DueRow key={row.propertyId} row={row} />
                ))}
              </ul>
            )}

            <p className="mt-6 text-xs leading-relaxed text-navy-600">
              Work is requested by the agency from their own portal, against the
              property. BSCJ does not raise it on their behalf from here — if
              something on this list needs arranging, the agency is the route,
              and their page is linked on each row.
            </p>
          </>
        )}
      </main>
    </>
  );
}

function DueRow({ row }: { row: DueWorkRow }) {
  const address = [row.houseOrName, row.street, row.town, row.postcode]
    .filter(Boolean)
    .join(", ");

  return (
    <li className={`rounded-xl border-2 p-4 ${BUCKET_STYLE[row.bucket]}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-navy-900">{address}</p>
          <p className="mt-0.5 text-xs text-navy-700">
            {row.landlordName}
            {row.organisationId ? (
              <>
                {" · "}
                <Link
                  href={`/admin/organisations/${row.organisationId}`}
                  className="font-bold text-navy-900 underline"
                >
                  {row.organisationName ?? "Agency"}
                </Link>
              </>
            ) : (
              " · Direct customer"
            )}
          </p>
        </div>

        <div className="text-right">
          <span className="inline-block rounded-lg border-2 border-current px-2 py-0.5 text-xs font-bold text-navy-900">
            {BUCKET_LABEL[row.bucket]}
          </span>
          <p className="mt-1 text-sm font-bold text-navy-900">
            {row.dueDate ? longDate(row.dueDate) : "Not known"}
          </p>
        </div>
      </div>

      {/*
        The whole reason this is on the row rather than a click away: chasing an
        agency for work that is already booked is the way a list like this
        loses trust in a fortnight.
      */}
      {row.openJobId ? (
        <p className="mt-3 rounded-lg border-2 border-navy-200 bg-white px-3 py-2 text-xs text-navy-800">
          Already in hand —{" "}
          <Link
            href={`/admin/jobs/${row.openJobId}`}
            className="font-bold text-navy-900 underline"
          >
            {row.openJobReference}
          </Link>
          {row.openJobStatus ? `, ${STATUS_LABELS[row.openJobStatus]}` : null}.
          No need to ask for it again.
        </p>
      ) : (
        <p className="mt-3 text-xs text-navy-700">
          {row.bucket === "unknown"
            ? "No certificate date is on file for this property — usually an import with no expiry column. Ask the agency for the current certificate, or record it on the property."
            : "No open job on this property."}
        </p>
      )}
    </li>
  );
}

function Count({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border-2 p-3 ${
        emphasis && value > 0
          ? "border-flame-500 bg-flame-400/10"
          : "border-navy-200 bg-white"
      }`}
    >
      <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
        {label}
      </dt>
      <dd className="mt-0.5 text-2xl font-extrabold text-navy-900">{value}</dd>
    </div>
  );
}
