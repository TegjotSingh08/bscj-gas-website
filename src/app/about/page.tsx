import type { Metadata } from "next";
import { TrustRow } from "@/components/TrustRow";
import { CTABand } from "@/components/CTABand";
import { AreasCovered } from "@/components/AreasCovered";
import { availability, business, cp12 } from "@/lib/business";
import { JsonLd, breadcrumbSchema } from "@/lib/schema";

export const metadata: Metadata = {
  title: "About Us — Gas Safe Registered Engineers in Wolverhampton",
  description: `${business.name} is a family-run, Gas Safe registered gas engineering business in Wolverhampton. ${business.yearsExperience} years in the industry.`,
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <>
      <section className="bg-gradient-to-b from-navy-900 to-navy-800 pb-14 pt-12">
        <div className="mx-auto max-w-6xl px-4">
          <h1 className="max-w-3xl text-4xl font-extrabold leading-tight text-white sm:text-5xl">
            A local, family-run gas engineer you can actually get hold of
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-navy-100">
            {business.name} is the trading name of {business.legalName} — a
            family-run business working across Wolverhampton and the towns
            around it.
          </p>
        </div>
      </section>

      <section className="border-b border-navy-100 bg-navy-50 py-8">
        <div className="mx-auto max-w-6xl px-4">
          <TrustRow />
        </div>
      </section>

      <article className="mx-auto max-w-3xl px-4 py-16">
        <h2 className="text-3xl font-extrabold text-navy-900">Who you are dealing with</h2>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          Your gas safety check is carried out by {business.engineerName}, a Gas
          Safe registered engineer with {business.yearsExperience} years in the
          gas industry. You are not being passed to a call centre or a
          subcontractor you have never heard of — you deal with the engineer who
          turns up at your door.
        </p>

        <h2 className="mt-12 text-3xl font-extrabold text-navy-900">
          Gas Safe registered
        </h2>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          By law, anyone working on gas appliances in the UK must be on the Gas
          Safe Register. Our register number is{" "}
          <strong>{business.gasSafeNumber}</strong>, and you are welcome to
          check it yourself at{" "}
          <a
            href="https://www.gassaferegister.co.uk"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-flame-600 underline underline-offset-4"
          >
            gassaferegister.co.uk
          </a>
          . The engineer carries a Gas Safe ID card — ask to see it, and check
          the back to confirm the work being done is covered. We would rather you
          checked.
        </p>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          The business is fully insured.
        </p>

        <h2 className="mt-12 text-3xl font-extrabold text-navy-900">
          How we work
        </h2>
        <ul className="mt-4 space-y-4 text-base leading-relaxed text-navy-800">
          <li>
            <strong>One fixed price.</strong> A CP12 is{" "}
            {cp12.priceDisplay}, covering {cp12.includes}. Extra appliances are{" "}
            {cp12.extraApplianceDisplay} each. That is the whole price list —
            there is no callout fee hiding behind it.
          </li>
          <li>
            <strong>You pay after the work is done.</strong> No deposit, no card
            details to make a booking.
          </li>
          <li>
            <strong>Your certificate, twice.</strong>{" "}
            {cp12.certificateDelivery}.
          </li>
          <li>
            <strong>Straight answers.</strong> If something fails, you get told
            what failed and why, in words that make sense.
          </li>
        </ul>

        <h2 className="mt-12 text-3xl font-extrabold text-navy-900">
          When we work
        </h2>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          {availability.workingDays}, {availability.workingHours}. Evening
          appointments are available within those hours, which suits landlords
          and tenants who cannot take time off during the working day.
        </p>
      </article>

      <section className="bg-navy-50 py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-3xl font-extrabold text-navy-900 sm:text-4xl">
            Areas we cover
          </h2>
          <div className="mt-10">
            <AreasCovered />
          </div>
        </div>
      </section>

      <CTABand heading="Book with a local Gas Safe engineer" />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "About", path: "/about" },
        ])}
      />
    </>
  );
}
