# V2 architecture

The record of what V2 is built from, what it deliberately is not, and why.

Read `PROJECT_HANDOFF.md` for what the application already is, and
`V2_PRODUCT_SPEC.md` for what V2 is meant to do. `V2_CURRENT_STATE.md` says
where the work has actually got to.

Written alongside the V2.0 foundation; extended 16 September 2026 when agent
accounts entered scope, and again the same day when V2.0 was built and the six
open commercial decisions were resolved.

---

## 1. What changed, in one sentence

V1 turned demand into appointments and kept the record in Google Calendar. V2
keeps the record in Postgres, and the calendar goes back to being a calendar.

## 2. The three systems, and what each is for

| System | Owns | Never |
| --- | --- | --- |
| **Postgres** | Jobs, organisations, landlords, properties, tenancies, documents, invoices, history | Scheduling. It holds no availability logic. |
| **Google Calendar** | Availability and the engineer's day | The customer database. That was the V1 compromise. |
| **Resend** | Communication | A record. An email is not a job. |

Neither the calendar nor an inbox should ever again be the place someone looks
to answer "what did we do for this property last year".

## 3. What V1 already provides, and is reused unchanged

The single most important fact about V2 is how little of it is new. Every item
below is production code with tests, and none of it is to be reimplemented.

| Capability | Module | Reused by |
| --- | --- | --- |
| Slot generation, buffers, notice, advance window | `lib/booking/slots.ts`, `config.ts` | Tenant scheduling, admin scheduling |
| 30-minute distributed slot holds | `lib/booking/holds.ts` | Tenant scheduling |
| Redis client (Upstash REST, no pooling) | `lib/kv/store.ts` | Holds, rate limits, outreach throttles |
| Distributed rate limiting with local fallback | `lib/booking/rate-limit.ts` | Tenant verification, portal auth, public endpoints |
| Google Calendar free/busy, event writes, deterministic event ids, booking markers | `lib/google/calendar.ts` | Every appointment V2 creates |
| Daily-cap counting and the short day lock | `lib/booking/daily-limit.ts`, `slots.ts` | Any path that books a slot |
| Postcode validation and service-area radius | `lib/address/*` | Property creation, portfolio import |
| UK phone and email normalisation | `lib/booking/contact.ts` | Every contact field in the portal |
| Product registry, server-side pricing | `lib/booking/products.ts`, `pricing.ts` | The list-price floor under agent pricing |
| Branded transactional email rendering and sending | `lib/email/*` | Invitations, reminders, documents |
| Booking UI: date picker, time picker, reservation bar, step indicator | `components/booking/*` | The tenant scheduling flow |
| Scrypt password hashing at OWASP parameters | `lib/auth/password.ts` | Agent and engineer logins |
| Auth.js session handling, CSRF, cookie flags | `src/auth.ts` | Agent and engineer logins |
| Job lifecycle rules, job references | `lib/jobs/*` | Everything |
| Structural tests that stop a new page being public by accident | `lib/auth/admin-access.test.ts`, `lib/public-content.test.ts` | Every new private surface |

The tenant scheduling flow in particular is a **re-composition** of
`DatePicker`, `TimePicker`, `ReservationBar` and `StepIndicator` inside a new
layout — not a second slot picker.

## 4. Why nothing new was added to the stack

V2 adds exactly three pieces of infrastructure, and each replaces something
that would otherwise have to be built:

- **Vercel Blob (private)** — certificate and invoice PDFs. The alternative is
  storing binaries in Postgres, which is slower, more expensive and harder to
  stream.
- **Vercel Cron** — the renewal sweep, the outreach schedule, the email drain
  and the calendar-sync retry. A few idempotent HTTP endpoints on a timer.
- **Neon Postgres** — already chosen, already wired.

Deliberately **not** added, with the reason:

