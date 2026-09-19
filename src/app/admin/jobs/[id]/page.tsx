import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/session";
import { getJob, jobTimeline, listEngineers } from "@/lib/jobs/queries";
import { productFor } from "@/lib/booking/products";
import { bookingConfig } from "@/lib/booking/config";
import {
  fetchNotificationStates,
  fetchRecordedException,
} from "@/lib/notifications/outbox";
import { LateBookingNotice } from "@/components/jobs/LateBookingNotice";
import { JobMessages } from "@/components/jobs/JobMessages";
import { JobTimeline } from "@/components/jobs/JobTimeline";
import {
  ClientPill,
  DeadlineNote,
  StatusPill,
} from "@/components/jobs/JobLabels";
import {
  ATTENTION_LABELS,
  ATTENTION_NOTES,
} from "@/lib/jobs/attention";
import { assignRefusal, canAssign, canUnassign } from "@/lib/jobs/work";
import type { JobLifecycleStatus } from "@/lib/jobs/lifecycle";
import { ResendInvitation } from "../ResendInvitation";
import { AssignEngineer } from "../AssignEngineer";
import { AdminNav } from "../../AdminNav";

export const metadata: Metadata = {
  title: "Job",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

const money = (pence: number) => `£${(pence / 100).toFixed(2)}`;

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-b border-navy-100 py-2 last:border-0 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-navy-900 sm:col-span-2 sm:mt-0">
        {value ?? "—"}
      </dd>
    </div>
  );
}

/**
 * One job, in full.
 *
 * It was a read-only check that a website booking had been recorded. It is
 * now the screen somebody runs a job from, and the difference is one
 * mutation: **allocation**. Starting and completing the work belong to
 * whoever is actually standing at the property, so those controls live on the
 * engineer's own screen and are not duplicated here — an administrator who
 * needs them opens `/engineer`, which they are allowed to do, and acts as
 * themselves rather than on somebody's behalf.
 *
 * Everything the allocation controls decide is decided again in the action,
 * from the row. The buttons are rendered from the same pure rules the write
 * enforces, so what is offered and what is permitted cannot drift apart.
 */
