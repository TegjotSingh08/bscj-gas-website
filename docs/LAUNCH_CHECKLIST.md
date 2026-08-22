# Launch Checklist

Status as of 22 August 2026.

Version 1 = fixed-price CP12 booking site for Wolverhampton and the surrounding
area. Bookings are taken through the **BSCJ-branded booking flow built into the
site**; Google Calendar is the backend availability source and appointment
destination, not the customer-facing interface. Upstash Redis holds a chosen
appointment for 30 minutes, Postcodes.io validates the postcode, the service
area is a 12 mile radius, and Resend sends the confirmation email.

The application has **not** been intentionally deployed or launched. See
`PROJECT_HANDOFF.md` §18.

---

## Blocking before deployment

Things that genuinely stop the site going up.

- [ ] **Terms & Conditions / Consumer Contracts milestone — the next task, and
      the one real blocker left.** `/terms` still holds an earlier page that
      predates the consumer-rights research. It has no 14-day statutory
      cancellation right, no regulation 36 express request, no acknowledgement
      about losing the right on full performance, no versioned terms acceptance
      and no server-side enforcement. Clause 4 currently states that
      appointments cannot be cancelled inside the 48-hour window, which as
      written purports to exclude a statutory right. **Do not launch on the
      current terms.** See `PROJECT_HANDOFF.md` §11.

- [x] Production build passes (`npm run build`)
- [x] TypeScript passes (`npm run typecheck`)
- [x] ESLint passes (`npm run lint`)
- [x] All 7 Version 1 pages build as static routes
- [x] No secrets or credentials committed; `.gitignore` covers `.env*`
- [x] No placeholder text (TODO / FIXME / Lorem Ipsum) anywhere in `src/`
- [x] Company number and registered office confirmed (12212412, WV2 3AJ) and
      shown on `/privacy`, `/terms` and `/contact`
- [x] Price confirmed at £45, shown publicly as "£45 total" with no VAT wording,
      defined in one place (`src/lib/business.ts`)
- [x] No invented reviews, ratings, guarantees or accreditations anywhere
- [x] No review/rating structured data (there are no verified reviews yet)
- [x] Custom BSCJ booking flow replaces the Google iframe (no Google branding,
      no customer sign-in)
- [x] Full suite green — 389 tests across 64 suites covering the availability
      engine, holds, the attempt reducer, the booking route's transaction order,
      the Google client, the email builder and transport, address handling,
      contact validation and the public-content rules. No test contacts a live
      provider
- [x] Server re-checks availability immediately before creating any event
- [x] Duplicate submissions cannot create two bookings (deterministic event id)
- [x] Price always derived server-side, never taken from the browser
- [x] Booking fallback (alternative page / call / WhatsApp) when availability
      cannot be loaded
- [x] 30-minute appointment holds, so two customers cannot fill in the same
      slot at once. Atomic SET NX EX in Upstash Redis; TTL is authoritative
- [x] Rate limiting moved to the shared store so it holds across Vercel
      instances, with a per-instance fallback during an outage
- [x] Branded booking confirmation email, sent only after the calendar event
      exists. An email failure never fails a booking
- [x] Confirmation email is responsive: desktop unchanged, mobile tightened,
      contact buttons stack full width on a phone
