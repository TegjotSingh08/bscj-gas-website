# BSCJ Gas & Heating — CP12 booking website

Fast-launch marketing and booking site for BSCJ Gas & Heating (Supreme Gas Ltd),
targeting fixed-price gas safety certificates (CP12) in Wolverhampton and the
surrounding area.

## How it works

Bookings are taken through a **BSCJ-branded booking flow** built into the site —
date picker, time picker, details and a review step. There is no third-party
booking interface and no Google iframe in the customer journey.

Behind it:

- **Google Calendar** is the source of availability (free/busy only) and the
  destination for confirmed appointments. Availability is re-checked against it
  immediately before any event is written.
- **Upstash Redis** holds a chosen appointment for 30 minutes while the customer
  finishes the form, and backs distributed rate limiting.
- **Postcodes.io** validates the property postcode and returns its coordinates.
  Service-area eligibility is a straight-line 12 mile radius from a configured
  operating centre, measured server-side.
- **Resend** sends one branded confirmation email after the calendar event
  exists. An email failure can never undo a confirmed booking.

The Google appointment-schedule page is retained **only** as an emergency
fallback link, shown when live availability cannot be loaded.

There is deliberately no database, no customer accounts and no admin dashboard.

## Source of truth

Every business fact on the site comes from `docs/business-details.md`, funnelled
through `src/lib/business.ts`. Nothing may be invented. In particular there are
no reviews or ratings anywhere, because none are verified yet, and the
engineer's personal name is not published anywhere customer-facing.

To change a price, phone number, service area or the same-day messaging, edit
`src/lib/business.ts` — it updates every page at once.

## Commands

```bash
npm run dev        # local preview at http://localhost:3000
npm test           # node --test, TypeScript run directly
npm run build      # production build
npm run typecheck  # TypeScript check
npm run lint       # ESLint
```

No automated test contacts Google, Upstash, Resend or Postcodes.io. All four are
replaced by fakes or module mocks.

## Structure

| Path | Purpose |
| --- | --- |
| `src/lib/business.ts` | All verified business facts |
| `src/lib/booking/` | Booking rules — slots, holds, pricing, contact, schema |
| `src/lib/address/` | Postcode validation, service-area radius, formatting |
| `src/lib/google/` | Google Calendar client (server only) |
| `src/lib/email/` | Confirmation email builder and Resend transport |
| `src/lib/faqs.ts` | FAQ content, reused for FAQ structured data |
| `src/lib/schema.tsx` | JSON-LD structured data |
| `src/components/booking/` | The booking flow |
| `src/components/` | Shared UI |
| `docs/` | Business details, setup guides, roadmap, launch checklist |
| `research/` | Competitor research (strategy input, not for copying) |

Start with `docs/PROJECT_HANDOFF.md` — it describes what the repository
currently is.