export default async function AdminJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, scope } = await requireAdmin();
  const { id } = await params;

  // Out of scope and non-existent are the same answer, decided in the query.
  const found = await getJob(scope, id);
  if (!found) notFound();

  const {
    job,
    customer,
    property,
    tenancy,
    priceSnapshot,
    engineerName,
    organisationName,
    risk,
    attention,
  } = found;
  const product = productFor(job.productId);
  const status = job.lifecycleStatus as JobLifecycleStatus;

  const facts = {
    lifecycleStatus: status,
    assignedEngineerId: job.assignedEngineerId,
    hasAppointment: job.appointmentStart !== null,
  };

  const [engineers, timeline, notifications] = await Promise.all([
    listEngineers(scope),
    jobTimeline(scope, job.id),
    fetchNotificationStates(job.id),
  ]);

  const when = (value: Date | null) =>
    value
      ? value.toLocaleString("en-GB", {
          timeZone: bookingConfig.timeZone,
          dateStyle: "full",
          timeStyle: "short",
        })
      : null;

  /*
    Only read when the job actually carries an exception, so an ordinary job
    costs nothing extra. The flag is on the row; the detail is on the timeline.
  */
  const exception = job.deadlineExceptionAt
    ? await fetchRecordedException(job.id, job.appointmentStart)
    : null;

  return (
    <>
      <AdminNav userName={user.name} current="jobs" />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-extrabold text-navy-900">
              {job.reference}
            </h1>
            <StatusPill status={status} />
            <ClientPill organisationName={organisationName} />
          </div>
          <Link
            href="/admin/jobs"
            className="text-sm font-bold text-flame-600 underline"
          >
            Back to jobs
          </Link>
        </div>

        {attention.length > 0 && (
          <section
            role="alert"
            className="mt-4 rounded-2xl border-2 border-flame-500 bg-flame-400/10 p-5"
          >
            <h2 className="text-sm font-extrabold text-navy-900">
              This job needs somebody
            </h2>
            <ul className="mt-2 grid gap-2 text-sm text-navy-800">
              {attention.map((reason) => (
                <li key={reason}>
                  <strong className="font-extrabold text-navy-900">
                    {ATTENTION_LABELS[reason]}
                  </strong>{" "}
                  — {ATTENTION_NOTES[reason]}
                </li>
              ))}
            </ul>
          </section>
        )}

        {exception && (
          <LateBookingNotice
            exception={exception}
            notifications={notifications.filter(
              (n) => n.kind === "late-booking-exception",
            )}
            audience="admin"
          />
        )}

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Who is on it</h2>
          <dl className="mt-2">
            <Row
              label="Engineer"
              value={engineerName ?? "Nobody allocated yet"}
            />
            <Row label="Started" value={when(job.workStartedAt)} />
            <Row label="Finished" value={when(job.completedAt)} />
            {job.completionNotes && (
              <Row
                label="What the engineer recorded"
                value={
                  <span className="whitespace-pre-wrap">
                    {job.completionNotes}
                  </span>
                }
              />
            )}
          </dl>

          <AssignEngineer
            jobId={job.id}
            engineers={engineers}
            assignedEngineerId={job.assignedEngineerId}
            canAssign={canAssign(facts)}
            canUnassign={canUnassign(facts)}
            refusal={assignRefusal(facts)}
          />
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Appointment</h2>
          <dl className="mt-2">
            <Row label="Service" value={product.name} />
            <Row label="Starts" value={when(job.appointmentStart)} />
            <Row label="Ends" value={when(job.appointmentEnd)} />
            <Row
              label="Duration"
              value={job.durationMinutes ? `${job.durationMinutes} minutes` : null}
            />
            <Row label="Booked by" value={job.schedulingMethod.replace(/_/g, " ")} />
            <Row label="Source" value={job.source.replace(/_/g, " ")} />
            <Row
              label="Requested completion date"
              value={
                job.completeByDate ? (
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span>{job.completeByDate}</span>
                    <DeadlineNote risk={risk} completeByDate={job.completeByDate} />
                  </span>
                ) : job.requestedAsap ? (
                  "As soon as possible — no date given"
                ) : null
              }
            />
          </dl>
        </section>

        <JobMessages notifications={notifications}>
          <ResendInvitation jobId={job.id} />
        </JobMessages>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Customer</h2>
          <dl className="mt-2">
            <Row label="Name" value={customer?.name} />
            <Row label="Company" value={customer?.company} />
            <Row label="Type" value={customer?.type.replace(/_/g, " ")} />
            <Row label="Email" value={customer?.email} />
            <Row
              label="Phone"
              value={
                customer?.phone ? (
                  <a className="underline" href={`tel:${customer.phone}`}>
                    {customer.phone}
                  </a>
                ) : null
              }
            />
            <Row label="Agency" value={organisationName ?? "None — private work"} />
          </dl>
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Property</h2>
          <dl className="mt-2">
            <Row
              label="Address"
              value={
                property
                  ? [property.houseOrName, property.street, property.town]
                      .filter(Boolean)
                      .join(", ")
                  : null
              }
            />
            <Row label="Postcode" value={property?.postcode} />
            <Row label="Access notes" value={property?.accessNotes} />
            <Row
              label="Tenant"
              value={
                tenancy
                  ? [tenancy.name, tenancy.phone].filter(Boolean).join(" — ")
                  : "Not applicable"
              }
            />
          </dl>
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Price</h2>
          <dl className="mt-2">
            <Row label="Total charged" value={money(job.priceTotalPence)} />
            <Row
              label="Appliances"
              value={
                job.applianceCount === null
                  ? "Not priced by appliance"
                  : String(job.applianceCount)
              }
            />
            {/*
              Read from the frozen snapshot, never re-resolved. What this job cost
              is what it cost, whatever the price list says today.
            */}
            <Row
              label="Rate applied"
              value={
                priceSnapshot
                  ? `${money(priceSnapshot.unitPricePence)} (${priceSnapshot.source})`
                  : "Snapshot unreadable"
              }
            />
            <Row
              label="List price then"
              value={priceSnapshot ? money(priceSnapshot.listPricePence) : null}
            />
            <Row
              label="Extra appliance charge"
              value={priceSnapshot ? money(priceSnapshot.extraChargePence) : null}
            />
          </dl>
        </section>

        <JobTimeline entries={timeline} timeZone={bookingConfig.timeZone} />

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Record</h2>
          <dl className="mt-2">
            <Row label="Calendar event" value={job.calendarEventId} />
            <Row
              label="Calendar sync"
              value={job.calendarSyncState.replace(/_/g, " ")}
            />
            <Row label="Recorded" value={when(job.createdAt)} />
          </dl>
        </section>
      </main>
    </>
  );
}
