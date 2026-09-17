import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAgent } from "@/lib/auth/session";
import { getProperty } from "@/lib/portfolio/queries";
import { deadlineRisk } from "@/lib/compliance/renewal";
import { productFor } from "@/lib/booking/products";
import { PortalNav } from "../../PortalNav";
import { ComplianceForm, EditPropertyForm, TenancyForm } from "./PropertyForms";

export const metadata: Metadata = {
  title: "Property",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

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
 * One property.
 *
 * Three things are kept visibly apart, because they change independently and
 * on different timescales: **the property**, **who owns it**, and **who lives
 * in it**. Collapsing the tenancy into the property is what makes a system
 * overwrite a tenant and lose last year's contact.
 *
 * The tenancy history is shown in full for the same reason. A closed tenancy
 * is not clutter — it is the answer to "who did we write to last time".
 */
export default async function PropertyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, organisationId, organisationName } = await requireAgent();
  const { id } = await params;

  /*
    "Not yours" and "no such property" are the same answer, decided inside the
    query by the organisation filter. Distinguishing them would turn an id in
    the address bar into a probe for which records exist.
  */
  const found = await getProperty(organisationId, id);
  if (!found) notFound();

  const { property, landlord, tenancies, current, activeCycle, jobs } = found;
  const risk = activeCycle ? deadlineRisk(activeCycle.dueDate, todayIso()) : null;
  const past = tenancies.filter((tenancy) => tenancy.endedOn !== null);

  return (
    <>
      <PortalNav
        organisationName={organisationName}
        userName={user.name}
        current="portfolio"
      />

      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link
          href="/portal/portfolio"
          className="text-sm font-bold text-flame-600 underline"
        >
          Back to portfolio
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-extrabold text-navy-900">
              {property.houseOrName} {property.street}
            </h1>
            <p className="text-sm text-navy-600">
              {[property.town, property.postcode].filter(Boolean).join(", ")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/portal/portfolio/${property.id}/book`}
              className="rounded-xl bg-flame-500 px-5 py-3 text-sm font-bold text-white hover:bg-flame-600"
            >
              Book work
            </Link>
          {activeCycle && (
            <span
              className={
                risk === "overdue"
                  ? "rounded-xl bg-flame-500 px-4 py-2 text-sm font-bold text-white"
                  : risk === "urgent"
                    ? "rounded-xl bg-flame-400/20 px-4 py-2 text-sm font-bold text-flame-700"
                    : "rounded-xl bg-navy-100 px-4 py-2 text-sm font-bold text-navy-800"
              }
            >
              CP12 due {activeCycle.dueDate}
            </span>
          )}
          </div>
        </div>

        <section className="mt-6 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Property</h2>
          <dl className="mt-2">
            <Row label="Address" value={`${property.houseOrName} ${property.street}`} />
            <Row label="Town" value={property.town} />
            <Row label="Postcode" value={property.postcode} />
            <Row label="Access notes" value={property.accessNotes} />
          </dl>
          <div className="mt-4">
            <EditPropertyForm propertyId={property.id} property={property} />
          </div>
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Landlord</h2>
          <dl className="mt-2">
            <Row
              label="Name"
              value={
                <Link
                  href={`/portal/landlords/${landlord.id}`}
                  className="font-bold text-flame-600 underline"
                >
                  {landlord.name}
                </Link>
              }
            />
            <Row label="Company" value={landlord.company} />
            <Row label="Email" value={landlord.email} />
            <Row label="Phone" value={landlord.phone} />
          </dl>
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Current tenancy</h2>

          {current ? (
            <dl className="mt-2">
              <Row label="Name" value={current.name ?? "Not given"} />
              <Row label="Mobile" value={current.phone} />
              <Row label="Email" value={current.email} />
              <Row label="Started" value={current.startedOn} />
              <Row label="Notes" value={current.notes} />
            </dl>
          ) : (
            <p className="mt-2 text-sm text-navy-700">
              No tenant on file. The property may be empty, or the details may
              not have reached you yet — either is fine, but we will need a
              mobile before a tenant can choose their own appointment.
            </p>
          )}

          <div className="mt-4">
            <TenancyForm propertyId={property.id} hasCurrent={Boolean(current)} />
          </div>

          {past.length > 0 && (
            <div className="mt-6 border-t-2 border-navy-100 pt-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-navy-600">
                Previous tenancies
              </h3>
              {/*
                Kept, never overwritten. This is what makes "who did we contact
                last year" answerable after a tenant has moved on.
              */}
              <ul className="mt-2 divide-y divide-navy-100">
                {past.map((tenancy) => (
                  <li key={tenancy.id} className="py-2 text-sm text-navy-700">
                    <span className="font-bold text-navy-900">
                      {tenancy.name ?? "Unnamed tenant"}
                    </span>
                    {tenancy.phone ? ` · ${tenancy.phone}` : ""}
                    <span className="block text-xs text-navy-600">
                      {tenancy.startedOn ?? "start not recorded"} to{" "}
                      {tenancy.endedOn}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Compliance</h2>
          {activeCycle ? (
            <dl className="mt-2">
              <Row label="CP12 expires" value={activeCycle.dueDate} />
              <Row label="Last inspected" value={activeCycle.inspectionDate} />
              <Row
                label="Source"
                value={
                  activeCycle.dueDateSource === "manual"
                    ? "Entered by your agency"
                    : "Derived from a completed inspection"
                }
              />
            </dl>
          ) : (
            <p className="mt-2 text-sm text-navy-700">
              No certificate date on file. We will not guess one — add it and we
              will tell you when the renewal is coming.
            </p>
          )}
          <div className="mt-4">
            <ComplianceForm
              propertyId={property.id}
              dueDate={activeCycle?.dueDate ?? null}
            />
          </div>
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Jobs</h2>
          {jobs.length === 0 ? (
            <p className="mt-2 text-sm text-navy-700">
              No work booked for this property yet.{" "}
              <Link
                href={`/portal/portfolio/${property.id}/book`}
                className="font-bold text-flame-600 underline"
              >
                Book work
              </Link>
              .
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-navy-100">
              {jobs.map((job) => (
                <li key={job.id} className="py-2 text-sm">
                  <Link
                    href={`/portal/jobs/${job.id}`}
                    className="font-bold text-flame-600 underline"
                  >
                    {job.reference}
                  </Link>
                  <span className="text-navy-700">
                    {" "}
                    · {productFor(job.productId).subjectName} ·{" "}
                    {job.lifecycleStatus.replace(/_/g, " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
