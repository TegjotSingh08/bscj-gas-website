# Project Handoff

Written 21 August 2026. Revised 22 August 2026 by the pre-terms correction
milestone.

This document exists so a fresh session with no memory of previous
conversations can pick this project up accurately. It describes what the
repository **currently is**, not what was once planned. Where an earlier
decision has been reversed, the reversal is recorded here.

Read this first, then `business-details.md` (the source of truth for business
facts) and `LAUNCH_CHECKLIST.md` (what stands between here and launch).

---

## 1. Project purpose

A fixed-price **Gas Safety Certificate (CP12)** booking website for **BSCJ Gas
& Heating**, a trading name of **Supreme Gas Ltd**, operating in and around
Wolverhampton.

**Version 1 objective:** be the easiest credible way for someone who needs a
CP12 to understand the offer, trust the engineer, and secure a real
appointment. It does one thing well; it is not a platform.

**Launch status: not launched, and never deployed from this workflow.** The
application runs locally against live Google Calendar, Upstash Redis and Resend
accounts. See §18.

---

## 2. Tech stack and architecture

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Tailwind CSS v4** (tokens in `src/app/globals.css`)
- Runtime dependencies, deliberately few: `next`, `react`, `react-dom`,
  `server-only`, `zod`
- Node's built-in test runner — no test framework dependency

### Directories

| Path | Contents |
| --- | --- |
| `src/app/` | Pages and API routes |
| `src/components/` | Marketing-site components |
| `src/components/booking/` | The booking flow (all client components) |
| `src/lib/booking/` | Booking domain logic — slots, holds, pricing, schema, contact |
| `src/lib/address/` | Postcode validation, service area, address formatting |
| `src/lib/google/` | Google Calendar client (server only) |
| `src/lib/email/` | Confirmation email builder and Resend transport |
| `src/lib/kv/` | Upstash Redis client |
| `scripts/` | Test resolver and a `next/server` stub, used only by `npm test` |
| `docs/` | Setup guides, roadmap, launch checklist, this file |

### Client / server boundary

Everything under `src/components/booking/` is `"use client"`. Server-only
modules (`lib/google/calendar.ts`, `lib/email/send.ts`,
`lib/address/postcodes-io.ts`, `lib/address/service-area.ts`) carry
`import "server-only"` so they cannot be pulled into a client bundle.

**No `NEXT_PUBLIC_` variable exists anywhere.** No credential, and no
service-area coordinate, reaches the browser.

### Routes

Static: `/`, `/gas-safety-certificate-wolverhampton`, `/book`, `/about`,
`/contact`, `/privacy`, `/terms`, plus `robots.txt`, `sitemap.xml`,
`icon.svg`, `opengraph-image` and a 404.

Dynamic API: `/api/availability`, `/api/hold`, `/api/hold/release`,
`/api/book`, `/api/address/postcode`.

### Shared libraries worth knowing

- `src/lib/business.ts` — every business fact, mirroring
  `docs/business-details.md`. **Change a price or phone number here, nowhere
  else.**
- `src/lib/booking/config.ts` — every booking rule in one object
- `src/lib/booking/time.ts` — Europe/London handling built on `Intl`, no date library
- `src/lib/address/format.ts` — **the single address formatter**
- `src/lib/booking/contact.ts` — **the single phone and email implementation**

---

## 3. The booking flow, end to end

Four steps at `/book`, driven by `BookingFlow.tsx` and a pure reducer in
`lib/booking/attempt.ts`.

1. **Date** — a BSCJ-designed calendar. Availability comes from
   `/api/availability`, which reads Google Calendar free/busy and subtracts
   busy periods, buffers, the 12-hour minimum notice and the daily cap.
