"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { business } from "@/lib/business";

/**
 * Always-visible action bar on mobile. Booking, calling and WhatsApp are the
 * three things a visitor is here to do, so none of them are ever more than one
 * tap away. Hidden on desktop where the header CTA is already in view.
 *
 * Icons are inline SVG rather than emoji: emoji render differently on every
 * platform — on this machine 📞 came out as a two-glyph mess and 📅 as a dated
 * "17" tile — and they cannot be recoloured to match the label beneath them.
 * Three small paths cost nothing; an icon library for three icons would.
 *
 * Bottom padding respects the iPhone home-indicator inset. The matching
 * reserve on `body` lives in globals.css, so the bar can never sit over a
 * field, an error, a checkbox or the confirm button.
 */

function CallIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="currentColor"
    >
      <path d="M6.6 10.8a15.5 15.5 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1z" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="currentColor"
    >
      <path d="M12 2a10 10 0 0 0-8.6 15.05L2 22l5.1-1.33A10 10 0 1 0 12 2m0 1.8a8.2 8.2 0 1 1-4.2 15.24l-.3-.18-3 .78.8-2.92-.2-.31A8.2 8.2 0 0 1 12 3.8m-3.4 4c-.16 0-.42.06-.64.3-.22.24-.85.83-.85 2.02s.87 2.34.99 2.5c.12.16 1.7 2.72 4.19 3.7 2.07.82 2.49.66 2.94.62.45-.04 1.45-.59 1.66-1.17.2-.57.2-1.06.14-1.16-.06-.1-.22-.16-.46-.28-.24-.12-1.45-.72-1.67-.8-.22-.08-.39-.12-.55.12-.16.24-.63.8-.77.96-.14.16-.28.18-.52.06-.24-.12-1.03-.38-1.96-1.21-.72-.65-1.21-1.45-1.35-1.69-.14-.24-.02-.37.1-.49.11-.11.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.54-1.33-.75-1.81-.19-.45-.39-.39-.53-.4z" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

export function StickyMobileCTA() {
  const pathname = usePathname();
  const onBookingPage = pathname === "/book";

  const cell =
    "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-bold leading-none";

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-navy-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(11,27,48,0.10)] md:hidden">
      <div className="grid grid-cols-3">
        <a
          href={business.phoneHref}
          data-analytics-id="sticky-call"
          aria-label={`Call ${business.phoneDisplay}`}
          className={`${cell} text-navy-800`}
        >
          <CallIcon />
          Call
        </a>
        <a
          href={business.whatsappHref}
          target="_blank"
          rel="noopener noreferrer"
          data-analytics-id="sticky-whatsapp"
          aria-label="Message BSCJ Gas & Heating on WhatsApp"
          className={`${cell} border-x border-navy-100 text-trust-600`}
        >
          <WhatsAppIcon />
          WhatsApp
        </a>
        <Link
          href="/book"
          data-analytics-id="sticky-book"
          aria-label="Book a gas safety certificate online"
          aria-current={onBookingPage ? "page" : undefined}
          className={`${cell} ${
            onBookingPage
              ? "bg-flame-600 text-white"
              : "bg-flame-500 text-white hover:bg-flame-600"
          }`}
        >
          <CalendarIcon />
          Book
        </Link>
      </div>
    </div>
  );
}
