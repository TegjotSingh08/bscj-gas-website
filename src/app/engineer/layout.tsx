import type { Metadata } from "next";

/**
 * The engineer's shell.
 *
 * Its own route group and its own layout, for the same reason `/admin` and
 * `/portal` have one: nothing from the marketing site — the sticky call bar,
 * the customer header, the business JSON-LD — belongs around a tool somebody
 * is holding in a van, and none of it should ship to a public page either.
 *
 * `noindex` on the whole surface. These pages carry an address, an access
 * note and a tenant's phone number.
 */
export const metadata: Metadata = {
  title: { default: "BSCJ Engineer", template: "%s | BSCJ Engineer" },
  robots: { index: false, follow: false, nocache: true },
};

export default function EngineerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="min-h-screen bg-navy-50">{children}</div>;
}