2. **Time** — real slots for the chosen date.
3. **Reservation** — choosing a time calls `/api/hold`, which takes a
   **30-minute Redis hold** (`SET NX EX 1800`). A `ReservationBar` then shows
   the date, time range and a live countdown for the rest of the attempt, with
   **Change time** and **Cancel booking**.
   - *Change time* keeps the existing hold while alternatives are browsed. The
     replacement is acquired **before** the original is released, so a slot
     lost to someone else costs the customer nothing.
   - *Change date* reaches the date picker with the reservation intact and its
     countdown running on. The reservation bar, including **Keep this time**,
     stays on screen throughout. Choosing a date holds nothing new; only
     choosing a *time* acquires, and it acquires before it releases.
   - *Cancel booking* confirms, releases the hold and resets.
   - Leaving the page fires a best-effort `sendBeacon` release; correctness
     relies on the TTL, never on that.
4. **Details** — name, email, mobile, postcode, address, customer type,
   appliance count, optional tenant contact and access notes.
   - **Postcode first.** `/api/address/postcode` validates it via Postcodes.io
     and returns the canonical postcode, the town and whether it is covered —
     and nothing else. Coordinates and the measured distance stay server-side.
   - **Service area** is decided by distance (§7). Address fields only appear
     once the postcode is valid and in area.
   - **House number/name and street** are typed manually. The town comes from
     the postcode.
   - Phone and email are validated by the shared implementation (§8).
5. **Review & Confirm** — the full address is shown as its own prominent
   block, with appointment, contact, service, appliances, total and payment
   timing. An **unticked** confirmation is required:
   *"I confirm that the property address and booking details shown above are
   correct."* Confirm is disabled until it is ticked, and any edit clears it.
6. **Booking** — `/api/book` runs, in order:
   validate → completed-attempt check → hold check → postcode re-validation →
   service-area re-check → **Google free/busy re-query** → **create the
   calendar event** → mark completed → release hold → derive the booking
   reference → render and attempt the confirmation email → respond.
7. **Confirmation page** — "You're booked", then a prominent panel confirming
   the email was sent with **Junk/Spam guidance**, then the appointment
   details and the booking reference (`BSCJ-XXXXXX`).

---

## 4. Critical invariants — do not break these

These are enforced by code and covered by tests. Any future change must
preserve every one.

1. **At most one active hold per booking attempt.** Never two.
2. **When switching slots, the replacement is acquired before the original is
   released.** A failed switch must leave the original reservation intact.
   This holds whether the alternative is on the same date or another one.
3. **Hold expiry returns the customer to time selection and never books.**
   The Redis TTL is authoritative; the on-screen countdown is display only and
   must never reset when moving between steps — the date step included.
4. **Google free/busy is re-queried immediately before the event is written.**
   This check is never skipped, shortened or made conditional.
5. **One successful booking produces exactly one calendar event.**
6. **One booking reference per booking**, derived once and shared by the
   confirmation page, the email and the provider idempotency key.
7. **At most one confirmation email.** A repeat submission is recognised by
   the completed-attempt marker *before* the hold is examined.
8. **An email failure never invalidates a confirmed booking.** The transport
   never throws; failure becomes an amber notice on a confirmed booking, never
   a red failure state, and never causes a retry of the calendar write.
9. **Pricing is always derived server-side** by `calculatePrice`. A price sent
   by the browser is ignored.
10. **Browser values are never authoritative.** The postcode, service area,
    phone, email and address confirmation are all re-established or re-checked
    on the server.

Infrastructure failure is never read as permission. If Redis cannot be
reached, holds report *unavailable* — never *free* — and booking falls back to
first-confirmed-wins, decided by Google.

---

## 5. External services

| Service | Purpose | Setup guide |
| --- | --- | --- |
| **Google Calendar** | Source of availability and destination for confirmed bookings. Service-account JWT signed with `node:crypto`; no Google SDK. Reads free/busy only — event titles are never exposed. | `docs/GOOGLE_CALENDAR_SETUP.md` |
| **Upstash Redis** | 30-minute holds, completed-booking markers, distributed rate limiting, postcode cache. Reached over its REST API with `fetch`. | `docs/REDIS_SETUP.md` |
| **Resend** | Transactional confirmation email. Plain `fetch`, with `Idempotency-Key`. | `docs/EMAIL_SETUP.md` |
| **Postcodes.io** | Postcode validation and coordinates. Free, open, **no account or key**. | `docs/ADDRESS_VALIDATION.md` |

