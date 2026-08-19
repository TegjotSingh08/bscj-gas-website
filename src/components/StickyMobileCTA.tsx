import Link from "next/link";
import { business } from "@/lib/business";

/**
 * Always-visible action bar on mobile. Booking, calling and WhatsApp are the
 * three things a visitor is here to do, so none of them are ever more than one
 * tap away. Hidden on desktop where the header CTA is already in view.
 */
export function StickyMobileCTA() {
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-3 border-t border-navy-200 bg-white shadow-[0_-4px_16px_rgba(11,27,48,0.10)] md:hidden">
      <a
        href={business.phoneHref}
        data-analytics-id="sticky-call"
        className="flex flex-col items-center gap-0.5 py-3 text-xs font-bold text-navy-800"
      >
        <span aria-hidden="true" className="text-lg leading-none">📞</span>
        Call
      </a>
      <a
        href={business.whatsappHref}
        target="_blank"
        rel="noopener noreferrer"
        data-analytics-id="sticky-whatsapp"
        className="flex flex-col items-center gap-0.5 border-x border-navy-100 py-3 text-xs font-bold text-trust-600"
      >
        <span aria-hidden="true" className="text-lg leading-none">💬</span>
        WhatsApp
      </a>
      <Link
        href="/book"
        data-analytics-id="sticky-book"
        className="flex flex-col items-center gap-0.5 bg-flame-500 py-3 text-xs font-bold text-white"
      >
        <span aria-hidden="true" className="text-lg leading-none">📅</span>
        Book
      </Link>
    </div>
  );
}
