import type { Metadata } from "next";
import Link from "next/link";

import { business } from "@/lib/business";

/**
 * The tenant scheduling shell.
 *
 * Its own route group and layout, with **no site navigation at all**. A tenant
 * arriving from a link must not be one click from the consumer booking flow,
 * an agency portal or anything else — no marketing pages, no prices, no
 * promotion. The only thing on this surface is the appointment they were asked
 * to choose.
 *
 * **The logo goes to `/schedule` and nowhere else.** It is the one piece of
 * navigation a tenant gets, and the only sensible destination is back to the
 * start of the journey they are on — not the front page of a business trying
 * to sell them something they are not buying.
 *
 * `noindex` on the whole group. A scheduling link is not a search result.
 */
export const metadata: Metadata = {
  title: { default: "Book your appointment", template: "%s | BSCJ" },
  robots: { index: false, follow: false, nocache: true },
};

export default function ScheduleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-navy-50">
      {/*
        A navy bar, matching the header on every email BSCJ sends. A tenant
        arrives here from a link in one of those, and the two looking like the
        same organisation is most of what stops the link feeling like phishing.

        Compact on purpose: this sits above a date picker on a phone, and a
        tall header is a screenful of scrolling before the thing they came to
        do.
      */}
      <header className="bg-navy-900">
        <div className="mx-auto max-w-2xl px-4 py-3">
          <Link
            href="/schedule"
            className="inline-block rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-flame-400"
          >
            <span className="block text-base font-extrabold leading-tight text-white">
              BSCJ <span className="text-flame-400">Gas &amp; Heating</span>
            </span>
            <span className="block text-xs text-navy-200">
              Gas Safe registered engineer
            </span>
          </Link>
        </div>
      </header>
      {children}
      <footer className="mx-auto max-w-2xl px-4 py-8 text-center text-xs text-navy-600">
        Need help? Call or WhatsApp {business.phoneDisplay}.
      </footer>
    </div>
  );
}
