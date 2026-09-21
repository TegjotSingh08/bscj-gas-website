import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { pageOpenGraph } from "@/lib/metadata";
import { TrustRow } from "@/components/TrustRow";
import { AreasCovered } from "@/components/AreasCovered";
import { business, cp12 } from "@/lib/business";
import { agencyPagePublished } from "@/lib/config/publication";
import { JsonLd, breadcrumbSchema } from "@/lib/schema";

/**
 * The page for letting agents and portfolio landlords.
 *
 * **Everything on it describes something that exists.** The portal, the
 * spreadsheet setup call, the tenant scheduling link, the certificate release
 * and the invoice are all built and running; this page is the front door to
 * them, not an advertisement for a roadmap.
 *
 * **It is off unless BSCJ turns it on.** An earlier note claimed the page was
 * "unpublished" because it carried `noindex` and was absent from the sitemap.
 * That was wrong and worth correcting plainly: a route that exists is reachable
 * by anyone who types it the moment it is deployed, whatever robots are asked
 * to do. `noindex` is a request to search engines, not an access control.
 *
 * So publication is a real switch — `BSCJ_AGENCY_PAGE`, absent by default —
 * and the route answers 404 without it. The owner decides when this page goes
 * live by setting one environment variable, and nothing about deploying the
 * code makes that decision for them.
 *
 * What is deliberately absent from the content, because none of it is true or
 * agreed yet:
 *
 * - **No agency pricing.** The tiering mechanism exists and carries no figures.
 *   Quoting one here would invent a commercial term nobody has approved, so the
 *   page says the fixed prices everyone pays and that volume terms are a
 *   conversation.
 * - **No compliance guarantee.** BSCJ carries out and records the work. The
 *   legal duty stays with the landlord, and a page implying otherwise would be
 *   making a promise about somebody else's statutory obligation.
 * - **No customer numbers, no agency names, no reviews.** There is one pilot
 *   agency and nothing has been published about them.
 * - **No claim of automatic reminders or automatic tenant contact.** Renewals
 *   are visible to BSCJ and work is requested deliberately. Saying "we chase it
 *   for you" would describe a product decision nobody has made.
 */

/*
  Read at request time rather than baked in at build. Publishing is then a
  variable on the deployment and a restart, not a rebuild.
*/
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Gas Safety for Letting Agents — Wolverhampton",
  description: `Managed CP12 gas safety certificates for letting agents and portfolio landlords in Wolverhampton. Your properties in one place, tenants book their own appointment, certificates and invoices in one portal.`,
  alternates: { canonical: "/letting-agents" },
  openGraph: pageOpenGraph("/letting-agents"),
  /*
    Belt as well as braces. The gate below is what actually keeps the page
    private; this only asks search engines not to index it once it is on, which
    can be removed when the page is genuinely launched and added to
    `sitemap.ts`.
  */
  robots: { index: false, follow: false },
};


const STEPS = [
  {
    heading: "We read your spreadsheet with you, once",
    body: "Send the export you already produce — whatever headings it happens to have. We go through it with you on one call and record how your columns are read: which is the landlord, what a second name column means, how your addresses and dates are written. You do not reformat anything.",
  },
  {
    heading: "You upload, and see exactly what it will do",
    body: "Every upload afterwards uses that same reading. Before anything is saved you get a row-by-row preview: what is new, what we already hold, what differs from our record, and what we could not read. Nothing is written until you press the second button.",
  },
  {
    heading: "You request the work you want, property by property",
    body: "Nothing is booked because a file was uploaded. You choose the property and the service, and see the price before you commit. No job appears on your account that you did not ask for.",
  },
  {
    heading: "The tenant picks their own appointment",
    body: "We email the tenant a private link and they choose a time that suits them, against our real availability. You are not the switchboard, and neither are we. If there is no tenant, or you would rather arrange access yourself, you can.",
  },
  {
    heading: "The engineer attends and the certificate is reviewed",
    body: `A Gas Safe registered engineer carries out the work — register number ${business.gasSafeNumber}. The certificate is checked by us before it is released, so what reaches you is a document somebody has read rather than a file that finished uploading.`,
  },
  {
    heading: "Certificate, invoice and the next renewal, in one place",
    body: "The released certificate and its invoice sit on the job in your portal, with the property's history beside them. The next due date is recorded from the certificate itself, so the renewal is visible rather than something you have to remember.",
  },
];

