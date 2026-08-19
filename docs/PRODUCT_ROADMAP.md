# Product Roadmap

The agreed product direction for BSCJ Gas & Heating. This is the permanent
record — it is not a wish list, and it is not a to-do list for the current
build. Nothing below Version 1 is to be implemented until the version it sits
under is explicitly started.

Agreed 19 August 2026.

Related documents:

- `business-details.md` — the source of truth for current business facts
- `LAUNCH_CHECKLIST.md` — what stands between here and going live
- `PHASE_2.md` — the near-term backlog behind Version 1.1
- `GOOGLE_CALENDAR_SETUP.md` — the Google configuration Version 1 depends on

---

## Version 1 — Launch now

**Primary objective:** make BSCJ the easiest credible local CP12 service to
understand and book.

The product is deliberately narrow. It does one thing well: it turns local CP12
demand into confirmed appointments in the engineer's diary.

**Scope**

- Fixed-price £45 CP12 booking in Wolverhampton
- Fully BSCJ-branded slot picker — no third-party booking interface
- Availability derived from the engineer's real Google Calendar
- Customer chooses the date and time
- Customer provides property and contact details
- Server rechecks availability before the booking is written
- Confirmed booking written directly into the engineer's Google Calendar
- Pay after completion

**Explicitly out of scope for Version 1**

- No custom database
- No customer accounts
- No admin dashboard
- No iframe booking interface

The Google appointment-schedule page is retained **only** as an emergency
fallback, shown when live availability cannot be loaded. It is not the booking
experience.

---

## Version 1.1 — Immediately after launch

Small additions that make the launched product measurable and complete. None of
these justify delaying Version 1.

- Customer booking-confirmation email
- Analytics
- Google Search Console
- Google Business Profile integration
- Conversion tracking
- Real customer reviews
- Booking and cancellation instructions

**On the confirmation email:** do not overengineer it. Use the simplest secure
production method that reliably delivers. It is one transactional message, not
a messaging platform.

---

## Version 2 — Managed landlord / letting-agent service

**Commercial proposition:**

> "Give us the properties. We manage the gas-safety scheduling for you."

This is where the business stops competing on price alone. BSCJ handles the
operational process rather than making the agent coordinate appointments.

### What the system should eventually support

- Landlords
- Letting agents
- Property portfolios
- Individual properties
- CP12 due dates
- Tenant contact details
- Booking status
- Certificate status
- Renewal dates

### Target workflow

```
Agent or landlord provides portfolio
  → BSCJ records properties and CP12 renewal dates
  → system identifies certificates becoming due
  → BSCJ contacts the tenant
  → tenant receives a private scheduling link
  → tenant selects a suitable BSCJ appointment
  → appointment enters the engineer's calendar
  → engineer completes the CP12
  → certificate returned to landlord or agent
  → next renewal automatically tracked
```

### Private tenant scheduling links

Future URLs should support a secure opaque token, conceptually:

```
/schedule/[secure-token]
```

**The tenant should see only:**

- Property address, or other appropriate identifying information
- Reason for the appointment
- Available dates and times
- Contact and help information

**The tenant must not see:**

- Landlord pricing
- Portfolio data
- Other tenants
- Other properties
- Internal account information

The existing custom BSCJ slot picker should be **reused** for this tenant flow
rather than rebuilt. It was written with that reuse in mind.

### Portfolio pricing

**Do not publish pricing tiers yet.**

The future system should support volume pricing based on completed or committed
monthly CP12 volume. A possible structure, for later commercial review only:

- Standard retail rate
- Small portfolio rate
- Medium portfolio rate
- Large agent or bespoke rate

Discounts must be based on economically meaningful committed or completed
volume — **not** on properties merely promised.

**Final prices require owner approval before implementation.**

---

## Version 3 — Portfolio management

A potential agent-facing dashboard covering:

- Property list
- CP12 due date
- Tenant-contact status
- Scheduling status
- Appointment date
- Completion status
- Certificate status
- Next renewal
- Invoices

### Example status lifecycle

```
Due soon
  → Tenant contact required
  → Tenant contacted
  → Awaiting tenant selection
  → Booked
  → Engineer attended
  → Completed
  → Certificate issued
  → Renewal scheduled
```

---

## The future differentiator

The strategic differentiator is **not** simply cheap CP12s. Price is easy to
copy. The differentiator is:

> BSCJ manages access and compliance administration for the landlord or agent.

Potential future positioning:

> "Stop chasing tenants for gas certificates. Send us your properties and we
> handle the scheduling, tenant coordination, CP12 completion and renewal
> tracking."

---

## Explicitly deferred

Do not currently build any of the following:

- Portfolio database
- Landlord dashboard
- Letting-agent dashboard
- Tenant messaging automation
- Certificate vault
- Renewal engine
- CRM
- Multi-engineer routing
- AI phone receptionist
- Live engineer tracking

**Version 1 must launch and process real bookings first.**
