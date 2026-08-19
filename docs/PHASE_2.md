# Phase 2 Backlog

Deliberately **not** built in Version 1. Version 1 does one thing: turn local
CP12 demand into booked jobs. Everything below is worth doing later, ranked
roughly by return on effort.

---

## Tier 1 — highest return, lowest effort

### Google Business Profile
Not a code change, but the biggest single local-SEO gain available. Competitor
research shows the map pack sits above organic results for "gas safety
certificate Wolverhampton". Without a profile, the site cannot appear there.

### Genuine reviews, then review markup
Every competitor with strong conversion leads with reviews. BSCJ has none yet,
so none are shown. Once real reviews exist: display them, and add `Review` /
`AggregateRating` structured data. **Never before.**

### Real photography
`assets/` is empty. A photo of the engineer, the van, and a certificate being
handed over would lift trust more than any copy change. Avoid stock imagery.

### Annual renewal reminders
A CP12 is legally an annual job, so every customer is a guaranteed repeat lead
12 months later. Even a manual calendar reminder plus an email template would
capture most of the value. Competitors advertise this; none do it well.

---

## Tier 2 — genuine growth work

### More service pages
Only where the page can genuinely satisfy a different search intent — not
doorway pages. In rough priority order:
- `/landlord-gas-safety-certificate-wolverhampton`
- `/boiler-service-wolverhampton`
- `/gas-engineer-wolverhampton`
- `/boiler-repair-wolverhampton`

### Genuine location pages
`/gas-safety-certificate-bilston`, `-wednesfield`, `-willenhall`. Each must have
real local content, not a find-and-replace of the Wolverhampton page. Research
flagged thin duplicated location pages as a competitor weakness worth avoiding.

### Estate agent / letting agent landing page
Agents book in volume and are a different buyer to a single landlord. Wants:
multi-property booking, consolidated invoicing, a named contact.

### Service bundles
Research shows competitors selling CP12 + boiler service bundles at £79–£85.
Needs a confirmed BSCJ price before it can be advertised.

---

## Tier 3 — operational automation

### Customer confirmation emails
The booking flow deliberately does **not** claim an email is sent, because the
service account cannot send Google invitations without domain-wide delegation.
Options later: enable domain-wide delegation so Google emails the invitation,
or send our own confirmation through an email service. Until then the
confirmation screen tells the customer to note the appointment down.


Worth building once booking volume makes the manual version painful.

- Automated SMS/WhatsApp booking confirmations and reminders
- "Engineer on the way" message with an ETA window
- Automated invoice generation
- Digital certificate delivery and storage
- Landlord portal: properties, certificates, renewal dates
- Multi-property booking in a single flow
- CRM for repeat customers and lapsed renewals
- Online payment (Stripe) as an option alongside pay-on-completion

## Tier 4 — only at real scale

Do not build these for one engineer.

- Multi-engineer scheduling and dispatch
- Route optimisation
- Live engineer tracking
- Custom booking backend replacing Google Calendar
- AI telephone receptionist
- Mobile app

---

## Known decisions to revisit

- **Same-day messaging** is currently Option C (phone/WhatsApp only, online
  booking keeps 12 hours' notice). See "Availability Messaging" in
  `business-details.md`. Switch to Option B if same-day online becomes viable.
- **Additional service areas** in `business-details.md` are blank. Walsall and
  Dudley appeared in competitor research and may be worth adding.
- **Booking data** currently lives only in Google Calendar. That is the right
  call for Version 1, but it is not a long-term customer record.
