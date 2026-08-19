"use client";

import { business, calendarDirectUrl } from "@/lib/business";

/**
 * Shown when live availability cannot be loaded — a Google outage, a
 * misconfiguration, or the integration not being set up yet. The customer is
 * never left at a dead end.
 */
export function BookingFallback({ onRetry }: { onRetry: () => void }) {
  return (
    <section
      aria-labelledby="booking-unavailable"
      className="rounded-2xl border-2 border-flame-500 bg-white p-6 sm:p-8"
    >
      <h2
        id="booking-unavailable"
        className="text-xl font-extrabold text-navy-900"
      >
        We&rsquo;re having trouble loading live availability
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-navy-800">
        Our online diary is not responding at the moment. You can still book —
        use any of these and we will get you in.
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <a
          href={calendarDirectUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-analytics-id="fallback-alternative-booking"
          className="rounded-xl bg-flame-500 px-5 py-4 text-center text-sm font-bold text-white hover:bg-flame-600"
        >
          Open alternative booking page
        </a>
        <a
          href={business.phoneHref}
          data-analytics-id="fallback-call"
          className="rounded-xl bg-navy-800 px-5 py-4 text-center text-sm font-bold text-white hover:bg-navy-900"
        >
          Call {business.phoneDisplay}
        </a>
        <a
          href={business.whatsappHref}
          target="_blank"
          rel="noopener noreferrer"
          data-analytics-id="fallback-whatsapp"
          className="rounded-xl border-2 border-trust-600 px-5 py-4 text-center text-sm font-bold text-trust-600"
        >
          WhatsApp us
        </a>
      </div>

      <button
        type="button"
        onClick={onRetry}
        className="mt-5 text-sm font-bold text-navy-700 underline underline-offset-4 hover:text-flame-600"
      >
        Try loading availability again
      </button>
    </section>
  );
}