All four are configured and working locally. The Google and Resend guides
contain DNS instructions that must **not** disturb the existing Google
Workspace MX records.

---

## 6. Environment variables

**Names and purposes only. Never record values in any tracked file.**

| Name | Purpose |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Identity the calendar is shared with |
| `GOOGLE_PRIVATE_KEY` | Signs the service-account JWT |
| `GOOGLE_CALENDAR_ID` | Which calendar to read and write |
| `UPSTASH_REDIS_REST_URL` | Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Redis REST credential |
| `RESEND_API_KEY` | Sends the confirmation email |
| `BOOKING_EMAIL_FROM` | Sender identity |
| `BOOKING_EMAIL_REPLY_TO` | Optional; defaults to the booking inbox |
| `SERVICE_AREA_LAT` | Operating-centre latitude |
| `SERVICE_AREA_LNG` | Operating-centre longitude |
| `SERVICE_AREA_RADIUS_MILES` | Coverage radius; defaults to `12` |

All server-side. `.env.local` holds them locally and is git-ignored. None has
been added to Vercel yet.

The service-area variables have safe in-code defaults, so the application runs
without them; the others degrade gracefully (see §4).

---

## 7. Address and service area

### OpenStreetMap / Nominatim verification has been REMOVED

An earlier milestone added a Nominatim check to gauge whether a property
existed. **It was removed in `3b3b7d7` and must not be reinstated without a
much better reason than existed before.**

Why it went: OpenStreetMap tags street *segments* rather than properties, so
querying a real address returned neighbouring postcodes and no house number.
It rarely holds house numbers at all, and omits new builds, flats and private
roads. Almost every genuine address graded as "could not confirm", so the
check added a step to the form without adding information.

Removed with it: the match grading, the 30-day verdict cache, the global
one-request-per-second gate, the server-side attestation record, the
`/api/address/verify` route, the confirmation panel and its attribution.

### What happens now

- **Postcodes.io validates the postcode** — a hard check. It establishes that
  the postcode is live and where it is. **It does not establish that a house
  exists at it, and the site never implies it does.**
- **House number/name and street are typed manually.** The town is derived
  from the postcode.
- **One canonical formatter** (`lib/address/format.ts`) produces the address
  for the review screen, the calendar event, the confirmation page and the
  email. No surface reconstructs an address itself.
- **The customer confirms the assembled address** on Review & Confirm. That is
  the only reliable check on the property, and it is required.

### The 12-mile radius

Coverage is a **straight-line 12-mile radius** from a configured operating
centre, using a tested haversine calculation in `lib/address/geo.ts` against
the coordinates Postcodes.io returns.

This replaced a list of postcode districts, which was never a sensible proxy
for travel. The origin is stored **only as coordinates**, rounded to about a
100-metre grid and deliberately offset so it identifies no building. **No
street name or personal postcode appears anywhere in the repository**, and the
coordinates never reach the browser.

**This is a straight-line radius, not a driving distance and not a travel
time.** Never advertise a journey time based on it.

### What the radius reaches — RESOLVED 22 August 2026

Measured from the configured centre:

| Place | Distance | Covered | Advertised |
| --- | --- | --- | --- |
| Wolverhampton | 0.9 mi | yes | yes |
| Wednesfield | 2.8 mi | yes | yes |
| Codsall | 3.2 mi | yes | yes |
| Bilston | 3.6 mi | yes | yes |
| Willenhall | 3.8 mi | yes | yes |
| Dudley | 6.3 mi | yes | yes |
| Walsall | 6.9 mi | yes | yes |
| West Bromwich | 8.2 mi | yes | yes |
| Cannock | 8.3 mi | yes | yes |
| Stourbridge | 9.5 mi | yes | yes |
| Bridgnorth | 12.2 mi | no | no |
| Birmingham | 13.0 mi | no | no |
| Telford | 13.9 mi | no | no |
| Stafford | 14.7 mi | no | no |
| Kidderminster | 14.9 mi | no | no |

