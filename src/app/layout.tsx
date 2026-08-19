import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { StickyMobileCTA } from "@/components/StickyMobileCTA";
import { business, cp12 } from "@/lib/business";
import { JsonLd, localBusinessSchema } from "@/lib/schema";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(business.url),
  title: {
    default: `Gas Safety Certificate Wolverhampton ${cp12.priceDisplay} | ${business.name}`,
    template: `%s | ${business.name}`,
  },
  description: `Fixed-price ${cp12.priceDisplay} gas safety certificates (CP12) in Wolverhampton from a Gas Safe registered engineer. Book online, pay after completion, digital certificate emailed the same day.`,
  applicationName: business.name,
  authors: [{ name: business.legalName }],
  openGraph: {
    type: "website",
    locale: "en_GB",
    siteName: business.name,
    url: business.url,
    title: `Gas Safety Certificate Wolverhampton ${cp12.priceDisplay} | ${business.name}`,
    description: `Fixed-price ${cp12.priceDisplay} CP12 gas safety certificates in Wolverhampton. Gas Safe registered. Book online in under a minute.`,
  },
  robots: { index: true, follow: true },
  alternates: { canonical: "/" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-GB" className={`${inter.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-navy-900 focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to content
        </a>
        <Header />
        <main id="main" className="flex-1">
          {children}
        </main>
        <Footer />
        <StickyMobileCTA />
        <JsonLd data={localBusinessSchema} />
      </body>
    </html>
  );
}
