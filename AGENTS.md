# BSCJ Gas Website Instructions

## Main objective

Build and launch a high-converting fixed-price CP12 booking website for Wolverhampton.

Bookings are taken through the BSCJ-branded booking flow built into the site.
Google Calendar is the backend availability source and appointment destination,
reached through a service account — it is not the customer-facing interface.

*Historical:* this originally read "the booking system will use Google Calendar
Appointment Scheduling". The embedded iframe was replaced by the branded flow in
commit 2b50afa and the Google appointment-schedule page is now only an emergency
fallback link. See `docs/PRODUCT_ROADMAP.md`.

## Source files

Read these before making changes:

- docs/PROJECT_HANDOFF.md
- docs/business-details.md
- docs/calendar-embed.txt (the fallback booking page only, not the booking system)
- research/competitor-research.pdf
- research/competitor-research.docx

## Rules

- Use verified business information only.
- Do not invent prices, reviews, certifications, guarantees or service claims.
- **Superseded by V2 (approved 4 September 2026).** V1 forbade a database,
  customer accounts and an admin dashboard, and those rules were right for V1 —
  they kept the launch small. V2 replaces them; see "Version 2 scope" below.
  Everything else in this list still stands.
- Do not build a custom calendar backend. Google Calendar stays the system of
  record for **availability and appointments** — but from V2 it is no longer
  the record of customers, jobs or history. Postgres is.
- Do not hardcode recurring unavailability such as the weekday school run.
  Slots are generated normally and removed only by a real Google Calendar
  conflict, so deleting the event makes them bookable again with no deploy.
- The daily limit counts customer bookings only. The engineer's own diary
  entries block times but never consume one of the ten.
- Do not remove or change the £45 CP12 product. It is the entry offer and its
  price, duration, appliance rule and booking behaviour are fixed.
- Do not describe what the annual boiler service includes beyond the confirmed
  name. No procedures, checklists or inclusions have been verified.
- Do not reinstate the Google Calendar iframe as the booking interface, and do
  not rebuild the branded booking flow, the 30-minute holds, the calendar
  integration or the confirmation email — they are complete and owner-approved.
- Do not redesign the working self-booking flow. V2 extends it so a booking
  also persists; it does not rewrite it.
- Do not publish the engineer's personal name anywhere customer-facing.
- Keep the website mobile-first.
- Keep the website fast.
- Use concise UK English.
- Do not copy competitors' wording or design.
- Use the competitor research for strategy only.
- Prioritise booking conversion.
- Use clear pricing.
- Include phone and WhatsApp alternatives.
- Run tests, typecheck, lint and production build before finishing.

## Version 2 scope

Approved 4 September 2026. V2 turns the booking website into the beginning of a
property compliance platform: landlord and agent bookings across multiple
properties, tenants choosing their own appointment through a secure link, and
an internal admin portal holding the job, certificate, invoice and renewal
record.

**Postgres is the operational source of truth** for jobs, customers,
properties and history. Google Calendar remains scheduling; Resend remains
communication. Neither is the customer database again.

Architecture, data model, state model and what BSCJ still has to supply:
`docs/V2_ARCHITECTURE.md`. Migrations: `drizzle/README.md`.

### V2 rules

- Extend the existing architecture. Do not rebuild what works.
- Never trust a client-supplied price, duration, status or job ownership.
  Re-derive them on the server, as the booking route already does.
- A booking reference identifies a job. It never authorises access to one.
- Do not invent business, legal or accounting facts — VAT status, bank
  details, payment terms, invoice wording or a CP12 renewal interval. They are
  configuration, empty until BSCJ supplies them.
- Postgres cannot make a Google Calendar write or an email send atomic. Record
  the intent durably and the outcome separately; never lose a job because an
  external call failed.
- Keep the admin area out of the public bundle, out of the sitemap and out of
  the index.
- Phases land one at a time, each leaving a working application.

## Required pages

- /
- /gas-safety-certificate-wolverhampton
- /book
- /about
- /contact
- /privacy
- /terms

## Products

Two bookable services. Both are sold as a fixed total, both are booked through
the same flow, and both are priced and timed by the server from the product
registry in `src/lib/booking/products.ts` — never from anything the browser
sends.

1. **Gas Safety Certificate (CP12)** — fixed £45 total. The main offer, and the
   default product everywhere. 45 minute appointment.
2. **Annual Boiler Service** — fixed £60. 60 minute calendar allocation.
   Confirmed 31 August 2026. One boiler at a fixed price: the extra-appliance
   rule does **not** apply to it.
3. **CP12 + Annual Boiler Service** — fixed £90 total. 60 minute appointment.
   Confirmed 31 August 2026.

The two products that include a certificate cover one boiler and two additional
appliances, with each further appliance £15. The standalone service is £60
however many appliances the property has.

Because £45 and £60 are both published, bookable prices, the £90 bundle saves a
real £15 against £105 separately. "Best value" and "Save £15" are therefore
evidenced and permitted — derived in code, never written down. Invented
crossed-out prices, fake discounts and scarcity remain forbidden.

The exact wording must follow docs/business-details.md.

Nothing beyond "an annual boiler service" has been confirmed about what the
service itself includes. Do not describe its steps, checks or inclusions.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
