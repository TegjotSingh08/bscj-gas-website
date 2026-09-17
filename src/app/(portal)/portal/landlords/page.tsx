import type { Metadata } from "next";
import Link from "next/link";

import { requireAgent } from "@/lib/auth/session";
import { listLandlords } from "@/lib/portfolio/queries";
import { PortalNav } from "../PortalNav";
import { NewLandlordForm } from "./LandlordForms";

export const metadata: Metadata = {
  title: "Landlords",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * The agency's landlords.
 *
 * One landlord, many properties. They are listed with a property count so it
 * is obvious at a glance which are portfolios and which are single lets — and
 * so a duplicate, if one ever appeared, would be visible rather than hidden.
 */
export default async function LandlordsPage() {
  const { user, organisationId, organisationName } = await requireAgent();
  const landlords = await listLandlords(organisationId);

  return (
    <>
      <PortalNav
        organisationName={organisationName}
        userName={user.name}
        current="landlords"
      />

      <main className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="text-2xl font-extrabold text-navy-900">Landlords</h1>

        {landlords === null ? (
          <p className="mt-6 rounded-xl bg-navy-50 px-4 py-3 text-sm text-navy-700">
            Landlords are temporarily unavailable.
          </p>
        ) : landlords.length === 0 ? (
          <p className="mt-6 rounded-xl bg-navy-50 px-4 py-3 text-sm text-navy-700">
            No landlords yet. Add one below, or add a property and create the
            landlord as you go.
          </p>
        ) : (
          <ul className="mt-6 divide-y divide-navy-100 rounded-2xl border-2 border-navy-200 bg-white">
            {landlords.map((landlord) => (
              <li key={landlord.id} className="px-4 py-3 hover:bg-navy-50">
                <Link
                  href={`/portal/landlords/${landlord.id}`}
                  className="font-bold text-flame-600 underline"
                >
                  {landlord.name}
                </Link>
                {landlord.company && (
                  <span className="text-sm text-navy-600"> — {landlord.company}</span>
                )}
                <p className="text-xs text-navy-600">
                  {landlord.email} · {landlord.phone} · {landlord.propertyCount}{" "}
                  {landlord.propertyCount === 1 ? "property" : "properties"}
                </p>
              </li>
            ))}
          </ul>
        )}

        <section className="mt-8 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">New landlord</h2>
          <NewLandlordForm />
        </section>
      </main>
    </>
  );
}
