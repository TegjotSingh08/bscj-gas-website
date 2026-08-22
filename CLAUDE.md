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

## Main offer

Gas Safety Certificate Wolverhampton — fixed £45 total.

The exact wording must follow docs/business-details.md.