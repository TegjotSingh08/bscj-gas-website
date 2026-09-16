import Link from "next/link";
import type { Metadata } from "next";
import { pageOpenGraph } from "@/lib/metadata";
import { TrustRow } from "@/components/TrustRow";
import { PricingCards } from "@/components/PricingCards";
import { bundleSavingFor, products } from "@/lib/booking/products";
import { FAQ } from "@/components/FAQ";
import { AreasCovered } from "@/components/AreasCovered";
import { CTABand } from "@/components/CTABand";
import {
  business,
  cp12,
  inspectionScope,
  sameDayMessaging,
} from "@/lib/business";
import {
  JsonLd,
  breadcrumbSchema,
  faqSchema,
  serviceSchema,
} from "@/lib/schema";

export const metadata: Metadata = {
  title: `Gas Safety Certificate Wolverhampton ${cp12.priceDisplay} | CP12 Landlord Certificate`,
  description: `Fixed-price ${cp12.priceDisplay} gas safety certificate (CP12) in Wolverhampton. Gas Safe registered engineer, ${cp12.payment.toLowerCase()}, digital certificate emailed the same day. Book online.`,
  alternates: { canonical: "/gas-safety-certificate-wolverhampton" },
  openGraph: {
    ...pageOpenGraph("/gas-safety-certificate-wolverhampton"),
    title: `Gas Safety Certificate Wolverhampton ${cp12.priceDisplay} | CP12`,
    description: `Fixed-price CP12 gas safety certificates in Wolverhampton and the surrounding areas within our standard service area. Gas Safe registered.`,
  },
};

