import Link from "next/link";
import type { Metadata } from "next";
import { TrustRow } from "@/components/TrustRow";
import { PricingCards } from "@/components/PricingCards";
import { FAQ } from "@/components/FAQ";
import { AreasCovered } from "@/components/AreasCovered";
import { CTABand } from "@/components/CTABand";
import { business, cp12, sameDayMessaging } from "@/lib/business";
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
    title: `Gas Safety Certificate Wolverhampton ${cp12.priceDisplay} | CP12`,
    description: `Fixed-price CP12 gas safety certificates in Wolverhampton, Bilston, Wednesfield and Willenhall. Gas Safe registered.`,
    url: "/gas-safety-certificate-wolverhampton",
  },
};

export default function GasSafetyCertificateWolverhamptonPage() {
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
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-navy-100">
            A fixed {cp12.priceDisplay} covering {cp12.includes}, carried out by
            a Gas Safe registered engineer based in Wolverhampton. Book a slot
            online and pay once the work is done.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/book"
              data-analytics-id="cp12hero-book"
              className="rounded-xl bg-flame-500 px-8 py-4 text-center text-base font-bold text-white hover:bg-flame-600"
            >
              Check available dates
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
          If something fails
        </h2>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          You will be told exactly what the problem is and why it failed, in
          plain terms. If an appliance is unsafe it will be turned off with your
          permission, and you will be told what needs putting right. Nobody
          leaves you with a failed certificate and no explanation.
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
