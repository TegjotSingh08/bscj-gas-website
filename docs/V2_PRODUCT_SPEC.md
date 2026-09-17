# V2 product specification

What V2 is for, who uses it, and the rules each surface obeys. The *how* is in
`V2_ARCHITECTURE.md`; the *order* is in `V2_IMPLEMENTATION_PLAN.md`; the *state
of play* is in `V2_CURRENT_STATE.md`.

Approved direction: 4 September 2026. Agent-account scope added 16 September
2026. The six open commercial decisions were resolved by BSCJ on 16 September
2026 and are recorded in the sections they affect.

---

## 1. What V2 is

V1 turns local CP12 demand into appointments. V2 keeps that, and adds a
managed compliance service sold to letting agents:

> Give us the properties. We handle tenant access, the inspection, the
> certificate, the invoice and the renewal.

The consumer booking flow is not the thing being replaced. It stays exactly as
it is, and V2 grows beside it.

## 2. The domain, in one line

```
AgentOrganisation → Landlord → Property → Tenancy
                                   ↓
                                  Job → Appointment → Engineer
                                   ↓
                      Certificate · Invoice · Remedial · Renewal
```

Every one of those is a record in Postgres. An appointment is *also* a Google
Calendar event; the calendar is where the engineer's day lives, not where the
business's memory lives.

## 3. Who uses it

| Actor | Surface | Signs in? |
| --- | --- | --- |
| Consumer | `/book` — unchanged | No |
| Letting agent | `/portal` | Yes, email + password |
| Tenant | `/schedule` | No — link or reference + postcode |
| Engineer | `/engineer` | Yes, restricted |
| BSCJ admin | `/admin` | Yes, full |

## 4. Agent accounts

An **agent organisation** is the account. It holds the company identity,
billing details, plan, negotiated pricing and remedial authority. Users belong
to it.

- One user at launch; the schema supports several from day one, so adding a
  colleague later is a row, not a migration.
- Plans exist as a field — `free_legacy`, `agent_standard`, `agent_pro`,
  `enterprise` — and **nothing branches on them yet**. There is no SaaS
  billing, no card on file and no subscription logic in V2. Platform access is
  free for BSCJ compliance customers; the field records which arrangement an
  account is on so introducing a paid plan later is a permission check rather
  than a schema change.
- Accounts are created by BSCJ. There is no public sign-up page in V2.

## 5. Portfolio

An agent can add landlords, add properties under a new or existing landlord,
and record tenant details when known. Properties are added one at a time in
V2.1; bulk CSV/XLSX import is V2.9 and must produce a reviewable preview
before anything is written.

Each property carries its current compliance position: the expiry of the
certificate it already holds, when known, and the next due date once BSCJ has
issued one. A property with neither is simply "not yet known" — never
"compliant" and never "overdue" by assumption.

An agent can ask for work as soon as possible instead of naming a date. That
is a **request**, recorded as such. It is never a promise of a date, and no
copy may imply one.

## 6. Services and pricing

Three products exist and are defined in code: CP12 £45, Annual Boiler Service
£60, CP12 + Annual Boiler Service £90. Those are the **published consumer list
prices** and V2 does not touch them.

Agent pricing is a separate layer:

- A **pricing agreement** belongs to an organisation and has effective dates.
- Each **line** names a product and a price, optionally with a minimum monthly
  volume that must be met for that line to apply.
- An admin may override the price on an individual job, with a reason.
- Absent an agreement, an agent pays the list price.

**Every price is resolved on the server from the agreement, never sent by a
browser** — the same rule the booking route already enforces.

Volume is tracked in three separate counts, because they answer different
questions and diverge constantly: jobs **submitted**, jobs **completed**, jobs
**invoiced**, per organisation per calendar month.

**How the tier is chosen — confirmed 16 September 2026.** The volume is
**committed in advance** for the month, from the properties or jobs the agent
commits or imports for it. It is not derived from trailing actuals. A price
that is only knowable at month end cannot be quoted before a job is submitted,
cannot be invoiced promptly, and cannot be explained to an agent who asks what
a job will cost.

The intended bands are 1-14, 15-29, 30-44, 45-59, 60-74, 75-99 and 100+. They
are the default an admin screen offers, not a rule the resolver depends on:
each agreement stores its own bounds, so the structure can change without a
migration and without re-labelling agreements signed under the old one.

**The agreed price is frozen onto the job** when the job is created. A later
renegotiation, retired agreement or list-price change cannot reach back and
re-price work already taken.