export default function LettingAgentsPage() {
  /*
    Not published: not merely unindexed, but **not served**. A 404 is the same
    answer an unknown route gives, so the page's existence is not disclosed
    either.
  */
  if (!agencyPagePublished()) notFound();

  return (
    <>
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Letting agents", path: "/letting-agents" },
        ])}
      />

      <section className="bg-gradient-to-b from-navy-900 to-navy-800 pb-14 pt-12">
        <div className="mx-auto max-w-6xl px-4">
          <p className="text-sm font-bold uppercase tracking-wider text-flame-400">
            For letting agents and portfolio landlords
          </p>
          <h1 className="mt-3 max-w-3xl text-4xl font-extrabold leading-tight text-white sm:text-5xl">
            Your gas safety certificates, managed properly
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-navy-100">
            Send us the spreadsheet you already have. We set it up with you once,
            your tenants book their own appointments, and every certificate,
            invoice and renewal date lives in one place you can actually log in
            to.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a
              href={business.phoneHref}
              data-analytics-id="agents-call"
              className="rounded-xl bg-flame-500 px-8 py-4 text-center text-base font-bold text-white hover:bg-flame-600"
            >
              Call {business.phoneDisplay}
            </a>
            <a
              href={business.whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              data-analytics-id="agents-whatsapp"
              className="rounded-xl border-2 border-white/30 px-8 py-4 text-center text-base font-bold text-white hover:border-white"
            >
              WhatsApp us
            </a>
          </div>
          <p className="mt-4 text-sm text-navy-200">
            Or email{" "}
            <a
              href={`mailto:${business.emailGeneral}`}
              className="font-semibold text-white underline underline-offset-4"
            >
              {business.emailGeneral}
            </a>{" "}
            with the export you use and we will take it from there.
          </p>
        </div>
      </section>

      <section className="border-b border-navy-100 bg-navy-50 py-8">
        <div className="mx-auto max-w-6xl px-4">
          <TrustRow />
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-16">
        <h2 className="text-3xl font-extrabold text-navy-900">
          The bit that usually costs you a morning
        </h2>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          Every system exports differently. Addresses in one cell, two name
          columns nobody labelled, dates that could be March or December. The
          usual answer is that somebody at your end retypes it into whatever
          template the contractor sent.
        </p>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          We do it the other way round.{" "}
          <span className="font-bold">
            We look at your export once, with you, and record how to read it.
          </span>{" "}
          After that you upload the file you already produce, and it is
          understood. When your system changes a heading, that is a five-minute
          conversation, not a new spreadsheet.
        </p>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          Where a row is genuinely unclear — a flat number that could belong to
          two different properties, a landlord we have no email for, two
          landlords with the same name — we stop and ask rather than guess. You
          see exactly which rows and why, and the rest of the file still goes in.
        </p>
      </section>

      <section className="bg-navy-50 py-16">
        <div className="mx-auto max-w-4xl px-4">
          <h2 className="text-3xl font-extrabold text-navy-900">
            How it works, end to end
          </h2>
          <ol className="mt-8 space-y-6">
            {STEPS.map((step, index) => (
              <li
                key={step.heading}
                className="rounded-2xl border-2 border-navy-200 bg-white p-6"
              >
                <div className="flex items-baseline gap-3">
                  <span className="text-sm font-extrabold text-flame-600">
                    {index + 1}
                  </span>
                  <h3 className="text-lg font-extrabold text-navy-900">
                    {step.heading}
                  </h3>
                </div>
                <p className="mt-2 text-base leading-relaxed text-navy-800">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-16">
        <h2 className="text-3xl font-extrabold text-navy-900">What it costs</h2>
        <p className="mt-4 text-base leading-relaxed text-navy-800">
          The same fixed prices everybody pays, with no call-out charge and
          nothing added afterwards:
        </p>
        <ul className="mt-6 grid gap-3 sm:grid-cols-3">
          <li className="rounded-2xl border-2 border-navy-200 bg-white p-5">
            <p className="text-2xl font-extrabold text-navy-900">
              {cp12.priceDisplay}
            </p>
            <p className="mt-1 text-sm font-bold text-navy-900">
              Gas Safety Certificate (CP12)
            </p>
            <p className="mt-1 text-sm text-navy-700">{cp12.includes}.</p>
          </li>
          <li className="rounded-2xl border-2 border-navy-200 bg-white p-5">
            <p className="text-2xl font-extrabold text-navy-900">£60</p>
            <p className="mt-1 text-sm font-bold text-navy-900">
              Annual Boiler Service
            </p>
            <p className="mt-1 text-sm text-navy-700">One boiler, fixed price.</p>
          </li>
          <li className="rounded-2xl border-2 border-navy-200 bg-white p-5">
            <p className="text-2xl font-extrabold text-navy-900">£90</p>
            <p className="mt-1 text-sm font-bold text-navy-900">
              CP12 + Annual Boiler Service
            </p>
            <p className="mt-1 text-sm text-navy-700">Both in one visit.</p>
          </li>
        </ul>
        {/*
          No agency rate is quoted. The tiering mechanism exists and carries no
          figures, and inventing one here would be a commercial term nobody has
          approved.
        */}
        <p className="mt-6 text-base leading-relaxed text-navy-800">
          If you manage a number of properties, talk to us about terms — that is
          a conversation rather than a number on a web page, and we would rather
          agree it with you than publish something that does not fit your
          portfolio.
        </p>
      </section>

      <section className="bg-navy-50 py-16">
        <div className="mx-auto max-w-4xl px-4">
          <h2 className="text-3xl font-extrabold text-navy-900">
            What we are careful about
          </h2>
          <div className="mt-6 space-y-5">
            <div>
              <h3 className="text-lg font-extrabold text-navy-900">
                The legal duty stays yours
              </h3>
              <p className="mt-1 text-base leading-relaxed text-navy-800">
                We carry out the work, record it and keep it visible. The gas
                safety obligation under the regulations belongs to the landlord,
                and nothing we do transfers it. What we can do is make sure you
                are never surprised by a date.
              </p>
            </div>
            <div>
              <h3 className="text-lg font-extrabold text-navy-900">
                Nothing is booked without you asking
              </h3>
              <p className="mt-1 text-base leading-relaxed text-navy-800">
                Uploading a portfolio raises no jobs, contacts no tenants and
                charges nothing. Work happens when you request it, property by
                property.
              </p>
            </div>
            <div>
              <h3 className="text-lg font-extrabold text-navy-900">
                Your tenants hear from us once, about their own appointment
              </h3>
              <p className="mt-1 text-base leading-relaxed text-navy-800">
                A tenant gets a private link to choose a time and a confirmation
                of what they chose. They are not added to a list and they are not
                marketed to.
              </p>
            </div>
            <div>
              <h3 className="text-lg font-extrabold text-navy-900">
                Your data stays yours
              </h3>
              <p className="mt-1 text-base leading-relaxed text-navy-800">
                Your portfolio is visible to your own account only. We do not
                keep the spreadsheet you upload — it is read, shown back to you,
                and not retained.{" "}
                <Link
                  href="/privacy"
                  className="font-semibold text-flame-600 underline underline-offset-4"
                >
                  Our privacy notice
                </Link>{" "}
                sets out the rest.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <AreasCovered />
      </section>

      <section className="bg-navy-900 py-16">
        <div className="mx-auto max-w-3xl px-4 text-center">
          <h2 className="text-3xl font-extrabold text-white sm:text-4xl">
            Send us your export and we will set it up
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-navy-100">
            One call to go through your spreadsheet, and you are running. No
            contract to sign before you see how it works.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <a
              href={business.phoneHref}
              data-analytics-id="agents-cta-call"
              className="rounded-xl bg-flame-500 px-8 py-4 text-base font-bold text-white hover:bg-flame-600"
            >
              Call {business.phoneDisplay}
            </a>
            <a
              href={business.whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              data-analytics-id="agents-cta-whatsapp"
              className="rounded-xl border-2 border-white/30 px-8 py-4 text-base font-bold text-white hover:border-white"
            >
              WhatsApp {business.phoneDisplay}
            </a>
          </div>
          <p className="mt-6 text-sm text-navy-200">
            Already set up?{" "}
            <Link
              href="/portal/login"
              className="font-semibold text-white underline underline-offset-4"
            >
              Sign in to your portal
            </Link>
          </p>
        </div>
      </section>
    </>
  );
}
