import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/session";
import { getJob } from "@/lib/jobs/queries";
import { productFor } from "@/lib/booking/products";
import { bookingConfig } from "@/lib/booking/config";
import {
  fetchNotificationStates,
  fetchRecordedException,
} from "@/lib/notifications/outbox";
import { LateBookingNotice } from "@/components/jobs/LateBookingNotice";

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
 * One job, for checking that a website booking was recorded correctly.
 *
 * Read-only. Nothing on this page changes a job: editing, assigning and
 * status changes arrive with the phases that need them, and adding a mutation
 * here before the lifecycle rules are wired in would be the fastest way to put
 * a job into a state `assertTransition` would have refused.
 */
export default async function AdminJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { scope } = await requireAdmin();
  const { id } = await params;

  // Out of scope and non-existent are the same answer, decided in the query.
  const found = await getJob(scope, id);
  if (!found) notFound();

  const { job, customer, property, tenancy, priceSnapshot } = found;
  const product = productFor(job.productId);

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
  const notifications = exception ? await fetchNotificationStates(job.id) : [];

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-extrabold text-navy-900">
          {job.reference}
        </h1>
        <Link
          href="/admin/jobs"
          className="text-sm font-bold text-flame-600 underline"
        >
          Back to jobs
        </Link>
      </div>

      {exception && (
        <LateBookingNotice
          exception={exception}
          notifications={notifications}
          audience="admin"
        />
      )}

      <section className="mt-6 rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">Appointment</h2>
        <dl className="mt-2">
          <Row label="Service" value={product.name} />
          <Row label="Starts" value={when(job.appointmentStart)} />
          <Row label="Ends" value={when(job.appointmentEnd)} />
          <Row
            label="Duration"
            value={job.durationMinutes ? `${job.durationMinutes} minutes` : null}
          />
          <Row label="Status" value={job.lifecycleStatus.replace(/_/g, " ")} />
          <Row label="Booked by" value={job.schedulingMethod.replace(/_/g, " ")} />
          <Row label="Source" value={job.source.replace(/_/g, " ")} />
          <Row label="Requested completion date" value={job.completeByDate} />
        </dl>
      </section>

      <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">Customer</h2>
        <dl className="mt-2">
          <Row label="Name" value={customer?.name} />
          <Row label="Company" value={customer?.company} />
          <Row label="Type" value={customer?.type.replace(/_/g, " ")} />
          <Row label="Email" value={customer?.email} />
          <Row label="Phone" value={customer?.phone} />
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

      <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">Record</h2>
        <dl className="mt-2">
          <Row label="Calendar event" value={job.calendarEventId} />
          <Row label="Calendar sync" value={job.calendarSyncState.replace(/_/g, " ")} />
          <Row label="Recorded" value={when(job.createdAt)} />
        </dl>
      </section>
    </main>
  );
}