export default function GasSafetyCertificateWolverhamptonPage() {
  const service = products["boiler-service"];
  const bundle = products["cp12-boiler-service"];
  const saving = bundleSavingFor(bundle.id);

  return (
    <>
      <section className="bg-gradient-to-b from-navy-900 to-navy-800 pb-14 pt-12">
        <div className="mx-auto max-w-6xl px-4">
          <nav aria-label="Breadcrumb" className="text-xs text-navy-200">
            <Link href="/" className="hover:text-flame-400">Home</Link>
            <span className="px-2" aria-hidden="true">/</span>
            <span className="text-white">Gas Safety Certificate Wolverhampton</span>
          </nav>

          <h1 className="mt-5 max-w-3xl text-4xl font-extrabold leading-tight text-white sm:text-5xl">
            Gas Safety Certificate (CP12) in Wolverhampton
          </h1>
          {/*
            The price ahead of the prose, and at a size that matches how much
            it matters. This is the page Google sends CP12 searches to, so the
            figure should land before anything has to be read.
          */}
          <p className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-6xl font-extrabold leading-none tracking-tight text-flame-400 sm:text-7xl">
              {cp12.priceDisplay}
            </span>
            <span className="text-base font-bold text-white sm:text-lg">
              total &middot; up to 3 appliances
            </span>
          </p>

          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-navy-100">
            Covering {cp12.includes}, carried out by a Gas Safe registered
            engineer based in Wolverhampton. Extra appliances are{" "}
            {cp12.extraApplianceDisplay} each. Book a slot online and pay once
            the work is done.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/book"
              data-analytics-id="cp12hero-book"
              className="rounded-xl bg-flame-500 px-8 py-4 text-center text-base font-bold text-white hover:bg-flame-600"
            >
              Book your CP12 — {cp12.priceDisplay}
            </Link>
            <a
              href={business.phoneHref}
              data-analytics-id="cp12hero-call"
              className="rounded-xl border-2 border-white/30 px-8 py-4 text-center text-base font-bold text-white hover:border-white"
            >
              Call {business.phoneDisplay}
            </a>
          </div>
        </div>
      </section>

      <section className="border-b border-navy-100 bg-navy-50 py-8">
        <div className="mx-auto max-w-6xl px-4">
          <TrustRow />
        </div>
      </section>

      <article className="mx-auto max-w-3xl px-4 py-16">
        <h2 className="text-3xl font-extrabold text-navy-900">
          What a CP12 actually is
        </h2>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          CP12 is the name almost everyone uses for the Landlord Gas Safety
          Record. It is the document a Gas Safe registered engineer issues after
          inspecting the gas appliances, pipework and flues at a property. It
          lists every appliance that was checked and records whether each one
          passed as safe to use.
        </p>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          The name is a hangover from an old CORGI form number. There is no
          difference between a &ldquo;CP12&rdquo;, a &ldquo;gas safety
          certificate&rdquo; and a &ldquo;landlord gas safety record&rdquo; —
          they are three names for the same document.
        </p>

        <h2 className="mt-12 text-3xl font-extrabold text-navy-900">
          Who needs one in Wolverhampton
        </h2>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          <strong>Landlords must have one.</strong> The Gas Safety (Installation
          and Use) Regulations 1998 require every gas appliance and flue a
          landlord is responsible for to be checked by a Gas Safe registered
          engineer every 12 months. You must give your tenant a copy of the
          record within 28 days of the check, and give a copy to any new tenant
          before they move in.
        </p>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          <strong>Letting agents</strong> arranging compliance on a landlord&rsquo;s
          behalf need the same certificate for each managed property.
        </p>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          <strong>Homeowners</strong> are not legally required to have a gas
          safety check. Many still book one each year for peace of mind, or when
          they are selling and a buyer asks for proof the boiler and appliances
          are safe.
        </p>

        <h2 className="mt-12 text-3xl font-extrabold text-navy-900">
          What gets checked
        </h2>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          The engineer works through each gas appliance in turn, checking that
          it is safely installed and operating correctly, that there are no gas
          leaks on the system, that flues are carrying fumes safely outside,
          that there is enough ventilation for appliances to burn safely, and
          that safety devices do what they are meant to do.
        </p>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          A typical visit takes around {cp12.durationMinutes} minutes. The
          engineer needs access to the boiler, the gas meter and every gas
          appliance being tested, so it helps to clear the way to them before we
          arrive.
        </p>

        <h2 className="mt-12 text-3xl font-extrabold text-navy-900">
          If the inspection finds a problem
        </h2>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          You will be told exactly what the problem is and why, in plain terms.
          If an appliance is unsafe it will be turned off with your permission,
          and you will be told what needs putting right. Nobody leaves you with a
          failed record and no explanation.
        </p>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          <strong>{inspectionScope.chargeAppliesRegardless}</strong>
        </p>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          {inspectionScope.repairsExcluded} {inspectionScope.remedialOffer}{" "}
          {inspectionScope.separateInvoice}
        </p>
        <p className="mt-4 rounded-xl bg-navy-50 px-5 py-4 text-base leading-relaxed text-navy-800">
          {inspectionScope.noObligation}
        </p>

        <h2 className="mt-12 text-3xl font-extrabold text-navy-900">
          CP12 or boiler service?
        </h2>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          These get mixed up constantly, and some companies are happy to let the
          confusion sell a bigger job. They are not the same thing.
        </p>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b-2 border-navy-200 text-navy-600">
                <th scope="col" className="py-3 font-semibold">&nbsp;</th>
                <th scope="col" className="py-3 font-semibold">Gas safety check (CP12)</th>
                <th scope="col" className="py-3 font-semibold">Boiler service</th>
              </tr>
            </thead>
            <tbody className="text-navy-800">
              <tr className="border-b border-navy-100">
                <th scope="row" className="py-3 pr-4 font-semibold text-navy-900">Purpose</th>
                <td className="py-3 pr-4">Confirms appliances are safe to use</td>
                <td className="py-3">Keeps the boiler running efficiently</td>
              </tr>
              <tr className="border-b border-navy-100">
                <th scope="row" className="py-3 pr-4 font-semibold text-navy-900">Legally required?</th>
                <td className="py-3 pr-4">Yes, for landlords, every 12 months</td>
                <td className="py-3">No</td>
              </tr>
              <tr className="border-b border-navy-100">
                <th scope="row" className="py-3 pr-4 font-semibold text-navy-900">Produces a certificate?</th>
                <td className="py-3 pr-4">Yes — the CP12 record</td>
                <td className="py-3">A service record, not a CP12</td>
              </tr>
              <tr>
                <th scope="row" className="py-3 pr-4 font-semibold text-navy-900">Covers all gas appliances?</th>
                <td className="py-3 pr-4">Yes</td>
                <td className="py-3">Usually the boiler only</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-6 text-base leading-relaxed text-navy-800">
          If you are a landlord and you only need to meet your legal duty, the
          CP12 is the job you are looking for.
        </p>
        {/*
          The honest end of a section about not being sold the bigger job: we
          do offer both, the price is stated here rather than discovered later,
          and the CP12 on its own is still presented as the complete answer to
          the legal duty.
        */}
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          We book them separately or together. An {service.name} on its own is{" "}
          <strong>{service.priceTotalDisplay}</strong>. Both in the same visit
          is <strong>{bundle.priceTotalDisplay}</strong>
          {saving
            ? ` — ${saving.separateTotalDisplay} separately, so you save ${saving.savingDisplay}`
            : ""}
          . One appointment, your gas safety check completed and your boiler
          serviced for the year ahead.{" "}
          <Link
            href="/book"
            data-analytics-id="cp12compare-book-bundle"
            className="font-bold text-flame-600 underline underline-offset-4"
          >
            Book CP12 + Service — {bundle.priceDisplay}
          </Link>
        </p>

        <h2 className="mt-12 text-3xl font-extrabold text-navy-900">
          Booking and availability
        </h2>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          {sameDayMessaging.long}
        </p>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          If your tenant will be letting the engineer in rather than you, add
          their contact details when you book so we can arrange the visit
          directly with them.
        </p>
      </article>

      <section className="bg-navy-50 py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-3xl font-extrabold text-navy-900 sm:text-4xl">
            Wolverhampton CP12 pricing
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-base leading-relaxed text-navy-700">
            A certificate, a boiler service, or both in the same visit. All
            three are fixed totals, and all three are payable after the work is
            done.
          </p>
          <div className="mt-10">
            <PricingCards />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="text-center text-3xl font-extrabold text-navy-900 sm:text-4xl">
          Where we work
        </h2>
        <div className="mt-10">
          <AreasCovered />
        </div>
      </section>

      <section className="bg-navy-50 py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-3xl font-extrabold text-navy-900 sm:text-4xl">
            Gas safety certificate FAQs
          </h2>
          <div className="mt-10">
            <FAQ />
          </div>
        </div>
      </section>

      <CTABand heading="Book your Wolverhampton CP12" />

      <JsonLd data={serviceSchema} />
      <JsonLd data={faqSchema} />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          {
            name: "Gas Safety Certificate Wolverhampton",
            path: "/gas-safety-certificate-wolverhampton",
          },
        ])}
      />
    </>
  );
}
