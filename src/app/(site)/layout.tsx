import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { StickyMobileCTA } from "@/components/StickyMobileCTA";
import { JsonLd, localBusinessSchema } from "@/lib/schema";

/**
 * The public website.
 *
 * Everything a customer or a crawler can reach, and the only place the
 * marketing chrome and the business structured data are rendered. A route
 * group, so none of this appears on `/admin` — and so none of the admin code
 * appears here either.
 *
 * The group affects nothing about the URLs: `(site)` is not a path segment.
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
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
    </>
  );
}
