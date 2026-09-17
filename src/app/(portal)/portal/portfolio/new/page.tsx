import type { Metadata } from "next";
import Link from "next/link";

import { requireAgent } from "@/lib/auth/session";
import { listLandlords } from "@/lib/portfolio/queries";
import { PortalNav } from "../../PortalNav";
import { AddPropertyForm } from "./AddPropertyForm";

export const metadata: Metadata = {
  title: "Add property",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

export default async function AddPropertyPage() {
  const { user, organisationId, organisationName } = await requireAgent();
  // Scoped: the picker can only ever offer this agency's own landlords.
  const landlords = (await listLandlords(organisationId)) ?? [];

  return (
    <>
      <PortalNav
        organisationName={organisationName}
        userName={user.name}
        current="portfolio"
      />

      <main className="mx-auto max-w-3xl px-4 py-8">
        <Link
          href="/portal/portfolio"
          className="text-sm font-bold text-flame-600 underline"
        >
          Back to portfolio
        </Link>
        <h1 className="mt-2 text-2xl font-extrabold text-navy-900">
          Add a property
        </h1>
        <p className="mt-1 text-sm text-navy-600">
          The postcode fills in the rest. Only the landlord and the address are
          required — add the tenant and the certificate date if you have them.
        </p>

        <AddPropertyForm
          landlords={landlords.map((landlord) => ({
            id: landlord.id,
            name: landlord.name,
            company: landlord.company,
          }))}
        />
      </main>
    </>
  );
}
