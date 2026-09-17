import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAgent } from "@/lib/auth/session";
import { getAgencyJob } from "@/lib/jobs/portal-queries";
import { productFor } from "@/lib/booking/products";
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

  const { job, property, landlord, priceSnapshot, invitation } = found;
  const product = productFor(job.productId);

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
