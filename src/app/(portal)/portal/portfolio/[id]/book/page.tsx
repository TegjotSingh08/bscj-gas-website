import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAgent } from "@/lib/auth/session";
import { getProperty } from "@/lib/portfolio/queries";
import { quoteAgentJob } from "@/lib/jobs/create-agent-job";
import { productList } from "@/lib/booking/products";
import { MAX_APPLIANCES } from "@/lib/booking/pricing";
import { PortalNav } from "../../../PortalNav";
import { BookWorkForm, type Quote } from "./BookWorkForm";

export const metadata: Metadata = {
  title: "Book work",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * Booking work against a property.
 *
 * The property is loaded under the agency's own organisation, so another
 * agency's id is simply not found — the page reveals nothing and the action
 * behind it would refuse independently anyway.
 *
 * Every price on this page is resolved on the server, through the same code
 * that will write the job. The browser is handed figures, never a rate and
 * never the arithmetic.
 */
export default async function BookWorkPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, organisationId, organisationName } = await requireAgent();
  const { id } = await params;

  const found = await getProperty(organisationId, id);
  if (!found) notFound();

  const { property, landlord, current } = found;

  /*
    A quote per service and per appliance count. Pre-computing the small grid
    means the form can show a price the instant a choice changes without a
    round trip, and without a second implementation of the pricing rules.
  */
  const quotes: Quote[] = await Promise.all(
    productList.map(async (product) => {
      const counts = product.appliancePricing
        ? Array.from({ length: MAX_APPLIANCES }, (_, index) => index + 1)
        : [1];

      const byAppliances: Record<number, number> = {};
      for (const count of counts) {
        const quote = await quoteAgentJob(organisationId, product.id, count);
        byAppliances[count] = quote.totalPence;
      }
      // A service with a flat price shows the same figure whatever is chosen.
      if (!product.appliancePricing) {
        for (let count = 1; count <= MAX_APPLIANCES; count += 1) {
          byAppliances[count] = byAppliances[1];
        }
      }

      return {
        productId: product.id,
        name: product.name,
        tagline: product.tagline,
        byAppliances,
        appliancePricing: product.appliancePricing,
        durationMinutes: product.durationMinutes,
      };
    }),
  );

  return (
    <>
      <PortalNav
        organisationName={organisationName}
        userName={user.name}
        current="portfolio"
      />

      <main className="mx-auto max-w-3xl px-4 py-8">
        <Link
          href={`/portal/portfolio/${property.id}`}
          className="text-sm font-bold text-flame-600 underline"
        >
          Back to the property
        </Link>
        <h1 className="mt-2 text-2xl font-extrabold text-navy-900">Book work</h1>

        <div className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
                Property
              </dt>
              <dd className="mt-0.5 text-sm font-bold text-navy-900">
                {property.houseOrName} {property.street}
              </dd>
              <dd className="text-xs text-navy-600">{property.postcode}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
                Landlord
              </dt>
              <dd className="mt-0.5 text-sm text-navy-900">{landlord.name}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
                Tenant
              </dt>
              <dd className="mt-0.5 text-sm text-navy-900">
                {current?.name ?? "None on file"}
              </dd>
              {current?.phone && (
                <dd className="text-xs text-navy-600">{current.phone}</dd>
              )}
            </div>
          </dl>
          {!current?.phone && !current?.email && (
            <p className="mt-3 text-xs text-navy-700">
              No tenant contact on file.{" "}
              <Link
                href={`/portal/portfolio/${property.id}`}
                className="font-bold text-flame-600 underline"
              >
                Add one
              </Link>{" "}
              if you would like the tenant to choose their own appointment.
            </p>
          )}
        </div>

        <BookWorkForm
          propertyId={property.id}
          quotes={quotes}
          tenant={
            current
              ? { name: current.name, phone: current.phone, email: current.email }
              : null
          }
          maxAppliances={MAX_APPLIANCES}
        />
      </main>
    </>
  );
}
