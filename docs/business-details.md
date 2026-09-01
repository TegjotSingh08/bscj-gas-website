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
- Engineer identity: maintained privately outside this repository.
  Decided 22 August 2026, and tightened on 24 August 2026 to remove the name
  from the repository altogether. The engineer's personal name must not appear
  on any customer-facing surface — page copy, metadata, structured data, the
  booking flow, the confirmation page or the confirmation email — and it is no
  longer recorded in any tracked file either. Work is described at business
  level, or as "a Gas Safe registered engineer". The application never needs
  the name, so it is not held in `src/lib/business.ts`, not in configuration
  and not in an environment variable.
- Verified years of experience: 10 Years in the industry

## CP12 Service

- CP12 price: £45
- Appliances included in £45: 	One Boiler and two appliances
- Additional appliance price: £15/appliance
- VAT (INTERNAL ONLY, do not publish): the £45 is VAT inclusive. Decided 19 August 2026 that the website must present the price simply as "£45 total" and must not use VAT wording anywhere public. Do not add VAT wording back without an explicit instruction.
- Typical appointment duration: 45 minutes
- Certificate delivery time: Physical Certificate completed at property - digital certificate emailed same day free of charge
- Payment method: Pay after completion
- What the £45 covers (CONFIRMED 24 August 2026): the gas safety inspection and
  the resulting record. The charge is for CARRYING OUT the inspection, so it is
  payable whether the property passes or a defect is found. Repairs, replacement
  parts and remedial work are NOT included — they are a separate service, quoted
  and agreed before any extra work starts, and invoiced separately. Customers are
  under no obligation to use BSCJ for repairs and the record is never withheld
  for declining. Wording lives in `inspectionScope` in `src/lib/business.ts`.
- No separate CP12 call-out fee.
- Same-day service available: Yes - by phone/WhatsApp only (see Availability Messaging below)

## Annual Boiler Service (CONFIRMED 31 August 2026)

A third bookable product, sold standalone. The £45 CP12 and the £90 bundle both
remain available and unchanged.

- Product name: Annual Boiler Service
- Price: £60 fixed
- Calendar allocation: 60 minutes
- Extra appliances: NOT APPLICABLE. This is one boiler at a fixed price
  whatever else the property runs on gas. The £15 extra-appliance rule belongs
  to the certificate and must never be applied here.
- Payment method: Pay after completion
- 19:00 start: PERMITTED, on the same boundary rule as the bundle - a 60 minute
  appointment runs 19:00-20:00 and finishes exactly at the end of the day.

**The 60 minutes is a calendar allocation, not a statement of how long the work
takes.** No standalone duration has ever been measured or confirmed. The
combined visit allocates 60 minutes for a 45 minute CP12 *plus* the service,
which implies the service element is well under an hour when the two are done
together. Sixty was chosen deliberately as the generous end: over-allocating
protects the diary, under-allocating oversells it. Nothing customer-facing says
the service takes an hour. Revisit once real jobs have been timed.

**What the service includes has NOT been specified.** Only the name and the
price are confirmed. Do not publish, imply or invent any description of the
checks, procedures or parts involved.

## Bundle saving (CONFIRMED 31 August 2026)

Now that the boiler service has its own published price, the bundle saving is
real arithmetic on real prices rather than a marketing claim:

```
CP12 separately            £45
Annual Boiler Service      £60
                          ----
Separate total            £105
CP12 + Annual Boiler Service (bundle)   £90
Customer saving           £15
```

The site may therefore say **"Best value"**, **"Save £15"** and
**"£105 separately · £90 together"**, because all three figures are published,
bookable prices.

It may NOT invent a higher crossed-out price, imply a temporary discount, or
suggest scarcity. The saving is **derived in code** from the component prices
(`bundleSavingFor` in `src/lib/booking/products.ts`), so it cannot drift if any
of the three prices ever changes.

## CP12 + Annual Boiler Service (CONFIRMED 31 August 2026)

A second bookable product, sold alongside the £45 CP12. The £45 CP12 remains
available and unchanged.

- Product name: CP12 + Annual Boiler Service
- Price: £90 total
- Appointment duration: 60 minutes
- Appliances included in £90: one boiler and two appliances — the same rule as
  the standalone CP12 (the certificate element; the boiler service element is
  one boiler)
- Additional appliance price: £15/appliance — the same rate as the standalone
  CP12, applied on top of the £90 base
- Worked examples: £90 base; £105 with one chargeable extra appliance; £120 with
  two
- Payment method: Pay after completion, as with the CP12
- 19:00 start: PERMITTED. A 19:00 booking runs 19:00-20:00, finishing exactly at
  the end of the working day. See "Appointment duration vs scheduling buffer".

**What the annual boiler service includes has NOT been specified.** Only the
product name and the price are confirmed. Do not publish, imply or invent any
description of the checks, procedures or parts involved. The website says the
customer has booked a CP12 plus an annual boiler service, and nothing more.

## Appointment duration vs scheduling buffer

DECIDED 31 August 2026, when the 60 minute bundle was confirmed.

These are two different things and the booking engine now treats them
separately:

