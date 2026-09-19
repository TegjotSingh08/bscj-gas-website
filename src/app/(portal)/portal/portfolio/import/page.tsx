import type { Metadata } from "next";
import Link from "next/link";

import { requireAgent, requireCapability } from "@/lib/auth/session";
import { COLUMNS, TEMPLATE_FILENAME } from "@/lib/portfolio/import/columns";
import { ACCEPTED_DATE_FORMATS } from "@/lib/portfolio/import/dates";
import { LIMITS } from "@/lib/portfolio/import/csv";
import { listUnfinishedImports } from "@/lib/portfolio/import/lookup";
import { ImportWizard } from "./ImportWizard";

export const metadata: Metadata = {
  title: "Import properties",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * Importing a portfolio from a spreadsheet.
 *
 * The guidance is on the page rather than only in the template, because the
 * person who exports the file and the person who reads the instructions are
 * often the same person doing it once, six weeks apart. Every column is listed
 * with what it means and whether it is needed; the date rule is stated in full,
 * because a certificate expiry read a month wrong is the one mistake here with
 * a real consequence.
 */
export default async function ImportPage() {
  const session = await requireAgent();
  requireCapability(session, "portfolio:write");

  const required = COLUMNS.filter((column) => column.required);
  const optional = COLUMNS.filter((column) => !column.required);

  /*
    Imports that were claimed and never reported back — a browser closed
    mid-write, a process restarted. Reported rather than resumed: re-uploading
    is already safe, and the preview is what tells the agent where it got to.
  */
  const unfinished = await listUnfinishedImports(session.organisationId);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-navy-900">
            Import properties
          </h1>
          <p className="mt-1 text-sm text-navy-600">
            Upload a spreadsheet, check what it will do, then confirm. Nothing
            is written until you confirm.
          </p>
        </div>
        <Link
          href="/portal/portfolio"
          className="text-sm font-bold text-flame-600 underline"
        >
          Back to portfolio
        </Link>
      </div>

      {unfinished.length > 0 && (
        <section
          role="status"
          className="mt-6 rounded-2xl border-2 border-flame-500 bg-flame-400/10 p-5"
        >
          <h2 className="text-sm font-extrabold text-navy-900">
            {unfinished.length === 1
              ? "An earlier import did not finish"
              : `${unfinished.length} earlier imports did not finish`}
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-navy-700">
            {unfinished.map((run) => (
              <li key={run.id}>
                <span className="font-bold">{run.filename ?? "A file"}</span> —{" "}
                {run.rowCount} row{run.rowCount === 1 ? "" : "s"}, started{" "}
                {run.startedAt.toLocaleString("en-GB", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </li>
            ))}
          </ul>
          {/*
            Deliberately no counts. The stalled row's counters are still at
            zero and that is not the truth — properties were very likely
            written before it stopped. Quoting them would be worse than saying
            nothing, so we say what we actually know and how to find out.
          */}
          <p className="mt-3 text-sm text-navy-700">
            We cannot tell how far it got before it stopped. Nothing is broken
            and nothing was half-written: each property either went in or did
            not.
          </p>
          <p className="mt-2 text-sm font-bold text-navy-900">
            Upload the same file again. The preview compares it against your
            portfolio, so anything already in shows as “already match” and only
            the rest is offered.
          </p>
        </section>
      )}

      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border-2 border-navy-200 bg-white p-5 lg:col-span-2">
          <h2 className="text-sm font-extrabold text-navy-900">
            1. Start from the template
          </h2>
          <p className="mt-2 text-sm text-navy-700">
            The template has the right headings in the right order. If you are
            exporting from your own system, rename its columns to match these —
            capitals, spaces and underscores do not matter.
          </p>
          <a
            href="/portal/portfolio/import/template"
            className="mt-4 inline-block rounded-xl border-2 border-navy-200 px-5 py-2.5 text-sm font-bold text-navy-900 hover:border-navy-600"
            download={TEMPLATE_FILENAME}
          >
            Download the CSV template
          </a>

          <h3 className="mt-6 text-xs font-extrabold uppercase tracking-wide text-navy-600">
            Required
          </h3>
          <dl className="mt-2 divide-y divide-navy-100">
            {required.map((column) => (
              <div key={column.key} className="py-2 sm:grid sm:grid-cols-3 sm:gap-4">
                <dt className="font-mono text-xs font-bold text-navy-900">
                  {column.header}
                </dt>
                <dd className="text-sm text-navy-700 sm:col-span-2">
                  {column.help}
                </dd>
              </div>
            ))}
          </dl>

          <h3 className="mt-5 text-xs font-extrabold uppercase tracking-wide text-navy-600">
            Optional
          </h3>
          <dl className="mt-2 divide-y divide-navy-100">
            {optional.map((column) => (
              <div key={column.key} className="py-2 sm:grid sm:grid-cols-3 sm:gap-4">
                <dt className="font-mono text-xs font-bold text-navy-900">
                  {column.header}
                </dt>
                <dd className="text-sm text-navy-700 sm:col-span-2">
                  {column.help}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <aside className="space-y-4">
          <div className="rounded-2xl border-2 border-navy-200 bg-white p-5">
            <h2 className="text-sm font-extrabold text-navy-900">Dates</h2>
            <p className="mt-2 text-sm text-navy-700">
              Write dates as{" "}
              <span className="font-bold">{ACCEPTED_DATE_FORMATS}</span>.
            </p>
            <p className="mt-2 text-sm text-navy-700">
              Anything ambiguous is refused rather than guessed —{" "}
              <span className="font-mono text-xs">01/02/26</span> could be two
              different years, and{" "}
              <span className="font-mono text-xs">03/04/2026</span> means 3 April
              here and 4 March in the United States.
            </p>
            <p className="mt-2 text-sm text-navy-700">
              The preview writes every date back out in full, so you can see we
              read it the way you meant it.
            </p>
          </div>

          <div className="rounded-2xl border-2 border-navy-200 bg-white p-5">
            <h2 className="text-sm font-extrabold text-navy-900">Limits</h2>
            <ul className="mt-2 space-y-1 text-sm text-navy-700">
              <li>CSV files only, for now.</li>
              <li>Up to {LIMITS.rows} properties at a time.</li>
              <li>Up to {LIMITS.bytes / 1024 / 1024} MB per file.</li>
            </ul>
            <p className="mt-2 text-xs text-navy-600">
              A larger portfolio is fine — split it and import in parts. Nothing
              is lost between parts.
            </p>
          </div>

          <div className="rounded-2xl border-2 border-navy-200 bg-white p-5">
            <h2 className="text-sm font-extrabold text-navy-900">
              What importing does not do
            </h2>
            <ul className="mt-2 space-y-1 text-sm text-navy-700">
              <li>No work is booked.</li>
              <li>No tenant is contacted.</li>
              <li>Nothing is charged.</li>
            </ul>
            <p className="mt-2 text-xs text-navy-600">
              It records your properties. You request work afterwards, property
              by property, when you want it.
            </p>
          </div>
        </aside>
      </section>

      <ImportWizard />
    </main>
  );
}
