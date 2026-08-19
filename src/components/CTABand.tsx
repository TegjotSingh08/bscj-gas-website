import Link from "next/link";
import { business, cp12 } from "@/lib/business";

export function CTABand({
  heading = "Ready to book your gas safety certificate?",
  body,
}: {
  heading?: string;
  body?: string;
}) {
  return (
    <section className="bg-navy-900 py-16">
      <div className="mx-auto max-w-3xl px-4 text-center">
        <h2 className="text-3xl font-extrabold text-white sm:text-4xl">
          {heading}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-navy-100">
          {body ??
            `Fixed ${cp12.priceDisplay} price, ${cp12.payment.toLowerCase()}, and your digital certificate emailed the same day.`}
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href="/book"
            data-analytics-id="ctaband-book"
            className="rounded-xl bg-flame-500 px-8 py-4 text-base font-bold text-white hover:bg-flame-600"
          >
            Book online
          </Link>
          <a
            href={business.phoneHref}
            data-analytics-id="ctaband-call"
            className="rounded-xl border-2 border-white/30 px-8 py-4 text-base font-bold text-white hover:border-white"
          >
            Call {business.phoneDisplay}
          </a>
          <a
            href={business.whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            data-analytics-id="ctaband-whatsapp"
            className="rounded-xl border-2 border-white/30 px-8 py-4 text-base font-bold text-white hover:border-white"
          >
            WhatsApp
          </a>
        </div>
      </div>
    </section>
  );
}
