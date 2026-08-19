# BSCJ Gas & Heating — CP12 booking website

Fast-launch marketing and booking site for BSCJ Gas & Heating (Supreme Gas Ltd),
targeting fixed-price gas safety certificates (CP12) in Wolverhampton.

## How it works

Bookings are taken through an embedded **Google Calendar Appointment Schedule**,
which writes straight into the engineer's calendar. There is deliberately no
database, no accounts and no custom booking backend.

## Source of truth

Every business fact on the site comes from `docs/business-details.md`, funnelled
through `src/lib/business.ts`. Nothing may be invented. In particular there are
no reviews or ratings anywhere, because none are verified yet.

To change a price, phone number, service area or the same-day messaging, edit
`src/lib/business.ts` — it updates every page at once.

## Commands

```bash
npm run dev        # local preview at http://localhost:3000
npm run build      # production build
npm run typecheck  # TypeScript check
npm run lint       # ESLint
```

## Structure

| Path | Purpose |
| --- | --- |
| `src/lib/business.ts` | All verified business facts |
| `src/lib/faqs.ts` | FAQ content, reused for FAQ structured data |
| `src/lib/schema.tsx` | JSON-LD structured data |
| `src/components/` | Shared UI |
| `docs/` | Business details and the raw calendar embed |
| `research/` | Competitor research (strategy input, not for copying) |
