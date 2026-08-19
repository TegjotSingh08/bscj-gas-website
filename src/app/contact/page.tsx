import Link from "next/link";
import type { Metadata } from "next";
import { AreasCovered } from "@/components/AreasCovered";
import { availability, business, sameDayMessaging } from "@/lib/business";
import { JsonLd, breadcrumbSchema } from "@/lib/schema";

export const metadata: Metadata = {
  title: "Contact Us",
  description: `Call, WhatsApp or email ${business.name} in Wolverhampton. Phone ${business.phoneDisplay}. ${availability.workingDays}, ${availability.workingHours}.`,
  alternates: { canonical: "/contact" },
};

const methods = [
  {
    label: "Call us",
    value: business.phoneDisplay,
    href: business.phoneHref,
    note: "Quickest way to get an answer, including for urgent jobs.",
    external: false,
  },
  {
    label: "WhatsApp",
    value: business.phoneDisplay,
    href: business.whatsappHref,
    note: "Send a message, a photo of your boiler, or your address.",
    external: true,
  },
  {
    label: "General enquiries",
    value: business.emailGeneral,
    href: `mailto:${business.emailGeneral}`,
    note: "Questions about pricing, appliances or areas covered.",
    external: false,
  },
  {
    label: "Bookings",
    value: business.emailBooking,
    href: `mailto:${business.emailBooking}`,
    note: "Existing bookings, rescheduling and certificates.",
    external: false,
  },
];

export default function ContactPage() {
  return (
    <>
      <section className="bg-gradient-to-b from-navy-900 to-navy-800 pb-14 pt-12">
        <div className="mx-auto max-w-6xl px-4">
          <h1 className="text-4xl font-extrabold text-white sm:text-5xl">
            Contact us
          </h1>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-navy-100">
            You will get through to the people who do the work. {sameDayMessaging.short}.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <div className="grid gap-6 sm:grid-cols-2">
          {methods.map((method) => (
            <a
              key={method.label}
              href={method.href}
              {...(method.external
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {})}
              className="rounded-2xl border border-navy-100 bg-white p-6 shadow-sm transition hover:border-flame-500 hover:shadow-md"
            >
              <p className="text-xs font-bold uppercase tracking-wider text-flame-600">
                {method.label}
              </p>
              <p className="mt-2 text-xl font-extrabold text-navy-900">
                {method.value}
              </p>
              <p className="mt-2 text-sm text-navy-700">{method.note}</p>
            </a>
          ))}
        </div>

        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <div className="rounded-2xl border border-navy-100 bg-navy-50 p-6">
            <h2 className="text-lg font-bold text-navy-900">Opening hours</h2>
            <p className="mt-3 text-base text-navy-800">
              {availability.workingDays}
              <br />
              {availability.workingHours}
            </p>
            <p className="mt-3 text-sm text-navy-700">
              Closed Saturdays. If you message outside these hours we will come
              back to you when we open.
            </p>
          </div>

          <div className="rounded-2xl border border-navy-100 bg-navy-50 p-6">
            <h2 className="text-lg font-bold text-navy-900">
              Want to book instead?
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-navy-800">
              You can see live availability and confirm a slot yourself without
              waiting for a reply.
            </p>
            <Link
              href="/book"
              className="mt-4 inline-block rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600"
            >
              Book online
            </Link>
          </div>
        </div>

        <div className="mt-14">
          <h2 className="text-center text-3xl font-extrabold text-navy-900">
            Areas we cover
          </h2>
          <div className="mt-8">
            <AreasCovered />
          </div>
        </div>

        <p className="mt-14 text-center text-sm text-navy-600">
          {business.name} is a trading name of {business.legalName}. Gas Safe
          Register No. {business.gasSafeNumber}.
        </p>
      </section>

      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Contact", path: "/contact" },
        ])}
      />
    </>
  );
}