**Owner's decision: keep the 12 mile radius and widen the copy to match it.**
The radius was not reduced. All ten covered towns are now named in the public
copy, in `business-details.md` and in `areaServed` structured data — as
*indicative* only, since eligibility is decided from the postcode at booking and
BSCJ has no premises in any of them.

Public positioning is "serves Wolverhampton and surrounding areas within our
standard service area", paired with "enter your postcode when booking to
confirm whether your property is within our standard online booking area".

A property outside the radius is never told we do not serve it — work beyond the
standard online area may still be accepted by arrangement, so the wording offers
the phone and WhatsApp instead.

---

## 8. Contact validation

One implementation in `lib/booking/contact.ts`, used by the form, the Zod
schema and the booking route, so client and server cannot disagree.

**Mobile.** The field shows a fixed `+44` prefix, so nobody types a country
code. Accepted: spaces, brackets, dashes, a leading zero, a pasted `+44`,
`0044`, a bare `44`, or none of these. Every accepted form is stored as
**`+447XXXXXXXXX`**. Rejected: too short, too long, letters, and landlines —
the field asks for a mobile because the engineer needs to reach someone on the
day. Failure reasons are specific enough to explain in plain English.

**Tenant phone** follows exactly the same rules when supplied, and blank
remains valid because it is optional.

**Email** is trimmed, lowercased and shape-checked only. Nothing queries a
mailbox, probes SMTP, sends a verification message or calls a paid API — the
aim is to catch a typo, not to prove an address receives mail.

---

## 9. Pricing and commercial rules

From `business-details.md` via `lib/business.ts`:

- **CP12: £45 total.** Covers one boiler plus two appliances.
- **Each additional appliance: £15.** So 4 appliances is £60, 5 is £75.
- Presented publicly as **"£45 total"**. **No VAT wording anywhere** — the
  price is VAT-inclusive internally, but that is marked INTERNAL ONLY in
  `business-details.md` and must not be published without an explicit
  instruction.
- **Pay after completion.** No deposit, no card details at booking.
- Appointments are 45 minutes with a 15-minute buffer, 12 hours' minimum
  notice, up to 30 days ahead, maximum 8 per day.

**Cancellation and rescheduling as currently agreed:**

- **Free rescheduling**, arranged by contacting the business.
- **Failed access:** the intent is *not* to charge the £45 automatically.
  Offer **one free reschedule**, with the customer responsible for arranging
  access next time. Repeated failures should require contacting the business
  rather than escalating financial penalties.
- **No £5 cancellation charge is implemented, deliberately.** See §11.

None of the failed-access or reschedule policy is written into customer-facing
terms yet — that is the outstanding milestone.

---

## 10. Email system

Resend, called with plain `fetch` rather than the SDK (its dependencies cover
inbound parsing and webhooks, neither of which this project uses; auth is a
single bearer header).

- **Attempted only after the calendar event exists.** The transport never
  throws; every failure is a returned value.
- **Idempotency:** `Idempotency-Key: booking-confirmation-BSCJ-XXXXXX`, derived
  from the booking reference, never the customer's email.
- **Sender** from `BOOKING_EMAIL_FROM`; **reply-to** from
  `BOOKING_EMAIL_REPLY_TO`, defaulting to the booking inbox.
- **HTML** is table-based with inline styles for desktop, plus one
  `@media (max-width: 600px)` block that tightens padding and stacks the
  contact buttons on phones. Outlook desktop ignores the media query and
  renders the inline desktop values, which is intentional.
- **Full plain-text alternative** carrying every essential detail.
- **Junk/Spam guidance lives on the website confirmation page, not in the
  email** — the reader has already found the email.
- **On failure:** the booking stays confirmed and the page shows an amber
  notice, never a red failure. Logs record a failure category and the
  reference only — never the key, the payload or the customer.

Do not redesign the email without a reason; the owner has reviewed and
approved its appearance on desktop and mobile.

---

## 11. Legal and terms work still outstanding

