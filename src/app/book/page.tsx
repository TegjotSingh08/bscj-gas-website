import type { Metadata } from "next";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { TrustRow } from "@/components/TrustRow";
import { availability, business, cp12 } from "@/lib/business";
import { JsonLd, breadcrumbSchema, serviceSchema } from "@/lib/schema";

export const metadata: Metadata = {
  title: "Book a Gas Safety Certificate Online",
  description: `Book your ${cp12.priceDisplay} CP12 gas safety certificate in Wolverhampton. Pick a slot from the engineer's live calendar — confirmed instantly, ${cp12.payment.toLowerCase()}.`,
  alternates: { canonical: "/book" },
};

export default function BookPage() {
  return (
    <>
      <section className="bg-gradient-to-b from-navy-900 to-navy-800 pb-12 pt-12">
        <div className="mx-auto max-w-6xl px-4">
          <h1 className="text-4xl font-extrabold text-white sm:text-5xl">
            Book your gas safety certificate
          </h1>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-navy-100">
            {cp12.priceTotalDisplay} · {cp12.payment}. Choose an available
            appointment below and it goes straight into the engineer&rsquo;s
            diary — confirmed on the spot, with nothing to pay now.
          </p>
        </div>
      </section>

      <section className="border-b border-navy-100 bg-navy-50 py-8">
        <div className="mx-auto max-w-6xl px-4">
          <TrustRow />
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-12">
        <BookingFlow />
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-16">
        <div className="grid gap-6 md:grid-cols-3">
          <div className="rounded-2xl border border-navy-100 bg-white p-6">
            <h2 className="text-lg font-bold text-navy-900">
              Before you book
            </h2>
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-navy-800">
              <li>
                Count your gas appliances. {cp12.priceDisplay} covers{" "}
                {cp12.includes}; each extra one is{" "}
                {cp12.extraApplianceDisplay}.
              </li>
              <li>
                If a tenant will be letting us in, have their name and number
                ready.
              </li>
              <li>
                Tell us about parking or access issues so we arrive prepared.
              </li>
            </ul>
          </div>

          <div className="rounded-2xl border border-navy-100 bg-white p-6">
            <h2 className="text-lg font-bold text-navy-900">
              Changing your booking
            </h2>
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-navy-800">
              <li>
                Reschedule free of charge more than{" "}
                {availability.rescheduleNoticeHours} hours before your slot.
              </li>
              <li>
                Cancellations need at least{" "}
                {availability.cancellationNoticeHours} hours&rsquo; notice.
              </li>
              <li>
                You can book up to {availability.maximumAdvanceDays} days ahead.
              </li>
            </ul>
          </div>

          <div className="rounded-2xl border border-navy-100 bg-white p-6">
            <h2 className="text-lg font-bold text-navy-900">
              Rather not book online?
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-navy-800">
              No problem — call or message and we will sort it out for you.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <a
                href={business.phoneHref}
                data-analytics-id="bookpage-call"
                className="rounded-lg bg-navy-800 px-4 py-3 text-center text-sm font-bold text-white hover:bg-navy-900"
              >
                Call {business.phoneDisplay}
              </a>
              <a
                href={business.whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                data-analytics-id="bookpage-whatsapp"
                className="rounded-lg border-2 border-trust-600 px-4 py-3 text-center text-sm font-bold text-trust-600"
              >
                WhatsApp us
              </a>
            </div>
          </div>
        </div>
      </section>

      <JsonLd data={serviceSchema} />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Book", path: "/book" },
        ])}
      />
    </>
  );
}