| Not used | Why not |
| --- | --- |
| A queue broker (SQS, QStash, BullMQ) | Four scheduled sweeps over indexed tables. The `outbound_email` table *is* the queue, and it is durable, inspectable and idempotent already. |
| A separate API service | One Next.js app already serves the public site, the API routes and the admin area. Splitting it would add a deployment and a network hop, and remove the type sharing that makes the server the only place a price is decided. |
| A second auth provider / SaaS auth | Auth.js with a credentials provider already works and the password hashing is ours. Agents are a handful of known companies, not a public sign-up funnel. |
| Prisma, or an ORM change | Drizzle is in place, produces reviewable SQL migrations, and the schema is already written against it. |
| Redis as a database | It holds holds and counters, both with TTLs. Nothing durable lives there. |
| A payments provider | V2 takes no payments. Invoices are documents. |
| An SMS provider | Designed for, not integrated. See `V2_PRODUCT_SPEC.md` § 10. |
| A background worker runtime | Cron endpoints with a shared secret do the same job with no new runtime. |

## 5. Surfaces and isolation

Four audiences, four route groups, one application:

```
src/app/
  (site)/        public marketing + consumer booking   indexed
  (portal)/      /portal      letting agents           noindex, authenticated
  (staff)/       /engineer    BSCJ engineers           noindex, authenticated
  admin/         /admin       BSCJ admin               noindex, authenticated
  (schedule)/    /schedule    tenants                  noindex, token session
  api/
```

Each group has its **own layout**. That is not cosmetic: it is what keeps the
sticky "Book your CP12" bar, the site header and the marketing JSON-LD out of
an internal tool, and keeps the portal's chrome out of the public bundle. The
existing move of the public pages into `(site)` was done for exactly this
reason and is the pattern to follow.

`sitemap.ts` lists the seven public pages explicitly and nothing else. No
private surface is ever added to it.

## 6. Authentication and authorisation

### Staff and agents — Auth.js

Auth.js (`next-auth` v5), credentials provider, JWT session. Auth.js handles
session signing, rotation, cookie flags and CSRF on the sign-in POST; the
credential check itself stays ours. Passwords use scrypt from `node:crypto` at
current OWASP parameters (N=2^17, r=8, p=1), self-describing so the cost can be
raised later without invalidating existing hashes.

The session carries the user id, the role and, for an agent, the organisation
id. **Only the id is an authority.** The role and the organisation on a token
are there so a layout can render the right navigation without a query; anything
that makes a decision calls `currentSession()`, which re-reads the user row
from `app_user` and builds the scope from *that*.

A signed token is not a fresh one. It cannot know that an account was
deactivated, that a role changed, or that a user moved between organisations
since it was issued eight hours ago. Re-reading costs one indexed primary-key
lookup per request, which is a small price for a permission change that takes
effect immediately.

An agency user whose organisation row is missing is refused sign-in outright.
That is a data fault rather than a credential failure, but signing them in
would produce a session with no scope, and every reading of that is worse than
refusing.

**One user table.** `app_user` holds BSCJ staff and agency users alike. A
second login path would be a second place to get password comparison, timing,
deactivation and email normalisation subtly wrong.

### Tenants — not Auth.js

A tenant has no account, so there is nothing for Auth.js to hold. After a
token or a reference-plus-postcode check succeeds, the server issues a signed,
HttpOnly, `SameSite=Lax` cookie **scoped to `/schedule`**, containing a job id
and an expiry and nothing else. Path scoping means the cookie is never
presented to the portal, the admin area or the consumer API.

### Middleware and real checks

`middleware.ts` is a cheap presence test on the session cookie, because the
edge cannot do the database and scrypt work a real check needs. Its job is to
keep unauthenticated browsers off private pages and send them somewhere
sensible.

**Authorisation is enforced again inside every private page, action and route
handler**, against a verified session — `requireAdmin()` today, and
`requireAgent()`, `requireEngineer()` and `requireTenantSession()` alongside it.
A forged cookie gets past the middleware and no further.

A structural test asserts every private page calls a guard, so a page added
later cannot be public by being forgotten. **Extend that test to each new route
group as the group is created**, in the same commit.

### The permission model

