import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAgent } from "@/lib/auth/session";
import { getAgencyJob } from "@/lib/jobs/portal-queries";
import { listAgencyJobCertificates } from "@/lib/documents/certificates";
import { productFor } from "@/lib/booking/products";
import { fetchRecordedException } from "@/lib/notifications/outbox";
import { LateBookingNotice } from "@/components/jobs/LateBookingNotice";
import { PortalNav } from "../../PortalNav";

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
 * One job, read-only.
 *
 * Confirmation that the request landed and what it will cost. Rescheduling,
 * cancelling and messaging belong to later phases and are deliberately absent:
 * adding a mutation before the lifecycle rules are wired in is the fastest way
 * to put a job into a state `assertTransition` would have refused.
 */
export default async function AgencyJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, organisationId, organisationName } = await requireAgent();
  const { id } = await params;

  const found = await getAgencyJob(organisationId, id);
  if (!found) notFound();

  /*
    Scoped by the organisation in its own `WHERE`, not filtered after. The
    job was already proved to be theirs above; this proves the certificate
    is too, which is the check that matters when a document is about to be
    offered for download.
  */
  const certificates = await listAgencyJobCertificates(organisationId, id);

  const { job, property, landlord, priceSnapshot, invitation } = found;
  const product = productFor(job.productId);

  /*
    The agency sees the same facts BSCJ does, minus the notification plumbing:
    whether their own alert was accepted by a provider is our operational
    detail, not theirs.
  */
  const exception = job.deadlineExceptionAt
    ? await fetchRecordedException(job.id, job.appointmentStart)
    : null;

  return (
    <>
      <PortalNav
        organisationName={organisationName}
        userName={user.name}
        current="jobs"
      />

      <main className="mx-auto max-w-3xl px-4 py-8">
        <Link href="/portal/jobs" className="text-sm font-bold text-flame-600 underline">
          Back to jobs
        </Link>

        <h1 className="mt-2 text-2xl font-extrabold text-navy-900">
          {job.reference}
        </h1>
        <p className="text-sm text-navy-600">
          Quote this reference if you call us about it.
        </p>

        <div className="mt-4 rounded-2xl border-2 border-navy-200 bg-navy-50 p-5">
          <p className="text-sm font-bold text-navy-900">
            {job.lifecycleStatus === "tenant_outreach"
              ? "Booked — we are arranging the appointment"
              : job.lifecycleStatus.replace(/_/g, " ")}
          </p>
          <p className="mt-1 text-sm text-navy-700">
            {invitation
              ? "We will contact the tenant to choose a time that suits them, and the appointment will appear here once it is set."
              : "We will be in touch to arrange access."}
          </p>
        </div>

        {exception && (
          <LateBookingNotice
            exception={exception}
            notifications={[]}
            audience="agent"
          />
        )}

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Work requested</h2>
          <dl className="mt-2">
            <Row label="Service" value={product.name} />
            <Row
              label="Appliances"
              value={
                job.applianceCount === null
                  ? "Not priced by appliance"
                  : String(job.applianceCount)
              }
            />
            <Row
              label="Needed"
              value={
                job.requestedAsap
                  ? "As soon as possible"
                  : (job.completeByDate ?? "—")
              }
            />
            <Row
              label="Appointment"
              value={
                job.appointmentStart
                  ? job.appointmentStart.toLocaleString("en-GB", {
                      timeZone: "Europe/London",
                      dateStyle: "full",
                      timeStyle: "short",
                    })
                  : "Not yet arranged"
              }
            />
          </dl>
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Property</h2>
          <dl className="mt-2">
            <Row
              label="Address"
              value={
                <Link
                  href={`/portal/portfolio/${property.id}`}
                  className="font-bold text-flame-600 underline"
                >
                  {property.houseOrName} {property.street}
                </Link>
              }
            />
            <Row label="Postcode" value={property.postcode} />
            <Row label="Landlord" value={landlord.name} />
          </dl>
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">
            Gas safety record
          </h2>
          {/*
            Released certificates only, and only this organisation's. A PDF
            that has been uploaded but not yet reviewed does not appear here
            at all — not greyed out, not "pending", not mentioned. Until
            somebody at BSCJ has read it, there is nothing to tell an agency
            about, and a document listed before it is checked is one that
            gets forwarded to a landlord.
          */}
          {certificates.length === 0 ? (
            <p className="mt-2 text-sm text-navy-700">
              No certificate has been issued for this job yet. It appears here
              once the inspection has been carried out and the record checked.
            </p>
          ) : (
            <ul className="mt-2 grid gap-3">
              {certificates.map((cert) => (
                <li
                  key={cert.id}
                  className={`rounded-xl border-2 px-4 py-3 ${
                    cert.status === "issued"
                      ? "border-trust-600 bg-trust-50"
                      : "border-navy-200 bg-white"
                  }`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-extrabold text-navy-900">
                      {cert.certificateNumber}
                      {cert.version > 1 && ` · version ${cert.version}`}
                    </p>
                    <p className="text-xs font-bold uppercase tracking-wide text-navy-600">
                      {cert.status === "issued" ? "Current" : "Superseded"}
                    </p>
                  </div>
                  <dl className="mt-1">
                    <Row label="Inspection date" value={cert.inspectionDate} />
                    <Row label="Next due" value={cert.nextDueDate} />
                    {cert.correctionReason && (
                      <Row label="Correction" value={cert.correctionReason} />
                    )}
                  </dl>
                  {cert.documentId && (
                    <a
                      href={`/api/documents/${cert.documentId}`}
                      target="_blank"
                      rel="noopener"
                      className="mt-2 inline-block rounded-xl bg-flame-500 px-5 py-2.5 text-sm font-extrabold text-navy-900 hover:bg-flame-400"
                    >
                      Open the certificate
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Price</h2>
          <dl className="mt-2">
            <Row label="Total" value={money(job.priceTotalPence)} />
            {/*
              Read from the frozen snapshot, never re-resolved. What this job
              costs is what it cost when it was booked, whatever the price list
              says later.
            */}
            <Row
              label="Rate"
              value={
                priceSnapshot
                  ? priceSnapshot.source === "agreement"
                    ? `${money(priceSnapshot.unitPricePence)} — your account rate`
                    : `${money(priceSnapshot.unitPricePence)} — standard price`
                  : "—"
              }
            />
            {priceSnapshot && priceSnapshot.extraChargePence > 0 && (
              <Row
                label="Extra appliances"
                value={money(priceSnapshot.extraChargePence)}
              />
            )}
            <Row label="Payment" value="After completion" />
          </dl>
        </section>
      </main>
    </>
  );
}
