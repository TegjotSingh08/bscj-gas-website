# Business Details

## Brand

- Public business name: BSCJ Gas & Heating
- Legal company name: Supreme Gas Ltd
- Companies House number: 12212412
- Registered office: Marshall Industrial Estate, Unit 11b, Sedgley Street, Wolverhampton, England, WV2 3AJ
- Incorporated: 17 September 2019
- SIC code: 43220 - Plumbing, heat and air-conditioning installation
- Company status: Active
- Source: Companies House record, verified 19 August 2026
- Domain:www.bscj-solutions.com 
- Public telephone: 07494949648
- WhatsApp number: 07494949648
- Public email: hello@bscj-solutions.com
- Gas Safe registration number:632741
- Engineer name (INTERNAL ONLY, do not publish): Jagjeet Singh. Decided 22 August
  2026 that the engineer's personal name must not appear on any customer-facing
  surface — page copy, metadata, structured data, the booking flow, the
  confirmation page or the confirmation email. Work is described at business
  level, or as "a Gas Safe registered engineer". The name is therefore NOT held
  in `src/lib/business.ts` at all, and `src/lib/public-content.test.ts` fails the
  build if it reappears anywhere under `src/`. It is recorded here because this
  file is the internal business record.
- Verified years of experience: 10 Years in the industry

## CP12 Service

- CP12 price: £45
- Appliances included in £45: 	One Boiler and two appliances
- Additional appliance price: £15/appliance
- VAT (INTERNAL ONLY, do not publish): the £45 is VAT inclusive. Decided 19 August 2026 that the website must present the price simply as "£45 total" and must not use VAT wording anywhere public. Do not add VAT wording back without an explicit instruction.
- Typical appointment duration: 45 minutes
- Certificate delivery time: Physical Certificate completed at property - digital certificate emailed same day free of charge
- Payment method: Pay after completion
- Same-day service available: Yes - by phone/WhatsApp only (see Availability Messaging below)

## Availability Messaging

DECIDED 19 August 2026. Chosen approach: Option C.

- Website wording: same-day appointments are often available, arranged by phone or WhatsApp.
- Online Google Calendar booking keeps the 12 hour minimum notice.
- Urgent and same-day jobs are taken by phone or WhatsApp, not through the online booking form.
- Do not state a guaranteed same-day slot anywhere on the site.

This is a messaging decision, not a fixed constraint. It can be changed later to:
- Option A: drop same-day wording entirely and advertise next-day appointments.
- Option B: genuinely offer same-day online by reducing the calendar minimum notice to 2-4 hours.

Any change must be made here first, then reflected on the site.

## Availability

- Working days: Monday - Friday + Sunday
- Working hours: 10:00 - 20:00
- Appointment length: 45 minutes
- Buffer between appointments: 15 minutes
- Maximum CP12 bookings per day: 8
- Minimum booking notice: 12 hours	
- Maximum advance booking period: 30 days

## Service Areas

DECIDED 22 August 2026: the standard service area is a **12 mile straight-line
radius** from a configured operating centre, not a list of towns and not a list
of postcode districts. `SERVICE_AREA_RADIUS_MILES = 12` is kept.

How eligibility is actually decided, every time:

```
validated postcode
  → Postcodes.io coordinates
  → server-side haversine distance
  → configured service-area origin
  → 12 mile radius
```

The origin is held as server-side coordinates only — never a street name, never
a personal postcode, and never exposed to the browser.

**This is a geographic service radius, not live road-routing.** It is not a
driving distance and not a travel time. No journey time may be advertised on the
back of it.

Towns currently inside the radius, used for page copy and `areaServed`
structured data. **Indicative only** — a town name never guarantees acceptance,
and BSCJ has no premises in any of them:

- Wolverhampton
- Bilston
- Wednesfield
- Willenhall
- Codsall
- Dudley
- Walsall
- West Bromwich
- Cannock
- Stourbridge

Public positioning: "BSCJ Gas & Heating serves Wolverhampton and surrounding
areas within our standard service area", followed by "Enter your postcode when
booking to confirm whether your property is within our standard online booking
area."

A property outside the radius is never told we do not serve it — work beyond the
standard online area may still be accepted by arrangement, so the wording offers
the phone and WhatsApp instead.

## Booking Rules

- Booking type: taken through the BSCJ-branded booking flow on the website, which
  writes the confirmed appointment directly into the engineer's Google Calendar.
  Google Calendar is the backend availability source and appointment
  destination — it is not the customer-facing booking interface.
- Appointment holds: a chosen time is reserved for the customer for 30 minutes
  while they complete the form.
- Property address: postcode validated against Postcodes.io, then house
  number/name and street entered manually. The customer explicitly confirms the
  assembled address before the booking is written. Nothing claims to prove a
  house exists at a postcode.
- Confirmation: one branded confirmation email is sent after the calendar event
  exists, with the appointment details and a booking reference.
- Cancellation policy: Can cancel with 48 hour - unable to cancel if less than 48 hours between appointment time 
- Rescheduling policy: Free rescheduling if more than 24 hours away from appointment time
- Tenant contact details required: Yes
- Parking or access information required: If applicable

**The cancellation and rescheduling wording above is the operational intent, not
the published legal position.** The Terms & Conditions / Consumer Contracts
milestone is still outstanding and will settle the customer-facing wording,
including statutory cancellation rights. See `PROJECT_HANDOFF.md` §11.

## Customer Contact

- Main phone number: 07494949648
- WhatsApp number: 07494949648
- Booking email: admin@bscj-solutions.com
- General enquiries email: hello@bscj-solutions.com

## Verified Trust Information

- Gas Safe registered: Yes
- Gas Safe number: 632741
- Fully insured: Yes
- Years of experience: 10 Years in Gas industry 
- Family-run business: Yes
- Current verified review rating: N/A - build up once reviews start rolling in
- Current verified review count: N/A - build up once reviews start rolling in

## Important Rules

- Do not publish facts that have not been verified.
- Do not invent reviews, accreditations or guarantees.
- Do not promise same-day service unless operationally available.
- Do not show a fixed price without explaining what is included.

