import type { Metadata } from "next";

import { business } from "@/lib/business";

/**
 * The account-setup shell.
 *
 * Its own route group and layout, with **no navigation at all** — not even a
 * link home. Somebody arriving here has one thing to do, and the surface is
 * reachable only by a link that was emailed to them. A menu would be an
 * invitation to wander into the portal they cannot sign into yet.
 *
 * `noindex` on the whole group. An invitation is not a search result, and the
 * pages under it say nothing worth indexing anyway.
 */
export const metadata: Metadata = {
  title: { default: "Your account", template: "%s | BSCJ" },
  robots: { index: false, follow: false, nocache: true },
};

export default function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-navy-50">
      <header className="border-b-2 border-navy-200 bg-white">
        <div className="mx-auto max-w-md px-4 py-4">
          <span className="block text-lg font-extrabold text-navy-900">
            BSCJ <span className="text-flame-600">Gas &amp; Heating</span>
          </span>
          <span className="block text-xs text-navy-600">
            Gas Safe registered engineer
          </span>
        </div>
      </header>
      {children}
      <footer className="mx-auto max-w-md px-4 py-8 text-center text-xs text-navy-600">
        Need help? Call or WhatsApp {business.phoneDisplay}.
      </footer>
    </div>
  );
}