**The Terms & Conditions milestone is NOT complete.** `/terms` currently holds
an earlier, basic page that predates this research and does not implement what
follows.

> **Live and adverse.** Clause 4 of that page states that appointments *cannot
> be cancelled* inside the 48-hour window. As written that purports to remove
> the statutory 14-day distance-selling cancellation right, which CRA 2015 s57
> does not permit. It was left in place deliberately — correcting it properly is
> the terms milestone's job, not a patch — but the site **must not be published
> while it stands**. Clause 7 was reworded on 22 August 2026 for service-area
> accuracy only; no other clause was touched.

Research completed 21 August 2026:

- **Consumer Contracts (Information, Cancellation and Additional Charges)
  Regulations 2013, reg 30** — an online booking is a distance service
  contract with a **14-day cancellation period** from the day after the
  contract is made.
- **Reg 36(1)** — a trader must not begin supplying the service during that
  period without the consumer's **express request**.
- **Reg 36(2)** — the right to cancel is lost once the service is **fully
  performed**, but only if performance began after that express request **and**
  the consumer **acknowledged they would lose the right**.
- **Reg 36(4)/(6)** — cancel part-way and the consumer pays a proportionate
  amount; but if the express request or the required information was missing,
  **the consumer pays nothing**.

**Why this matters commercially.** Bookings are taken up to 30 days ahead with
12 hours' notice, so most CP12s are performed inside the 14-day window.
Without a separate express request and acknowledgement at checkout, a customer
could have the certificate done and cancel within 14 days owing nothing. This
is the single most important thing the terms milestone must deliver, and it
must be its **own clearly presented, unticked confirmation** — not buried in
general terms.

- **Consumer Rights Act 2015 s49, s51, s52** — reasonable care and skill,
  reasonable price, reasonable time. **s57 — these cannot be excluded or
  restricted.** The terms must not attempt to.
- **CMA unfair contract terms guidance (CMA37)** — a cancellation charge must
  reflect **actual direct loss**, must not be excessive, and the calculation
  must be set out clearly. Flat penalties that ignore savings and resale are
  likely unfair and unenforceable.

**The proposed £5 late-cancellation charge was deliberately not implemented**,
for three independent reasons: it is not a genuine pre-estimate of loss for a
resellable 45-minute slot; most cancellations fall inside the statutory window
where an unperformed service costs the consumer nothing; and there is no
payment method on file, so collecting £5 would cost more than £5. Launch
without it and revisit only with evidence of actual loss.

> **This research is not legal advice.** A solicitor should review the final
> wording before the business relies on it, particularly the reg 36
> acknowledgement.

Sources, accessed 21 August 2026:
- https://www.legislation.gov.uk/uksi/2013/3134/regulation/36/made
- https://www.legislation.gov.uk/uksi/2013/3134/regulation/30
- https://www.legislation.gov.uk/ukpga/2015/15/part/1/chapter/4
- https://assets.publishing.service.gov.uk/media/6a609329b00f3323bf1a23f3/unfair_contract_terms_guidance.pdf

---

## 12. Testing

**389 tests across 64 suites, all passing.**

Covered: the availability engine (working hours, buffers, minimum notice,
BST/GMT, daily cap), holds (exclusivity, expiry, switching, forged and
wrong-slot tokens, outage behaviour, distributed rate limiting), the attempt
reducer (navigation never disturbs a reservation), the booking route's
transaction order against the real handler, the Google client's fail-closed
free/busy parsing, the email builder and transport, the confirmation notice,
postcode normalisation and lookup, the haversine calculation and radius
boundaries, phone and email validation, the minimised postcode API response,
the Change-date state model, and repository-level public-content rules (no
engineer name, no VAT wording, no invented ratings, no promised journey time,
and never telling a customer we do not serve them).

```bash
npm test        # node --test, TypeScript run directly
npm run typecheck
npm run lint
npm run build
```

**No automated test may contact an external provider.** Google, Redis, Resend
and Postcodes.io are all replaced by fakes or module mocks. This is a hard
rule: these are free or metered services and the suite runs hundreds of times.
Live checks during development should be few and deliberate.