No tier figures are in this document, and none are in the code. The
75-jobs-at-£39.99 example in the brief is an illustration and has not been
entered anywhere. Real figures need owner approval — see
`V2_CURRENT_STATE.md`.

## 7. Job creation by an agent

The agent picks or adds a landlord, picks or adds a property, picks a service,
supplies or picks the tenant, gives a deadline or asks for ASAP, and submits.

On submission the system allocates:

- a **job reference** — `BSCJ-XXXXXX`, human-readable, quoted on the phone.
  **It identifies a job. It never authorises access to one.**
- a **scheduling token** — high entropy, stored only as a hash, used once to
  let a tenant in.

Submitting many properties at once must produce many durable jobs before any
email is sent. See `V2_ARCHITECTURE.md` § "External side effects".

## 8. Job workflow

**Lifecycle** — where the *work* is:

```
draft → tenant_outreach → awaiting_tenant → scheduled
      → engineer_assigned → in_progress → completed
                          ↘ remedial_required ↗
      cancelled  (an alternative ending, never a kind of completion)
```

The brief also lists *Certificate Issued* and *Invoiced*. Those are
deliberately **not** lifecycle statuses. A job is routinely completed,
certificated and invoiced at the same time, and a single enum has to pick one
of those to display, which loses the other two. They are derived:

- *Awaiting certificate* — completed, no certificate document
- *Certificate issued* — a certificate document exists
- *Invoiced* — an invoice line references the job

The agent dashboard still shows them as stages. It just computes them rather
than storing a status that can contradict the documents themselves.

**Deadline risk** is a separate, computed value: `normal`, `approaching`,
`urgent`, `overdue`, from the requested completion date and the configured
warning windows. It is orthogonal — a job can be overdue *and* scheduled *and*
invoiced at once.

## 9. Tenant scheduling

The tenant has no account and never will.

**Two ways in:**

- **A.** A secure invitation URL carrying a high-entropy token.
- **B.** Job reference plus the property postcode.

Method B must normalise the postcode, require both values to match the same
job, be rate-limited per IP and per reference, and return one generic failure
message for every kind of failure — wrong reference, wrong postcode, expired,
already used. A distinguishable error message turns a reference into a probe.

**The tenant sees only:** the property, what the appointment is for, who asked
for it where that is appropriate, the available dates and times, and their
confirmation.

**The tenant never sees and never reaches:** any price, any payment, any
other property, any other tenant, the agent's account, or the consumer booking
flow. The scheduling surface has its own layout with no site navigation, is
`noindex`, and its session cookie is scoped to `/schedule` so it cannot be
presented anywhere else.

The tenant cannot change the service, the property or anything else about the
job. They pick a time. That is the whole permission.

Availability comes from the existing V1 engine and the existing 30-minute
Redis holds. Nothing about slot generation, buffers, the daily cap or the
pre-write recheck is reimplemented.

## 10. Tenant outreach

Designed now, mostly built in V2.7:

- an initial invitation when the job is created
- reminders on a configurable schedule while the job stays `awaiting_tenant`
- escalation when the tenant does not respond — the job surfaces to the agent
  and to BSCJ as needing attention
- every attempt is recorded and visible to the agent and to admin

Email only in V2. SMS is designed for — every attempt is a row with a channel
— but no SMS provider is integrated, and none should be added until BSCJ asks.

## 11. Agent dashboard

Operational, not decorative. It opens on what needs doing:

- **Needs attention** — no tenant response, deadline at risk, remedial awaiting
  approval, anything failed
- **Upcoming deadlines**
- **Awaiting tenant** · **Scheduled** · **Completed**
- **Urgent / overdue**
- Search and filter across jobs and properties

Every property and every job opens to its full history, its documents and its
current status.

## 12. Engineer workflow

A deliberately small surface. The engineer sees today's assigned jobs and,
for each: the property and address, how to get in and who to contact, the
service, the notes, tap-to-navigate and tap-to-call, the certificate form,
somewhere to record remedial findings, and a way to mark the job done.

The engineer does not get admin. No pricing, no agent billing, no other
agents' portfolios, no settings.

## 13. Remedial work

Each account carries an **authorised remedial spend threshold**: £0, a
configured amount, or a per-job custom amount. £0 — nothing without asking —
is the safe default.

Where it is safe, practical and within authority, a minor remedial can be
carried out and recorded during the visit.

Where the work exceeds authority, or cannot safely be done there and then:

- the issue is recorded, with notes and photographs
- a price or estimate is attached
- the agent is asked to approve
- the approval, and any follow-up work, are tracked against the same property

**No part of this may promise that a failed inspection can always be made
compliant.** Some cannot. The system records what was found and what was
authorised; it does not guarantee an outcome.