| | ADMIN | AGENT | ENGINEER | TENANT |
| --- | --- | --- | --- | --- |
| Own organisation's landlords, properties, tenancies | all | read/write | — | — |
| Any other organisation's data | all | **never** | — | **never** |
| Create a job | yes | own portfolio | — | — |
| Job pricing | read/write | read own | **never** | **never** |
| Choose an appointment | yes | yes | — | own job only |
| Today's assigned jobs, access details | yes | — | own assignments | — |
| Record inspection results, remedials | yes | — | own assignments | — |
| Certificates | all, correct | own org, read | issue on own job | — |
| Invoices | all | own org, read | **never** | **never** |
| Messages on a job | all | own org | own assignments | — |
| Pricing agreements, plans, users | yes | — | — | — |
| Audit log | read | — | — | — |
| View-as an agent | yes, audited | — | — | — |

Three rules sit above the table:

1. **A booking reference identifies a job. It never authorises access to one.**
2. **Never trust a client-supplied price, duration, status or ownership.**
   Re-derive on the server, as `/api/book` already does.
3. **Organisation scoping is a `WHERE` clause on every query, not a check at
   the top of a handler.** `organisationCondition()` in `lib/auth/scope.ts` is
   the only sanctioned way to build it — it takes the column, so a table
   without an organisation column cannot be queried through it by accident.

A fourth rule falls out of the scope model: **an engineer is scoped by
assignment, not by organisation.** They have no organisation at all, so
`organisationCondition` returns an explicitly false condition for them and
engineer queries filter on `job.assigned_engineer_id` instead. The dangerous
failure would have been widening "no organisation" to "no filter".

## 7. The data model

`src/lib/db/schema.ts` is the definition; the reasoning lives in its comments.
This section covers the shape and the decisions that are expensive to undo.

### Naming — the brief's model vs the tables

| Brief | Table | Note |
| --- | --- | --- |
| AgentOrganisation | `agent_organisation` | Null for consumer jobs |
| User | `app_user` | One table for admin, engineer and agent logins |
| Landlord | `customer` | The party table. `type` is `landlord`, `letting_agent`, `homeowner` or `tenant` |
| Property | `property` | |
| Tenant | `tenancy` | An occupancy with a period, not just a person — see below |
| Service | *code registry* | `lib/booking/products.ts`. Not a table |
| PricingAgreement / Tier | `pricing_agreement`, `pricing_agreement_line` | |
| Job | `job` | |
| Appointment | *columns on `job`* | One live appointment per job |
| Engineer | `app_user` with role `engineer` | Plus `job.assigned_engineer_id` |
| Certificate | `certificate` + `document` | Versioned record, stored file |
| VolumeCommitment | `volume_commitment` | The month's committed volume, which picks the tier |
| ContactAttempt | `contact_attempt` | Every attempt to reach a tenant, any channel |
| Invoice / InvoiceLine | `invoice`, `invoice_line` | |
| Remedial | `remedial` | |
| Message | `message` | |
| Renewal / ComplianceCycle | `compliance_cycle` | |
| Activity / AuditEvent | `activity`, `audit_event` | Two tables — see below |

Supporting: `scheduling_token`, `outbound_email`, `contact_attempt`,
`document`, `business_setting`.

There is **one party table**, not two. A landlord in an agent's portfolio and a
homeowner who booked on the website are both `customer` rows; the difference is
`type` and whether `agent_organisation_id` is set. A second party model for the
consumer path would mean two places to look for "who is this".

### Conventions

- Money is integer **pence**. Never a float, never a formatted string.
- Times that matter to a person are `timestamptz`; calendar *dates* that carry
  no time of day (a certificate expiry, a renewal due date) are `date`, so they
  cannot drift across a timezone boundary.
- Every organisation-scoped table carries the organisation id directly, even
  where it could be joined for. A missing `WHERE` clause should fail to
  compile or fail obviously, not silently return another agency's rows.

### Decisions worth stating

**1. Products are code, agent prices are data.** The registry in
`lib/booking/products.ts` defines what a product *is* — its name, duration,
appliance rule and **public list price**. A `pricing_agreement_line` may
override what a *particular organisation pays*. The consumer £45 has no
agreement and is therefore untouched by anything an agent negotiates. A
`service` table would be a second source of truth for £45; there is none.

