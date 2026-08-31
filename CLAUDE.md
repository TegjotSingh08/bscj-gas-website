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
- Do not build a custom database for Version 1.
- Do not build customer accounts.
- Do not build an admin dashboard.
- Do not build a custom calendar backend. Google Calendar stays the system of
  record for availability and appointments.
- Do not remove or change the £45 CP12 product. It is the entry offer and its
  price, duration, appliance rule and booking behaviour are fixed.
- Do not describe what the annual boiler service includes beyond the confirmed
  name. No procedures, checklists or inclusions have been verified.
- Do not reinstate the Google Calendar iframe as the booking interface, and do
  not rebuild the branded booking flow, the 30-minute holds, the calendar
  integration or the confirmation email — they are complete and owner-approved.
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