## 14. Certificates

BSCJ already has a working CP12 generator and it is **not being rebuilt**. See
`V2_ARCHITECTURE.md` § "The certificate generator" for how it is integrated.

What matters at the product level:

- Everything already known is pre-filled: property, landlord, agent, dates,
  BSCJ and engineer details.
- The engineer enters only what an inspection produces: appliances, readings,
  results, defects and notes.
- The issued certificate is stored against the job and is visible to the agent.
- **An issued safety record is never silently editable.** A correction
  produces a new version, the superseded version is retained, and who changed
  what and when is recorded. Anything else is a falsifiable safety document.

## 15. Invoices

A branded BSCJ invoice, populated from what the system already knows, reviewed
and adjusted by an admin before it is issued, then frozen.

**Numbering — confirmed 16 September 2026.** V2 runs its own series,
`BSCJ-001000` upwards, allocated from a Postgres sequence so two invoices can
never share a number. It starts at 1000 rather than at 1 so the first invoice
is not obviously the first — a number counting from one tells whoever holds it
how much work BSCJ has invoiced. The standalone generator's hand-maintained `D-…` series
is **not** continued: two systems incrementing one series is how that happens.
Gaps are expected — a sequence value drawn by a transaction that rolls back is
never reused — and are not a fault.

**VAT — confirmed 16 September 2026.** BSCJ is **not** VAT registered. VAT is
modelled in full and switched off: no VAT line, no VAT number and no mention of
VAT appears on anything. A half-configured VAT setting reads as *not
registered*, so the ambiguous case is the safe one. Registering later is a
settings change and a rate, never a redesign.

**Identity — confirmed 16 September 2026.** The trading name, the legal entity,
the company number, the address, the contact details, the footer wording and
the VAT position are all **configuration**. Nothing about who BSCJ is appears
in code. The legal arrangement is changing — BSCJ Solutions is expected to be
incorporated around 4–5 October 2026 — so each invoice **snapshots** the
identity in force when it was issued. An invoice must not silently start
claiming to have been issued by a company that did not exist on its date.

An invoice cannot be issued while any required identity or terms field is
empty. There is no placeholder and no fallback.

Two shapes, and the data model must support both from the start:

- **Per job** — one job, one invoice
- **Consolidated monthly** — one invoice for an organisation, many jobs

The issued PDF is available in the agent portal and can be emailed.

An issued invoice is immutable. Correcting one is a credit note and a new
invoice, not an edit.

## 16. Communications

Job-level messages and an activity timeline, in the portal, so a conversation
about a job lives with the job rather than in somebody's inbox.

**The engineer's personal number is never exposed**, consistent with the
existing rule that the engineer's name never appears customer-facing. BSCJ's
business phone and WhatsApp remain published for anything urgent.

## 17. Admin portal

BSCJ controls everything: agents, landlords, properties, tenants, jobs,
engineers, the calendar, pricing, certificates, invoices, renewals, messages,
remedials and the audit log.

An admin can **view the portal as an agent** for support. Doing so is recorded
as an audited event with a start and an end, and every action taken while
viewing-as records both the real admin and the agent being impersonated.

## 18. Compliance and renewal engine

The point of the whole product.

When a completed job establishes the next compliance cycle:

- the next due date is stored against the property
- it surfaces on the dashboard as it approaches, on configurable windows
- the next job is created and its outreach begins
- every previous certificate and job is retained

**The rule, confirmed by BSCJ on 16 September 2026:**

> next due date = inspection date + 12 months − 1 day

This is what the existing certificate generator already does. It lives in
exactly one place, `lib/compliance/renewal.ts`, because a second implementation
is how a certificate and a reminder end up disagreeing by a day — and a day
matters when the question is whether a property was legally certificated.

The interval is a named constant, not a number scattered through the code, so
changing it is one line and a test run rather than an audit.

## 19. Activity and audit

Every job and property carries a timeline: created, tenant invited, reminder
sent, appointment selected, engineer assigned, inspection started, inspection
completed, remedial recorded, certificate issued, invoice generated, renewal
created.

Security-sensitive actions are separately auditable: sign-ins, permission
changes, pricing changes, impersonation, document access, certificate
correction.

## 20. What V2 is not

- Not a payment platform. No card processing, no SaaS subscriptions.
- Not an SMS platform. Designed for; not integrated.
- Not a rewrite of the consumer booking flow.
- Not a replacement for Google Calendar as the engineer's diary.
- Not a public agent sign-up product. Accounts are opened by BSCJ.
