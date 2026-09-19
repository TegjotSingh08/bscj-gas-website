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
      <header className="border-b-2 border-navy-200 bg-white">
        <div className="mx-auto max-w-2xl px-4 py-4">
          <Link
            href="/schedule"
            className="inline-block rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-flame-500"
          >
            <span className="block text-lg font-extrabold text-navy-900">
              BSCJ <span className="text-flame-600">Gas &amp; Heating</span>
            </span>
            <span className="block text-xs text-navy-600">
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