- [x] Appointment time meets the large-text contrast threshold (#db7304)
- [x] Confirmation page shows a prominent "confirmation email sent" panel with
      Junk/Spam guidance — shown only when the email actually sent
- [x] MILESTONE COMPLETE: verified end to end against live Resend, including
      a deliberate invalid-key test proving a booking survives an email failure
- [x] Property addresses validated: the postcode is checked hard against
      Postcodes.io, and house number/name and street are then entered manually.
      Nothing claims to prove a house exists at a postcode
- [x] One address formatter feeds the review screen, calendar event,
      confirmation page and email — they cannot disagree
- [x] The postcode and the service area are re-established server-side in
      `/api/book`; nothing about the address is taken on the browser's word
- [x] Service area is a 12 mile straight-line radius from a configured operating
      centre, measured with a tested haversine calculation against the
      coordinates the postcode provider returns. The old postcode-district
      whitelist is gone
- [x] OpenStreetMap / Nominatim property verification removed — it could not
      establish whether a house exists and added a step without adding
      information. Do not reinstate it
- [x] Property address confirmed explicitly by the customer on the review step,
      required by the server as a literal true
- [x] The postcode endpoint returns only the canonical postcode, the town and
      whether it is covered — no coordinates, no outcode, no distance
- [x] Public copy reflects the 12 mile radius, names the towns currently inside
      it as indicative only, and points customers at the postcode check
- [x] The engineer's personal name appears nowhere customer-facing, enforced by
      a test over the whole of `src/`
- [x] UK mobile numbers normalised to +447XXXXXXXXX by one shared
      implementation used by the form, the schema and the booking route
- [x] **Advertised service area decided (22 August 2026).** The 12 mile radius
      is kept, and the public copy was widened to match it rather than the radius
      being reduced. Wolverhampton, Bilston, Wednesfield, Willenhall, Codsall,
      Dudley, Walsall, West Bromwich, Cannock and Stourbridge are now named as
      indicative, with the postcode check presented as authoritative
- [x] Customer-safe booking reference (BSCJ-XXXXXX) on both the confirmation
      page and the email
- [x] **Resend account created, domain verified, API key set** — done and
      confirmed by real delivery. See `docs/EMAIL_SETUP.md`.
- [x] **Upstash Redis database created and its two variables set locally** —
      see `docs/REDIS_SETUP.md`. Without it holds are skipped and booking
      falls back to first-confirmed-wins, which is safe but allows two people
      to reach the confirm step on one slot. Still to be added in Vercel.
- [x] **Google Calendar service account created and calendar shared** —
      follow `docs/GOOGLE_CALENDAR_SETUP.md`. Working locally against the live
      calendar. Still to be added in Vercel; until then a deployment would show
      the booking fallback screen.
- [x] Phone and WhatsApp links verified identical on every page
- [x] No horizontal overflow at 375 / 390 / 430 / 768 / 1280 px
- [x] 404 page returns a real 404 status

## Blocking before public launch

Must be checked by a human on the live site, after deployment.

- [ ] Domain `www.bscj-solutions.com` resolves to the Vercel deployment
- [ ] **Google Workspace email still works** — send and receive a test message
      after any DNS change. MX records must not be touched.
- [ ] HTTPS certificate is active and the site loads without warnings
- [ ] Add the three Google environment variables in Vercel and redeploy
      (`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_CALENDAR_ID`)
- [ ] Make one real test booking end to end on the live site, and confirm it
      lands in the engineer's Google Calendar with name, phone, email,
      property, appliance count and price in the description
- [ ] Confirm the busy slot then disappears from the website's availability
- [ ] Try booking the same slot from a second browser and confirm it is
      refused with "that appointment has just been taken"
- [ ] Double-click Confirm and check only one event is created
- [ ] Two-browser hold test: reserve a slot in one browser, confirm it
      disappears from the other browser's availability
- [ ] Confirm the countdown appears and turns orange under 5 minutes
- [ ] Confirm the reservation survives Details, Review and back navigation
      without the countdown resetting
- [ ] Use Change time, let the switch fail (hold the target in another
      browser), and confirm the original reservation is still held
- [ ] Use Cancel booking and confirm the slot returns to availability
- [x] Live test booking made: email delivered, renders correctly on desktop
      and phone, with the right date, time, property, price and reference
- [x] Reply-to confirmed reaching a monitored inbox
- [ ] Add `RESEND_API_KEY` and `BOOKING_EMAIL_FROM` in Vercel and redeploy
- [ ] Confirm Google Workspace email still sends and receives after the DNS
      changes
- [ ] Book with a real local address and confirm the postcode, street and town
      read correctly on the review screen, in Google Calendar and in the email
- [ ] Try a postcode just outside the area and confirm it offers the phone
      rather than claiming the postcode is invalid
- [ ] Confirm an expired hold returns the customer to time selection rather
      than creating a booking
- [ ] Check a Saturday shows as unavailable, and that today only offers slots
      more than 12 hours away
- [ ] Cancel the test booking so it does not block a real slot
- [ ] Confirm no confirmation email is promised anywhere the site does not
      actually send one
- [ ] Tap the Call button on a real phone and confirm it dials 07494 949648
- [ ] Tap WhatsApp on a real phone and confirm it opens the right chat
- [ ] Confirm the site's own booking form collects: property address, number of
      appliances, tenant contact details and access/parking notes, and that all
      of them reach the calendar event description
- [ ] Confirm the site's 12-hour minimum notice behaves as the wording says —
      the rule lives in `src/lib/booking/config.ts`, not in Google Calendar
- [ ] Reserve a slot, press **Change date**, and confirm the date picker opens
      with the original appointment still reserved and its countdown running on
- [ ] Browse another date, then use **Keep this time** and confirm the original
      appointment is still held and the countdown never restarted
- [ ] Confirm the expanded "Areas we cover" copy reads correctly on mobile and
      desktop, and that the engineer's name appears nowhere on the live site
- [ ] Submit the sitemap in Google Search Console
      (`https://www.bscj-solutions.com/sitemap.xml`)
- [ ] Verify the site in Google Search Console
- [ ] Check `robots.txt` is live and not blocking anything
- [ ] Test the Open Graph preview by pasting the URL into WhatsApp

## Recommended after launch

Genuinely useful, but none of it should delay going live.

- [ ] Delete `src/components/BookingEmbed.tsx` once a real booking has been
      made through the new flow on the live site — it is the rollback path to
      the old Google iframe and is not rendered anywhere
- [ ] Create and verify a Google Business Profile for Wolverhampton — this is
      the single biggest local-SEO win available and is currently missing
- [ ] Start collecting reviews. Once there are genuine ones, they can be shown
      on the site and marked up with review structured data. Not before.
- [ ] Add a real photograph of the engineer and the van (`assets/` is empty).
      Real photos outperform stock imagery for trust.
- [ ] Add privacy-friendly analytics (Vercel Analytics or Plausible) and wire
      it to the `data-analytics-id` hooks already on every CTA
- [ ] Register with the ICO as a data controller if required, and add the
      registration number to `src/lib/business.ts`
- [ ] Ask Companies House to correct the registered office spelling: the record
      reads "Marshall Industrail Estate" (the site shows it corrected)
- [ ] Review whether the 48-hour cancellation vs 24-hour reschedule rule reads
      oddly to customers — rescheduling is currently easier than cancelling.
      The Terms milestone settles this
