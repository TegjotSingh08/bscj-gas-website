import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireEngineer } from "@/lib/auth/session";
import { getAssignedJob } from "@/lib/jobs/engineer-queries";
import { bookingConfig } from "@/lib/booking/config";
import { productFor } from "@/lib/booking/products";
import { StatusPill } from "@/components/jobs/JobLabels";
import {
  canComplete,
  canStart,
  completeRefusal,
  startRefusal,
} from "@/lib/jobs/work";
import type { JobLifecycleStatus } from "@/lib/jobs/lifecycle";
import { EngineerHeader } from "../../EngineerHeader";
import { CompleteWork, StartWork } from "../../WorkControls";
import { CertificateHandoff } from "../../CertificateHandoff";

export const metadata: Metadata = {
  title: "Job",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * The job, on site.
 *
 * Everything an engineer needs at the property and nothing else: where it is,
 * how to get in, who to ring, and the one button the job is ready for.
 *
 * **No money appears here and none is loaded.** The query behind this page
 * selects no price column at all, which is stronger than leaving it out of
 * the markup: a value that is never read cannot be leaked by a later change
 * to what this renders.
 *
 * The controls are chosen by the same pure rules the write enforces, so a
 * button that is shown and an action that is permitted cannot drift apart —
 * and the action decides again anyway, from the row.
 */
export default async function EngineerJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, scope } = await requireEngineer();
  const { id } = await params;

  /*
    Out of scope, not assigned to this engineer, and non-existent are the
    same answer, decided in the query. Distinguishing them turns an id into a
    probe for whose jobs are whose.
  */
  const job = await getAssignedJob(scope, id);
  if (!job) notFound();

  const timeZone = bookingConfig.timeZone;
  const status = job.lifecycleStatus as JobLifecycleStatus;
  const facts = {
    lifecycleStatus: status,
    assignedEngineerId: job.assignedEngineerId,
    hasAppointment: job.appointmentStart !== null,
  };

  const address = [job.houseOrName, job.street, job.town]
    .filter(Boolean)
    .join(", ");

  const when = (value: Date | null) =>
    value
      ? value.toLocaleString("en-GB", {
          timeZone,
          dateStyle: "full",
          timeStyle: "short",
        })
      : "—";

  const startable = canStart(facts, user.id);
  const completable = canComplete(facts, user.id);

  return (
    <>
      <EngineerHeader userName={user.name} back />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-extrabold text-navy-900">
            {job.reference}
          </h1>
          <StatusPill status={status} />
        </div>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <p className="text-xs font-bold uppercase tracking-wide text-navy-600">
            Where
          </p>
          <p className="mt-1 text-lg font-bold text-navy-900">{address}</p>
          <p className="text-xl font-extrabold tracking-wide text-navy-900">
            {job.postcode}
          </p>

          {job.accessNotes && (
            <div className="mt-4 rounded-xl bg-flame-400/15 px-4 py-3">
              <p className="text-xs font-bold uppercase tracking-wide text-navy-700">
                Access
              </p>
              <p className="mt-1 text-base text-navy-900">{job.accessNotes}</p>
            </div>
          )}

          <div className="mt-4 grid gap-2">
            {job.tenantPhone && (
              <a
                href={`tel:${job.tenantPhone}`}
                className="block rounded-xl border-2 border-navy-300 px-4 py-3 text-center text-base font-bold text-navy-900 hover:border-flame-500"
              >
                Ring {job.tenantName ?? "the tenant"} · {job.tenantPhone}
              </a>
            )}
            {job.customerPhone && (
              <a
                href={`tel:${job.customerPhone}`}
                className="block rounded-xl border-2 border-navy-300 px-4 py-3 text-center text-base font-bold text-navy-900 hover:border-flame-500"
              >
                Ring {job.customerName ?? "the customer"} · {job.customerPhone}
              </a>
            )}
          </div>
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <p className="text-xs font-bold uppercase tracking-wide text-navy-600">
            What and when
          </p>
          <p className="mt-1 text-base font-bold text-navy-900">
            {productFor(job.productId).name}
          </p>
          <p className="mt-1 text-sm text-navy-800">
            {when(job.appointmentStart)}
            {job.durationMinutes ? ` · ${job.durationMinutes} minutes` : ""}
          </p>
          {job.workStartedAt && (
            <p className="mt-1 text-sm text-navy-700">
              Started {when(job.workStartedAt)}
            </p>
          )}
          {job.completedAt && (
            <p className="mt-1 text-sm text-navy-700">
              Finished {when(job.completedAt)}
            </p>
          )}
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          {startable ? (
            <StartWork jobId={job.id} />
          ) : completable ? (
            <CompleteWork jobId={job.id} />
          ) : (
            <p className="text-sm font-semibold text-navy-800">
              {status === "completed"
                ? "This job is done."
                : (startRefusal(facts, user.id) ??
                  completeRefusal(facts, user.id) ??
                  "There is nothing to do on this job right now.")}
            </p>
          )}
        </section>

        {/*
          Offered from the moment somebody is on site, and still there once
          the job is done — the paperwork routinely follows the visit by an
          hour. Not offered before: a certificate for a visit that has not
          started is a certificate for a visit that has not happened.
        */}
        {(status === "in_progress" ||
          status === "remedial_required" ||
          status === "completed") && (
          <CertificateHandoff jobId={job.id} reference={job.reference} />
        )}

        {job.completionNotes && (
          <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
            <p className="text-xs font-bold uppercase tracking-wide text-navy-600">
              What was recorded
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-navy-900">
              {job.completionNotes}
            </p>
          </section>
        )}
      </main>
    </>
  );
}