**2. Commissioning and billing are separate.** `job.customer_id` is who asked
for the work; `job.billing_customer_id` is who is invoiced. An agent
commissioning work a landlord pays for is a real arrangement, and adding the
column later would mean migrating live invoices.

**3. Four date concepts stay four.** The expiry of the certificate the property
already holds, the date we were asked to finish by, the date we attended, and
the date it is next due are different questions. Collapsing any pair loses one.

**4. Jobs snapshot what was true when they were taken.** The only
denormalisation in the schema. Live foreign keys answer "what is true now";
`customer_snapshot`, `property_snapshot` and `price_snapshot` answer "what was
true then" — which is what a historical record, a reissued certificate and an
invoice all need when a property changes hands or an agency is renamed.

**5. A tenancy, not a tenant.** Tenants change. Overwriting a tenant row loses
who we actually contacted last year, and last year's job would silently
re-describe itself. A `tenancy` is an occupancy of a property with contact
details and a period; the current one is the one with no end date.

**6. An invoice is a header plus lines.** `invoice_line.job_id` is nullable so
an adjustment line can exist, and one invoice can carry many jobs. This is the
only shape in which a consolidated monthly agent invoice is expressible, and
retrofitting it once per-job invoices exist means rewriting issued documents.

**7. Certificates are versioned; issued records are never edited.** A
`certificate` row is an issued safety record. A correction creates a new row
with an incremented version, pointing at the one it supersedes, with a reason
and an author. The superseded row and its PDF are kept. `UPDATE certificate SET
...` on an issued row is the one write this system must never make.

**8. `activity` and `audit_event` are two tables.** They look similar and are
not. `activity` is the job timeline shown to an agent — business-readable,
scoped to a job, safe to expose. `audit_event` is the security log — sign-ins,
permission changes, impersonation, document access — visible only to admin,
append-only, and never filtered by a customer-facing query. Merging them means
either leaking security events into a customer view or hiding the timeline.

**9. Deadline risk and document state are computed, never stored.** They are
functions of dates and of whether a document exists. A stored copy is a second
source of truth that goes stale the moment a date passes.

**10. Nothing is hard-deleted.** Properties, landlords and organisations are
deactivated. A job that referenced a deleted property is a job whose history is
gone. Foreign keys use `restrict`, not `cascade`, except where a row genuinely
has no meaning without its parent (`scheduling_token`, `activity`).

## 8. Job state

Three independent things, never one enum.

**`job.lifecycle_status`** — where the work is:

```
draft → tenant_outreach → awaiting_tenant → scheduled → engineer_assigned
      → in_progress → completed
                    ↘ remedial_required ↗
cancelled — an alternative ending, reachable from anything unfinished
```

Transitions are enumerated and tested in `lib/jobs/lifecycle.ts`. Completed
work cannot become cancelled: undoing it is a credit note and a conversation,
not a status change. `scheduled → awaiting_tenant` stays legal, because a
tenant cancelling and picking again is a real event, and making it illegal only
pushes it into a delete-and-recreate that loses the history.

**`invoice.status`** — where the money is: `draft → sent → paid`, plus `void`.

**Derived, not stored:**
- *Certificate issued* — a current-version `certificate` row exists
- *Certificate sent* — its document has a `sent_at`
- *Invoiced* — an `invoice_line` references the job
- *Deadline risk* — `normal | approaching | urgent | overdue`, from
  `complete_by_date` and today, on windows from `business_setting`

The deadline exception is a **flag**, not a status: a job can be past its
deadline *and* scheduled *and* invoiced at once.

## 9. External side effects are not transactional

Postgres cannot make a Google Calendar write or a Resend send atomic, and
pretending otherwise is how jobs get lost. So the intent is recorded durably
and the outcome is recorded separately:

- `job.calendar_sync_state` — `not_required | pending | synced | failed`
- `outbound_email` — one row per intended message, with `state`, `attempts` and
  a unique `idempotency_key`

An agent submitting twenty properties gets twenty durable jobs committed in one
transaction; the emails follow from the drain, and one that fails is a row to
retry rather than a lost invitation and never a failed submission.

