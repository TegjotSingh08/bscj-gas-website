import type { Metadata } from "next";

/**
 * The admin shell.
 *
 * Its own layout, so nothing from the marketing site — the sticky call bar,
 * the booking CTA, the customer-facing header — appears around an internal
 * tool, and so none of the admin chrome is ever shipped to a public page.
 */
export const metadata: Metadata = {
  title: { default: "BSCJ Admin", template: "%s | BSCJ Admin" },
  // Internal, and must never be indexed or followed.
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="min-h-screen bg-navy-50">{children}</div>;
}
