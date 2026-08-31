import type { Metadata } from "next";

import { business, cp12 } from "./business";

/**
 * The share image, described the way the root layout's auto-generated entry
 * describes it. Declaring the dimensions saves a scraper a second request and
 * lets WhatsApp lay the card out before the image arrives; the alt text
 * mirrors `app/opengraph-image.tsx`.
 */
const SHARE_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  type: "image/png",
  alt: `${business.name} — Gas Safety Certificate Wolverhampton ${cp12.priceDisplay}`,
} as const;

/**
 * Per-page Open Graph.
 *
 * Next merges `metadata` shallowly, so a page that declares `openGraph` at all
 * **replaces** the root layout's block rather than adding to it. Setting just
 * a URL therefore silently drops `og:image`, `og:site_name`, `og:locale` and
 * `og:type` — which is exactly what had happened to the CP12 landing page, the
 * one most likely to be shared into WhatsApp.
 *
 * So every page that needs its own `og:url` gets the whole object from here.
 * `og:title` and `og:description` are deliberately omitted: Next fills those
 * from the page's own `title` and `description`, and repeating them would be
 * two more places for the copy to drift.
 *
 * `path` is relative and resolves against `metadataBase` in the root layout,
 * which is the single definition of the production origin.
 */
export function pageOpenGraph(path: string): Metadata["openGraph"] {
  return {
    type: "website",
    locale: "en_GB",
    siteName: business.name,
    url: path,
    // Declared explicitly because the file-convention image is not carried
    // across when a route supplies its own openGraph block.
    images: [SHARE_IMAGE],
  };
}