The same discipline covers the calendar: a scheduled job whose event write
failed is `failed`, visible on the admin dashboard, and retried by the sweep.
It is never silently inconsistent, and a customer is never told an appointment
exists when it does not.

## 10. Scheduled work

Vercel Cron, hitting route handlers under `/api/cron/*`. Each one:

- authenticates with `CRON_SECRET` and rejects everything else
- processes a **bounded batch**, so a backlog cannot time out the function
- is **idempotent**, so a double-fire changes nothing
- writes what it did to `activity` or `audit_event`

| Job | Cadence | Does |
| --- | --- | --- |
| `email-drain` | every 5 min | Sends `outbound_email` rows in `pending`, retries `failed` with backoff |
| `calendar-retry` | every 15 min | Retries jobs in `calendar_sync_state = failed` |
| `tenant-outreach` | daily | Sends reminders and escalates non-responses on `awaiting_tenant` jobs |
| `renewal-sweep` | daily | Surfaces compliance cycles entering their outreach window and creates the next job |

Windows, reminder counts and escalation thresholds come from
`business_setting`, not from constants — they will be tuned in production
without a deploy.

## 11. Document storage

Vercel Blob with **private** access. Nothing is ever a public URL.

A document is fetched through an authenticated route handler that re-derives
the caller's permission from the database, streams the blob, and records the
access in `audit_event`. `document.blob_key` is an opaque key and is never
rendered into a page.

## 12. The certificate generator

BSCJ already has one, and it is not being rebuilt. As found on 16 September
2026:

- `~/Gas Cert Generator/GAS CERTS/Generator/index.html` — a single-file
  application: an appliance table of 6 rows × 21 columns, landlord and engineer
  records in `localStorage`, PDF produced client-side with `html2canvas` and
  `jsPDF`, saved into month folders through the File System Access API.
- `~/Gas Cert Generator/GAS CERTS/TEMPLATES/` — five certificate templates.
- It already computes next inspection as **+12 months**.

**It is not in version control and exists on one machine.** That is the first
thing to fix; see `V2_CURRENT_STATE.md` blocker 9.

Integration is in two steps, so the engineer gets value before the harder half
is done:

**Step A (V2.5) — bridge.** The job page produces a prefill payload containing
everything already known: property, landlord, agent, dates, BSCJ and engineer
details, certificate number. The generator consumes it; the finished PDF is
uploaded back against the job. Low risk, and the generator keeps working
exactly as it does today.

**Step B (V2.5/V2.8) — port.** The generator's markup and PDF code move into
the app as a client component at `/engineer/jobs/[id]/certificate`, prefilled
server-side, with the PDF generated in the browser and uploaded to Blob
directly. Same code, same output, no manual step.

Either way the engineer enters only inspection-specific fields — appliances,
readings, results, defects, remedials, notes — and the certificate is stored
against the job and exposed to the agent.

## 13. The invoice generator

Also already exists: `~/Invoice Generator/`, branded **Supreme Gas Ltd**
(the legal company behind BSCJ Gas & Heating), drawing text at measured
coordinates onto a blank template PDF, numbering a single running `D-<n>`
series by hand from `localStorage`, saving into month folders via a small
local Node server. A separate payments tracker reconciles those PDFs against
imported bank transactions.

The layout logic is the valuable part and is reused. Three of the questions it
raised were settled on 16 September 2026:

- **The `D-` series is not continued.** V2 runs `BSCJ-000001` upwards from the
  Postgres sequence in `drizzle/0001`, which is atomic by construction and
  never reissues a value even when a transaction rolls back. Counting rows
  races; a "last number" column races; a timestamp is not a number an
  accountant can work with. Two systems incrementing one series is how two
  invoices end up sharing a number, so they are kept apart.
- **BSCJ is not VAT registered.** VAT is modelled in full and switched off.
- **The entity name is configuration**, because the entity is changing.

What prints on an invoice is not in the code at all. `business_setting` holds
the trading name, the legal entity, the company number, the address, the
contact details, the footer and the VAT position; each invoice snapshots them
at issue into `invoice.identity_snapshot`. BSCJ Solutions is expected to be
incorporated around 4–5 October 2026, and when it is, that is a settings edit
rather than a release — and every invoice issued before it keeps saying what
was true on its date.

