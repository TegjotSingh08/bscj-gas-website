import type { Metadata } from "next";

/**
 * The agency portal shell.
 *
 * Its own route group and its own layout, for the same reason `/admin` has
 * one: nothing from the marketing site — the sticky call bar, the customer
 * header, the business JSON-LD — belongs around an agency's account, and none
 * of the portal's chrome should ever ship to a public page.
 *
 * `noindex` on the whole surface. An agency's portfolio is not a search result.
 */
export const metadata: Metadata = {
  title: { default: "BSCJ Portal", template: "%s | BSCJ Portal" },
  robots: { index: false, follow: false, nocache: true },
};

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="min-h-screen bg-navy-50">{children}</div>;
}