---

## 13. Git state

- Branch: **`main`**
- Working tree: **clean**
- In sync with `origin/main` — nothing ahead, nothing behind

Recent commits:

```
(this milestone)  Fix Change date, minimise the postcode response, widen the service area
569f605  Add a project handoff for a fresh session
3b3b7d7  Simplify address handling and replace the service area with a radius
7408c37  Validate property addresses with free postcode and map data
723724a  Make the confirmation email responsive and flag Junk/Spam on the success page
41e78ed  Send a branded booking confirmation email after the appointment is written
c36b1d5  Own the reservation at the attempt level, with an explicit Change time
6083e21  Reserve a chosen appointment for 30 minutes while the customer books
```

No credential value appears in any tracked file. `.env.local` is git-ignored
and untracked.

---

## 14. Completed milestones — do not rebuild

1. **Marketing site** — seven pages, technical SEO, structured data, mobile
   nav, OG image. No invented reviews, ratings or accreditations anywhere.
2. **Branded booking UI** — a BSCJ date and time picker replacing an embedded
   Google Calendar iframe.
3. **Google Calendar integration** — service-account JWT signed with
   `node:crypto`, free/busy reads, event creation, deterministic event ids.
   Later hardened: free/busy parsing fails closed, JWT tolerates clock skew.
4. **Upstash Redis 30-minute holds** — atomic acquisition, distributed rate
   limiting, graceful degradation.
5. **Hold lifecycle fix** — the reservation belongs to the booking attempt
   rather than a UI step; explicit Change time; replacement acquired before
   release.
6. **Resend confirmation email** — branded, idempotent, never able to fail a
   booking.
7. **Responsive email and Junk/Spam reminder** — mobile refinements with
   desktop unchanged; prominent confirmation panel on the success page.
8. **Postcode validation** via Postcodes.io, with canonical formatting.
9. **Service-area radius** replacing the district whitelist.
10. **Contact validation** — one shared phone and email implementation.
11. **Simplified manual address flow** — OSM verification removed, customer
    confirmation required.
12. **Pre-terms correction milestone (22 August 2026)** — "Change date" now
    reaches the date picker with the reservation intact; the postcode endpoint
    returns only what the form renders; dead address-verification config
    removed; the 12 mile radius kept and the public copy widened to match it;
    the engineer's personal name removed from every customer-facing surface;
    stale documentation corrected.

---

## 15. Outstanding pre-launch work, in order

1. **Terms & Conditions / consumer-rights milestone** (§11) — the next task,
   and the only remaining blocker that is not deployment mechanics.
2. ~~Service-area marketing-copy decision~~ — **resolved 22 August 2026** (§7).
3. **Final integrated security and release audit.**
4. **Vercel production setup.**
5. **Add environment variables in Vercel** (§6) and redeploy — variables only
   take effect on a new deployment.
6. **Deploy.**
7. **Connect the domain** — the DNS change must not disturb the existing
   Google Workspace MX records. Send and receive a test email afterwards.
8. **One real production booking**, verified end to end, then cancelled so it
   does not block a slot.
9. **Live launch checks** — see `LAUNCH_CHECKLIST.md`.

---

## 16. Known risks and open decisions

- **Reg 36 express request** (§11) — the largest commercial exposure until the
  terms milestone lands. The live `/terms` clause 4 also states that
  appointments cannot be cancelled inside 48 hours, which as written purports to
  exclude a statutory right. Deliberately left for that milestone; **do not
  launch on the current terms**.
- **Rate limiting is per-window in Redis**, falling back to per-instance
  counting during an outage — weaker, but it still limits.
- **No server-side observability.** Nothing is logged beyond email failure
  categories, so an outage is visible only through fallback UI. Worth adding.
- **`GOOGLE_PRIVATE_KEY` in Vercel** is the most likely deployment failure:
  wrapping quotes or mangled `\n` sequences break signing. Symptom is the
  booking fallback screen.
- **No Google Business Profile yet** — the biggest local-SEO gap.
- **No reviews yet**, so no review markup. Do not add either until genuine
  reviews exist.