`canIssueInvoices()` refuses while any required field is empty, and names the
missing ones. There is no placeholder and no fallback: a guessed company name
on a document is a claim this code is not entitled to make.

## 14. Configuration that must not be invented

`business_setting` holds facts a person must supply, empty until they do:

- VAT status, and the number if registered. Note `business-details.md` records
  that the £45 is VAT-inclusive **internally** and that no VAT wording may
  appear publicly.
- Bank details or payment method to print on an invoice
- Payment terms
- Any required legal footer wording
- The CP12 renewal interval
- Outreach windows, reminder counts and escalation thresholds
- The default remedial authorisation threshold

Code reads these and renders a visible "not configured" state when they are
absent. It never falls back to a guess. A phase that needs one of them stops
and asks.

Implemented in `lib/settings/business-identity.ts` (the shapes and the rules,
pure and tested) and `lib/settings/store.ts` (the only code that reads the
rows). Every read degrades to the empty value without a database, so a missing
`DATABASE_URL` makes a page say the identity is not configured rather than
crash — which is true, and actionable.

The renewal interval is the one item that has since been confirmed: inspection
date + 12 months − 1 day, in `lib/compliance/renewal.ts`.

## 15. Protecting V1

V1 is live and processing real bookings. The isolation is structural, not
procedural.

**One touch point, and only one.** `/api/book` gains a persistence step *after*
the calendar event exists and the emails have gone — wrapped so it can never
fail a booking, exactly as the email send already is. Every other V2 write path
is a new file. If persistence throws, the customer still has their appointment
and their confirmation; the job is reconciled from the calendar afterwards.

**Everything else is additive.** New route groups, new tables, new modules.
No V1 module changes behaviour; several are imported by V2 and none are
rewritten.

**Degradation is already the pattern.** `getDb()` returns null without
`DATABASE_URL`, exactly as `getKvClient()` does. With no database configured,
the consumer booking flow works and the V2 surfaces report themselves as not
configured. That makes "V2 is broken" and "V1 is down" impossible to confuse.

**Tests are the guard rail.** 899 of 904 currently pass (the five failures are
a clock-dependent test in the availability suite, not a defect — see
`V2_CURRENT_STATE.md`). The structural tests in `admin-access.test.ts` and
`public-content.test.ts` are extended to each new private surface in the same
commit that creates it.

**Migrations are reviewed SQL, never applied at runtime.** Generated with
`drizzle-kit generate`, committed, read before they touch production data, and
applied first to a Neon branch. Every migration has a down file.

**Deployment.** Each phase lands behind a preview deployment with its own Neon
branch. A phase leaves the application working or it does not land.

## 16. Environment

| Variable | Status | Needed for |
| --- | --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_CALENDAR_ID` | set | V1, unchanged |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | set | V1, unchanged |
| `RESEND_API_KEY`, `BOOKING_EMAIL_FROM`, `BOOKING_EMAIL_REPLY_TO` | set | V1, unchanged |
| `BOOKING_NOTIFICATION_EMAIL` | **missing locally** | Internal booking alerts |
| `AUTH_SECRET` | set | Sessions |
| `DATABASE_URL` | **not set anywhere** | Everything in V2 |
| `SCHEDULING_TOKEN_SECRET` | reserved | Peppers tenant token hashes (V2.3) |
| `BLOB_READ_WRITE_TOKEN` | reserved | Certificate and invoice PDFs (V2.5) |
| `CRON_SECRET` | **new** | Authenticating cron endpoints (V2.6) |

`DATABASE_URL` is the one that blocks progress. Until it is set, V2.0 can be
typechecked, linted, tested and built — all of which pass — but no migration
can be applied and nothing can be verified against real rows.

Nothing is `NEXT_PUBLIC_`. No credential and no service-area coordinate may
ever reach the browser.

## 17. Costs

Neon free tier, Vercel Blob free tier, Vercel Cron included: **£0/month** at
current volume, and roughly £1/month at ten times it. No new subscription.
