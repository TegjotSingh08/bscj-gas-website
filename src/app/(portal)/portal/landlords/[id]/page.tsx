import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAgent } from "@/lib/auth/session";
import { getLandlord } from "@/lib/portfolio/queries";
import { PortalNav } from "../../PortalNav";
import { EditLandlordForm } from "../LandlordForms";

export const metadata: Metadata = {
  title: "Landlord",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

export default async function LandlordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, organisationId, organisationName } = await requireAgent();
  const { id } = await params;

  // Scoped in the query. Another agency's landlord id is simply not found.
  const found = await getLandlord(organisationId, id);
  if (!found) notFound();

  const { landlord, properties } = found;

  return (
    <>
      <PortalNav
        organisationName={organisationName}
        userName={user.name}
        current="landlords"
      />

      <main className="mx-auto max-w-3xl px-4 py-8">
        <Link href="/portal/landlords" className="text-sm font-bold text-flame-600 underline">
          Back to landlords
        </Link>
        <h1 className="mt-2 text-2xl font-extrabold text-navy-900">
          {landlord.name}
        </h1>
        {landlord.company && (
          <p className="text-sm text-navy-600">{landlord.company}</p>
        )}

        <section className="mt-6 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Contact</h2>
          <p className="mt-2 text-sm text-navy-900">{landlord.email}</p>
          <p className="text-sm text-navy-900">{landlord.phone}</p>
          <div className="mt-4">
            <EditLandlordForm landlordId={landlord.id} landlord={landlord} />
          </div>
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">
            Properties ({properties.length})
          </h2>
          {properties.length === 0 ? (
            <p className="mt-2 text-sm text-navy-700">
              No properties yet.{" "}
              <Link href="/portal/portfolio/new" className="font-bold text-flame-600 underline">
                Add one
              </Link>
              .
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-navy-100">
              {properties.map((property) => (
                <li key={property.id} className="py-2 text-sm">
                  <Link
                    href={`/portal/portfolio/${property.id}`}
                    className="font-bold text-flame-600 underline"
                  >
                    {property.houseOrName} {property.street}
                  </Link>
                  <span className="text-navy-600"> · {property.postcode}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
