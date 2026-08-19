# Launch Checklist

Status as of 19 August 2026. Version 1 = fixed-price CP12 booking site for
Wolverhampton, booking via Google Calendar Appointment Scheduling.

---

## Blocking before deployment

Things that genuinely stop the site going up.

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
- [x] Availability engine unit tested — 38 tests covering working hours,
      buffers, minimum notice, DST, daily cap, pricing and validation
- [x] Server re-checks availability immediately before creating any event
- [x] Duplicate submissions cannot create two bookings (deterministic event id)
- [x] Price always derived server-side, never taken from the browser
- [x] Booking fallback (alternative page / call / WhatsApp) when availability
      cannot be loaded
- [ ] **Google Calendar service account created and calendar shared** —
      follow `docs/GOOGLE_CALENDAR_SETUP.md`. Until this is done the booking
      page shows the fallback screen.
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
- [ ] Check a Saturday shows as unavailable, and that today only offers slots
      more than 12 hours away
- [ ] Cancel the test booking so it does not block a real slot
- [ ] Confirm no confirmation email is promised anywhere the site does not
      actually send one
- [ ] Tap the Call button on a real phone and confirm it dials 07494 949648
- [ ] Tap WhatsApp on a real phone and confirm it opens the right chat
- [ ] Check the Google Calendar booking form asks for: property address,
      number of appliances, tenant contact details, access/parking notes
- [ ] Confirm the calendar's minimum notice is set to 12 hours, matching the
      wording on the site
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
- [ ] Decide whether "Additional areas" in `business-details.md` should be
      filled in — it is currently blank
- [ ] Ask Companies House to correct the registered office spelling: the record
      reads "Marshall Industrail Estate" (the site shows it corrected)
- [ ] Review whether the 48-hour cancellation vs 24-hour reschedule rule reads
      oddly to customers — rescheduling is currently easier than cancelling
