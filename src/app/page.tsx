import Link from "next/link";
import type { Metadata } from "next";
import { TrustRow } from "@/components/TrustRow";
import { PricingCards } from "@/components/PricingCards";
import { FAQ } from "@/components/FAQ";
import { AreasCovered } from "@/components/AreasCovered";
import { CTABand } from "@/components/CTABand";
import {
  availability,
  business,
  cp12,
  sameDayMessaging,
} from "@/lib/business";
import { JsonLd, faqSchema, serviceSchema } from "@/lib/schema";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

const steps = [
  {
    title: "Book your slot",
    body: "Pick a date and time that suits you straight from the engineer's live calendar. It takes under a minute and you get an instant confirmation.",
  },
  {
    title: "We carry out the check",
    body: `Your Gas Safe registered engineer checks your boiler and gas appliances. It usually takes about ${cp12.durationMinutes} minutes.`,
  },
  {
    title: "You get your certificate",
    body: cp12.certificateDelivery + ".",
  },
];

export default function HomePage() {
  return (
    <>
      <section className="bg-gradient-to-b from-navy-900 to-navy-800 pb-14 pt-8 sm:pb-16 sm:pt-16">
        <div className="mx-auto max-w-6xl px-4">
          <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-flame-400">
            Gas Safe Registered
          </p>

          <h1 className="mt-4 max-w-3xl text-[2rem] font-extrabold leading-[1.15] text-white sm:text-5xl lg:text-6xl">
            Gas Safety Certificate Wolverhampton —{" "}
            <span className="text-flame-400">fixed {cp12.priceDisplay}</span>
          </h1>

          <p className="mt-4 max-w-2xl text-base leading-relaxed text-navy-100 sm:text-lg">
            Booked online in about a minute with a local, family-run Gas Safe
            engineer. No account to create, no waiting on a quote, and nothing
            to pay until the work is done.
          </p>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/book"
              data-analytics-id="hero-book"
              className="rounded-xl bg-flame-500 px-8 py-4 text-center text-base font-bold text-white hover:bg-flame-600"
            >
              Book your CP12 — {cp12.priceDisplay}
            </Link>
            <a
              href={business.whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              data-analytics-id="hero-whatsapp"
              className="rounded-xl border-2 border-white/30 px-8 py-4 text-center text-base font-bold text-white hover:border-white"
            >
              WhatsApp the engineer
            </a>
          </div>

          <p className="mt-5 text-sm text-navy-200">
            {cp12.priceTotalDisplay} · {sameDayMessaging.short} ·{" "}
            {availability.workingDays}, {availability.workingHours}
          </p>
        </div>
      </section>

      <section className="border-b border-navy-100 bg-navy-50 py-8">
        <div className="mx-auto max-w-6xl px-4">
          <TrustRow />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-extrabold text-navy-900 sm:text-4xl">
            One fixed price. Nothing added on the day.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-navy-700">
            You should know what a CP12 costs before you book it. Here is
            exactly what {cp12.priceDisplay} gets you.
          </p>
        </div>
        <div className="mt-10">
          <PricingCards />
        </div>
      </section>

      <section className="bg-navy-50 py-16">
        <div className="mx-auto max-w-6xl px-4">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-extrabold text-navy-900 sm:text-4xl">
              How it works
            </h2>
            <p className="mt-4 text-base text-navy-700">
              Three steps, no phone tag, no waiting for a quote.
            </p>
          </div>
          <ol className="mt-10 grid gap-6 md:grid-cols-3">
            {steps.map((step, index) => (
              <li
                key={step.title}
                className="rounded-2xl border border-navy-100 bg-white p-6"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-flame-500 text-lg font-extrabold text-white">
                  {index + 1}
                </span>
                <h3 className="mt-4 text-lg font-bold text-navy-900">
                  {step.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-navy-700">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <h2 className="text-3xl font-extrabold text-navy-900 sm:text-4xl">
              Do you actually need a CP12?
            </h2>
            <p className="mt-4 text-base leading-relaxed text-navy-800">
              If you rent out a property, yes. Landlords have a legal duty under
              the Gas Safety (Installation and Use) Regulations 1998 to have
              every gas appliance and flue they are responsible for checked by a
              Gas Safe registered engineer every 12 months, and to give tenants a
              copy of the record.
            </p>
            <p className="mt-4 text-base leading-relaxed text-navy-800">
              If you own your home, it is not a legal requirement — but plenty of
              homeowners book an annual check anyway, for peace of mind or when
              they are selling.
            </p>
            <Link
              href="/gas-safety-certificate-wolverhampton"
              className="mt-6 inline-block font-bold text-flame-600 underline underline-offset-4 hover:text-flame-500"
            >
              Read more about gas safety certificates in Wolverhampton →
            </Link>
          </div>

          <div className="rounded-2xl border border-navy-100 bg-white p-7 shadow-sm">
            <h3 className="text-lg font-bold text-navy-900">
              What the engineer checks
            </h3>
            <ul className="mt-4 space-y-3 text-sm text-navy-800">
              {[
                "That every gas appliance is safely installed and working correctly",
                "Gas tightness — that there are no leaks on the system",
                "Flues and chimneys, to confirm fumes are being taken safely outside",
                "Ventilation, so appliances get the air they need to burn safely",
                "Safety devices, to confirm they operate as they should",
                "Standing and working gas pressure where it applies",
              ].map((item) => (
                <li key={item} className="flex gap-3">
                  <span aria-hidden="true" className="text-trust-600">✓</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <div className="grid gap-10 lg:grid-cols-2">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-flame-600">
              For landlords and letting agents
            </p>
            <h2 className="mt-3 text-3xl font-extrabold text-navy-900 sm:text-4xl">
              Compliance without the phone tag
            </h2>
            <p className="mt-4 text-base leading-relaxed text-navy-800">
              Most of the hassle in a CP12 is not the inspection — it is
              arranging it. Chasing a quote, then chasing a date, then trying to
              line that date up with a tenant who works.
            </p>
            <p className="mt-4 text-base leading-relaxed text-navy-800">
              You can skip all of that here. The price is already published, the
              calendar shows real slots, and you book the one that suits.
            </p>
            <ul className="mt-6 space-y-3 text-base text-navy-800">
              {[
                "Give us your tenant's name and number at the booking stage and we arrange access directly with them",
                "Tell us about parking or key access up front so the visit is not wasted",
                "Evening slots up to 20:00, so tenants do not need time off work",
                "Digital certificate emailed the same day — forward it straight to your tenant",
                "Managing several properties? Book each one from the same calendar, or call and we will set them up together",
              ].map((item) => (
                <li key={item} className="flex gap-3">
                  <span aria-hidden="true" className="mt-0.5 text-trust-600">✓</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-navy-100 bg-navy-50 p-7">
            <h3 className="text-lg font-bold text-navy-900">
              Your legal duty, in plain terms
            </h3>
            <dl className="mt-5 space-y-5 text-sm">
              <div>
                <dt className="font-bold text-navy-900">How often?</dt>
                <dd className="mt-1 leading-relaxed text-navy-800">
                  Every 12 months, for every gas appliance and flue you are
                  responsible for.
                </dd>
              </div>
              <div>
                <dt className="font-bold text-navy-900">Who can do it?</dt>
                <dd className="mt-1 leading-relaxed text-navy-800">
                  Only a Gas Safe registered engineer — which ours is. You can{" "}
                  <Link
                    href="/about"
                    className="font-semibold text-flame-600 underline underline-offset-4"
                  >
                    check our registration
                  </Link>{" "}
                  before booking.
                </dd>
              </div>
              <div>
                <dt className="font-bold text-navy-900">
                  What do I give the tenant?
                </dt>
                <dd className="mt-1 leading-relaxed text-navy-800">
                  A copy of the record within 28 days of the check, and a copy
                  to any new tenant before they move in.
                </dd>
              </div>
              <div>
                <dt className="font-bold text-navy-900">How long do I keep it?</dt>
                <dd className="mt-1 leading-relaxed text-navy-800">
                  At least two years.
                </dd>
              </div>
            </dl>
            <p className="mt-6 text-xs leading-relaxed text-navy-600">
              Based on the Gas Safety (Installation and Use) Regulations 1998.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-white py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-3xl font-extrabold text-navy-900 sm:text-4xl">
            Why book with us
          </h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {[
              {
                title: "The price is on the page",
                body: `${cp12.priceTotalDisplay}, covering ${cp12.includes}, and ${cp12.extraApplianceDisplay} for anything beyond that. You do not have to ring anyone to find out what a standard CP12 costs.`,
              },
              {
                title: "You book a real slot",
                body: "The calendar is the engineer's actual diary, not an enquiry form. The time you pick is the time that is held for you, confirmed straight away.",
              },
              {
                title: "One engineer, not a call centre",
                body: `The same Gas Safe registered engineer does the work, with ${business.yearsExperience} years in the gas industry behind them. You deal with the person who turns up.`,
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-2xl border border-navy-100 bg-white p-6"
              >
                <h3 className="text-lg font-bold text-navy-900">{item.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-navy-700">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-navy-50 py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-3xl font-extrabold text-navy-900 sm:text-4xl">
            Areas we cover
          </h2>
          <div className="mt-8">
            <AreasCovered />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="text-center text-3xl font-extrabold text-navy-900 sm:text-4xl">
          Common questions
        </h2>
        <div className="mt-10">
          <FAQ />
        </div>
      </section>

      <CTABand />
      <JsonLd data={serviceSchema} />
      <JsonLd data={faqSchema} />
    </>
  );
}