- **Appointment duration** is customer-facing. It must finish within the
  published working hours. A slot is only offered if the appointment itself
  ends at or before 20:00.
- **The 15 minute buffer** is internal scheduling protection — travel and
  overrun time between jobs. It is not part of the customer's appointment and
  it is allowed to extend past the end of the working day for the last
  appointment.

Consequences:

- The last CP12 start is 21:00 (21:00-21:45).
- The last hour-long start is also 21:00 (21:00-22:00), with the buffer running
  internally to 22:15.
- No appointment of any product is offered starting after 21:00.
- Between two bookings the 15 minute buffer is still enforced in full, so a
  21:00-22:00 appointment blocks any other job from 20:45 to 22:15.

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
- Working hours: 10:00 - 22:00
- Appointment length: 45 minutes for a CP12, 60 minutes for CP12 + Annual
  Boiler Service, 60 minutes allocated for a standalone Annual Boiler Service.
  Set per product, never globally.
- Buffer between appointments: 15 minutes. Internal only - see "Appointment
  duration vs scheduling buffer".
- Maximum bookings per day: 8. Counted as bookings, not as minutes, so a day
  of bundles is a longer day than a day of CP12s.
- Minimum booking notice: 12 hours	
- Maximum advance booking period: 30 days

## What counts toward the daily limit

DECIDED 1 September 2026, when the cap rose to 10.

The limit is **10 customer bookings per local Europe/London calendar date**. It
is enforced by this website, never assumed to be enforced by Google.

**Counts toward the ten:** an appointment booked through this site. These are
identified on the calendar by the private extended property `bscjBooking=1`
that every new booking carries, or by the event id prefix `bscj` that every
booking this site has ever written carries - including the ones taken before
the property existed. Cancelled events do not count.

**Does not count:** anything else on the engineer's calendar. The recurring
weekday school run, a dentist appointment, a personal entry. These still
**block the times they cover**, through the normal Google free/busy check, but
they are not customers and must not spend the day's capacity.

This distinction is the reason free/busy alone is not enough: it returns start
and end times only, with no way to tell a customer from a school run. The count
therefore comes from a separate read of the events list.

**The school run is not modelled in code.** There is no hardcoded 15:00-17:00
rule anywhere. Those slots are generated normally and disappear only because
Google reports a conflict, so deleting the event for one day brings them back
with no deployment. Note that a 15:00-17:00 event removes **three** slots -
15:00, 16:00 and 17:00 - because the 15 minute travel buffer widens it to
17:15. Ending the event at 16:45 would return 17:00.

**Concurrency.** Counting and writing are two steps, so a booking holds a short
lock on its own local date while it counts and writes. Two customers
confirming for the same day at the same moment are serialised, and the second
counts after the first has landed. If the reservation store is unreachable the
booking still proceeds on the Google count alone, which is the protection that
existed before the cap was enforced at all.

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
- Product selection: the customer chooses CP12 or CP12 + Annual Boiler Service
  before picking a time. The browser sends only a product identifier; the
  server derives the name, price, extra-appliance rate and duration from its
  own registry. A submitted price or duration is ignored.
- Appointment holds: a chosen time is reserved for the customer for 30 minutes
  while they complete the form. A hold covers every hourly start the
  appointment and its buffer run across, so a 60 minute bundle held at 10:00
  also reserves 11:00 and nobody else is offered a conflicting time.
- Property address: postcode validated against Postcodes.io, then house
  number/name and street entered manually. The customer explicitly confirms the
  assembled address before the booking is written. Nothing claims to prove a
  house exists at a postcode.
- Confirmation: one branded confirmation email is sent after the calendar event
  exists, with the appointment details and a booking reference.
- Cancellation policy (REVISED 22 August 2026): the customer can cancel or move
  any appointment free of charge, whatever notice is given. There is no
  cancellation charge, no no-show charge and no deadline after which an
  appointment "cannot" be cancelled. We ask for 24 hours' notice as a courtesy,
  not as a condition. The previous "48 hours, cannot cancel inside that window"
  wording was withdrawn because it purported to exclude a statutory right.
- Statutory cancellation right: bookings made online are distance contracts, so
  the customer has 14 days to cancel. Where the appointment falls inside those
  14 days the booking flow takes a separate express request before the engineer
  may attend. See docs/CONSUMER_RIGHTS.md.
- Rescheduling policy: free. Arranged by contacting the business — there is no
  self-service rescheduling on the website, and the site does not claim one.
- Failed access policy: one further appointment free of charge. No automatic
  charge. If access fails repeatedly, BSCJ may decline to keep rebooking online
  rather than charging a penalty.
- Tenant contact details required: Yes
- Parking or access information required: If applicable

The customer-facing wording of all of the above now lives in one place:
`cancellationPolicy` in `src/lib/business.ts`, rendered on /terms, /book, the
FAQs, the confirmation page and the confirmation email. Terms version in force:
**2026-08-31**, bumped when the CP12 + Annual Boiler Service bundle was added and
/terms had to describe a second contracted service. Change the policy here
first, then in `business.ts`, then bump `TERMS_VERSION`.

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

