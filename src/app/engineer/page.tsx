import type { Metadata } from "next";
import Link from "next/link";

import { requireEngineer } from "@/lib/auth/session";
import {
  listDayJobs,
  nextAssignedJob,
  type EngineerJobRow,
} from "@/lib/jobs/engineer-queries";
import { bookingConfig } from "@/lib/booking/config";
import {
  formatLongDate,
  isoDateInZone,
  parseIsoDate,
  timeLabelInZone,
  zonedTimeToUtc,
} from "@/lib/booking/time";
import { productFor } from "@/lib/booking/products";
import { StatusPill } from "@/components/jobs/JobLabels";
import type { JobLifecycleStatus } from "@/lib/jobs/lifecycle";
import { EngineerHeader } from "./EngineerHeader";

export const metadata: Metadata = {
  title: "Today",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * The day, in the order it happens.
 *
 * Built for a phone held in one hand at a front door, which decides almost
 * everything about it: one column, one card per job, the time and the
 * postcode readable at arm's length, and the two things an engineer actually
 * needs before they knock — the access note and a number to ring — on the
 * card rather than one tap away.
 *
 * **It shows what is allocated to the person signed in, and nothing else.**
 * The scope comes from the verified session and every query filters on the
 * assignment; there is no parameter here that can widen it. An administrator
 * signed in to this screen sees the whole day, because they are allowed to
 * work it — as themselves, not as somebody else.
 *
 * No price, anywhere. The engineer role has neither `pricing:read` nor
 * `invoice:read`, and the queries behind this page never load a money column
 * at all.
 */
export default async function EngineerDayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, scope } = await requireEngineer();

  const timeZone = bookingConfig.timeZone;
  const now = new Date();
  const today = isoDateInZone(now, timeZone);

  const asked = await searchParams;
  const requested = typeof asked.date === "string" ? asked.date : "";
  // A date that is not a date is today. There is nothing to refuse here —
  // the parameter chooses which of the caller's own days to show.
  const date = parseIsoDate(requested) ? requested : today;

  const [jobs, next] = await Promise.all([
    listDayJobs(scope, date),
    nextAssignedJob(scope, now),
  ]);

  const done = jobs.filter((job) => job.completedAt !== null).length;

  return (
    <>
      <EngineerHeader userName={user.name} />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <DayNav date={date} today={today} timeZone={timeZone} />

        <p className="mt-3 text-sm text-navy-700" role="status">
          {jobs.length === 0
            ? "Nothing in the diary."
            : `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}${
                done > 0 ? `, ${done} done` : ""
              }`}
        </p>

        {jobs.length === 0 ? (
          <div className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
            <p className="text-sm text-navy-700">
              Nothing is allocated to you on this day.
            </p>
            {next && next.appointmentStart && (
              <p className="mt-3 text-sm text-navy-800">
                Next up:{" "}
                <Link
                  href={`/engineer?date=${isoDateInZone(next.appointmentStart, timeZone)}`}
                  className="font-bold text-flame-600 underline"
                >
                  {formatLongDate(
                    isoDateInZone(next.appointmentStart, timeZone),
                    timeZone,
                  )}{" "}
                  at {timeLabelInZone(next.appointmentStart, timeZone)}
                </Link>
              </p>
            )}
          </div>
        ) : (
          <ol className="mt-4 grid gap-4">
            {jobs.map((job) => (
              <li key={job.id}>
                <JobCard job={job} timeZone={timeZone} />
              </li>
            ))}
          </ol>
        )}
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------

/** Yesterday, the date, tomorrow. A diary is read by stepping through it. */
function DayNav({
  date,
  today,
  timeZone,
}: {
  date: string;
  today: string;
  timeZone: string;
}) {
  const step = (days: number) => {
    const parsed = parseIsoDate(date);
    if (!parsed) return today;
    // Stepping from midday keeps the intermediate instant clear of both DST
    // transitions, which happen in the small hours.
    const noon = zonedTimeToUtc({ ...parsed, hour: 12, minute: 0 }, timeZone);
    return isoDateInZone(
      new Date(noon.getTime() + days * 24 * 60 * 60 * 1000),
      timeZone,
    );
  };

  const button =
    "rounded-xl border-2 border-navy-200 bg-white px-4 py-3 text-sm font-bold text-navy-900 hover:border-flame-500";

  return (
    <nav className="flex items-center justify-between gap-3" aria-label="Day">
      <Link href={`/engineer?date=${step(-1)}`} className={button} rel="prev">
        ←
      </Link>
      <div className="text-center">
        <h1 className="text-lg font-extrabold text-navy-900">
          {date === today ? "Today" : formatLongDate(date, timeZone)}
        </h1>
        {date === today ? (
          <p className="text-xs text-navy-600">{formatLongDate(date, timeZone)}</p>
        ) : (
          <Link
            href="/engineer"
            className="text-xs font-bold text-flame-600 underline"
          >
            back to today
          </Link>
        )}
      </div>
      <Link href={`/engineer?date=${step(1)}`} className={button} rel="next">
        →
      </Link>
    </nav>
  );
}

/**
 * One job, as much of it as is useful before knocking.
 *
 * The whole card is the link. A tap target the size of a card is the
 * difference between usable and not on a phone in the rain — with the
 * exception of the phone numbers, which are their own links because ringing
 * ahead is a different intention from opening the job.
 */
export function JobCard({
  job,
  timeZone,
}: {
  job: EngineerJobRow;
  timeZone: string;
}) {
  const address = [job.houseOrName, job.street, job.town]
    .filter(Boolean)
    .join(", ");
  const phone = job.tenantPhone ?? job.customerPhone;
  const whom = job.tenantPhone ? (job.tenantName ?? "the tenant") : (job.customerName ?? "the customer");

  return (
    <article className="rounded-2xl border-2 border-navy-200 bg-white">
      <Link
        href={`/engineer/jobs/${job.id}`}
        className="block rounded-t-2xl px-5 pt-4 hover:bg-navy-50"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-2xl font-extrabold text-navy-900">
            {job.appointmentStart
              ? timeLabelInZone(job.appointmentStart, timeZone)
              : "No time"}
          </p>
          <StatusPill status={job.lifecycleStatus as JobLifecycleStatus} />
        </div>
        <p className="mt-1 text-sm font-bold text-navy-900">
          {productFor(job.productId).subjectName}
        </p>
        <p className="mt-2 text-base font-semibold text-navy-900">{address}</p>
        <p className="text-base font-extrabold tracking-wide text-navy-900">
          {job.postcode}
        </p>
        <p className="mt-2 pb-4 text-xs font-bold uppercase tracking-wide text-flame-600">
          {job.reference} · open the job →
        </p>
      </Link>

      {(job.accessNotes || phone) && (
        <div className="border-t-2 border-navy-100 px-5 py-3">
          {job.accessNotes && (
            <p className="text-sm text-navy-800">
              <span className="font-bold">Access:</span> {job.accessNotes}
            </p>
          )}
          {phone && (
            <p className="mt-2">
              <a
                href={`tel:${phone}`}
                className="inline-block rounded-xl border-2 border-navy-300 px-4 py-2 text-sm font-bold text-navy-900 hover:border-flame-500"
              >
                Ring {whom} · {phone}
              </a>
            </p>
          )}
        </div>
      )}
    </article>
  );
}