- **`src/components/BookingEmbed.tsx` is dead code**, retained as a marked
  rollback to the old iframe. Delete it once a real production booking has
  succeeded.

---

## 17. DO NOT REGRESS / DO NOT REBUILD

**Read §4 before touching the booking path.** The invariants there were each
established by fixing a real defect and are covered by tests.

Specifically:

- **Do not reinstate Nominatim or any OpenStreetMap property verification.**
  It was removed for good, evidenced reasons (§7).
- **Do not rebuild the booking UI, the hold system, the calendar integration
  or the confirmation email.** They are complete, tested and owner-approved.
- **Do not redesign the confirmation email**, on desktop or mobile.
- **Do not weaken or delete existing tests to make a change pass.**
- **Do not reintroduce a private residential address** into code, tests,
  fixtures, comments or docs. Test data uses unallocated `WV99` postcodes and
  `24 Example Road`. A previous real address was purged from 96 places; do not
  undo that.
- **Do not put the service-area origin in client code**, and never record it
  as a street name. **Do not return coordinates or a measured distance from
  `/api/address/postcode`** — a distance is enough to triangulate the centre.
- **Do not publish the engineer's personal name.** It is not in
  `src/lib/business.ts` at all, it is INTERNAL ONLY in `business-details.md`,
  and `src/lib/public-content.test.ts` fails the build if it reappears under
  `src/`. Describe work at business level, or as "a Gas Safe registered
  engineer". Do not invent a different person's name either.
- **Do not present a covered town as a guarantee**, and do not claim premises
  in any town other than the registered office.
- **Do not advertise a journey time** off the back of the radius; it is
  straight-line distance, not road routing.
- **Do not make "Change date" drop the reservation.** Reaching the date step
  with a live hold is a change in progress: the hold, its countdown and the
  "Keep this time" escape all stay.
- **Do not add VAT wording** to any customer-facing surface.
- **Do not invent business facts.** If something is not in
  `business-details.md`, ask rather than guess — no invented reviews, ratings,
  guarantees, accreditations or response times.
- **Do not let automated tests call external providers.**
- **Do not add a database, customer accounts, an admin dashboard or a
  portfolio system.** Those are Version 2+; see `PRODUCT_ROADMAP.md`.

---

## 18. Deployment status

**The application has never been intentionally deployed or launched from this
workflow.** There is no production environment, no Vercel project configured
with these variables, and the domain is not pointed anywhere.

The code runs locally against **live** Google Calendar, Upstash Redis and
Resend accounts, and real end-to-end bookings and emails have been created and
then cleaned up during testing.

Every previous session ended with an explicit instruction not to deploy.
**Do not deploy without being asked to.**

---

## 19. Recommended first task for the next session

**The Terms & Conditions / consumer-rights milestone.** Unchanged: it is still
the next task, and the pre-terms correction milestone of 22 August 2026
deliberately did not start any part of it.

The technical booking work is done. What remains before launch is legal and
commercial, and §11 has the research already completed.

That milestone should deliver:

1. A clear, readable `/terms` page written for a landlord or homeowner, not a
   lawyer — covering the business and legal entity, what the CP12 service is
   and is not, the £45 pricing logic, pay-after-completion, the customer's
   responsibility for the address and access, the one-free-reschedule
   failed-access policy, free rescheduling, cancellation and statutory rights,
   additional work not being included, safety, delays, and complaints.
2. **A separate, unticked express-request acknowledgement** on Review &
   Confirm for appointments falling inside the statutory cancellation period —
   the reg 36 point in §11. This is the commercially important part.
3. **A terms acceptance checkbox** with a link that opens the terms **without
   destroying the customer's 30-minute reservation**.
4. **Server-side enforcement** in `/api/book`, with a versioned terms
   identifier (for example `TERMS_VERSION`) recorded against the booking,
   along with acceptance and any early-performance request.
5. Tests for each of those, and no weakening of anything in §4.

Confirm the wording with the owner, and recommend a solicitor review before
the business relies on it.
