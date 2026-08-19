import {
  availability,
  business,
  cp12,
  legal,
  registeredOffice,
  serviceAreas,
} from "./business";
import { faqs } from "./faqs";

/**
 * Structured data. Every value traces back to docs/business-details.md.
 * No aggregateRating or review markup — there are no verified reviews yet, and
 * inventing them would breach both Google's guidelines and the project rules.
 */

export const localBusinessSchema = {
  "@context": "https://schema.org",
  "@type": "HVACBusiness",
  "@id": `${business.url}/#business`,
  name: business.name,
  legalName: business.legalName,
  url: business.url,
  telephone: `+44${business.phone.slice(1)}`,
  email: business.emailGeneral,
  description: `Gas Safe registered gas engineers providing fixed-price ${cp12.priceDisplay} gas safety certificates (CP12) in Wolverhampton and the surrounding area.`,
  areaServed: serviceAreas.map((area) => ({
    "@type": "City",
    name: area,
  })),
  address: {
    "@type": "PostalAddress",
    streetAddress: registeredOffice.streetAddress,
    addressLocality: registeredOffice.addressLocality,
    addressRegion: registeredOffice.addressRegion,
    postalCode: registeredOffice.postalCode,
    addressCountry: registeredOffice.addressCountry,
  },
  identifier: legal.companyNumber
    ? {
        "@type": "PropertyValue",
        name: "Companies House company number",
        value: legal.companyNumber,
      }
    : undefined,
  openingHoursSpecification: [
    {
      "@type": "OpeningHoursSpecification",
      dayOfWeek: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Sunday",
      ],
      opens: "10:00",
      closes: "20:00",
    },
  ],
  hasCredential: {
    "@type": "EducationalOccupationalCredential",
    credentialCategory: "Gas Safe Register",
    identifier: business.gasSafeNumber,
  },
  employee: {
    "@type": "Person",
    name: business.engineerName,
    jobTitle: "Gas Safe Registered Engineer",
  },
} as const;

export const serviceSchema = {
  "@context": "https://schema.org",
  "@type": "Service",
  name: "Gas Safety Certificate (CP12) Wolverhampton",
  serviceType: "Landlord Gas Safety Record (CP12)",
  provider: { "@id": `${business.url}/#business` },
  areaServed: serviceAreas.map((area) => ({ "@type": "City", name: area })),
  offers: {
    "@type": "Offer",
    price: cp12.price,
    priceCurrency: "GBP",
    availability: "https://schema.org/InStock",
    valueAddedTaxIncluded: true,
    description: `Fixed price including VAT, covering ${cp12.includes}. Additional appliances ${cp12.extraApplianceDisplay} each.`,
    url: `${business.url}/book`,
    priceSpecification: {
      "@type": "PriceSpecification",
      price: cp12.price,
      priceCurrency: "GBP",
      valueAddedTaxIncluded: true,
    },
  },
} as const;

export const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((faq) => ({
    "@type": "Question",
    name: faq.question,
    acceptedAnswer: { "@type": "Answer", text: faq.answer },
  })),
} as const;

export function breadcrumbSchema(
  items: { name: string; path: string }[],
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${business.url}${item.path}`,
    })),
  };
}

/** Renders a JSON-LD block. */
export function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export const openingHoursText = `${availability.workingDays}, ${availability.workingHours}`;
