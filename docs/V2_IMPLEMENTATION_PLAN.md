# V2 implementation plan

The order the work lands in, and what "done" means for each milestone.

Read `V2_ARCHITECTURE.md` for the decisions behind this, and
`V2_CURRENT_STATE.md` for where the work actually is right now.

---

## Rules that apply to every milestone

1. **Each milestone leaves a working application.** V1 booking works at every
   commit, including the ones in the middle.
2. **Extend, do not rebuild.** The reuse table in `V2_ARCHITECTURE.md` § 3 is
   the list of things that already exist.
3. **Every new private surface gets its guard and its structural test in the
   same commit.** Not the next one.
4. **Every price, duration, status and ownership is re-derived on the server.**
5. **No business, legal or accounting fact is invented.** If a milestone needs
   one, it stops and asks. What has been decided and what is still open are
   both listed in `V2_CURRENT_STATE.md`.
6. **Run tests, typecheck, lint and a production build before finishing any
   milestone.**
7. **Update `V2_CURRENT_STATE.md`** at the end of each milestone. It is the
   file that makes the next session cheap.

---

## V2.0 — Foundation ✅ **complete, 16 September 2026**

The draft schema predated agent accounts and was reshaped **before the first
migration was ever applied**, so `0000` was regenerated rather than corrected
by a stack of follow-ups. That freedom ends the first time it runs against real
data.

### What landed

**Schema — 22 tables.** `agent_organisation`; `app_user` replacing
`admin_user`, with `organisation_id` and the four roles; `agent_organisation_id`
on every agency-reachable table, indexed; `tenancy` replacing `tenant`, with a
period; nine lifecycle statuses; `assigned_engineer_id` and `requested_asap` on
`job`; `pricing_agreement`, `pricing_agreement_line`, `volume_commitment`;
`certificate` with versioning and supersession; `invoice` split into header and
`invoice_line`, with VAT columns and an identity snapshot; `remedial`;
`message`; `contact_attempt`; `compliance_cycle`; `audit_event` separate from
`activity`.

**Auth.** `roles.ts` (capability matrix), `scope.ts` (scope derivation, access
checks, the query filter), `app-user.ts` (one credential path, timing-safe),
`session.ts` (`requireAdmin` / `requireAgent` / `requireEngineer`, each
re-deriving role and organisation from the database). Middleware extended to
`/portal` and `/engineer` and their APIs, with `/schedule` deliberately left
out.

**Domain rules, as pure tested modules.** `compliance/renewal.ts` (+12 months
− 1 day, and deadline risk); `pricing/{tiers,resolve,snapshot}.ts`;
`invoices/number.ts`; `settings/business-identity.ts`; `jobs/derived.ts`.

**One incidental fix.** `generateJobReference` now refuses an all-digit body,
so a new reference can never be mistaken for a `BSCJ-000001` invoice number.
`isJobReference` still accepts one, because V1 issued them and they are in
customers' inboxes.

### What moved out of V2.0

**V2.0.3, persisting V1 bookings, moved to V2.1.** It is the one V1 touch
point, and it cannot be verified without a live database. Writing it blind
against a schema nothing has ever run is how an untested `catch` block gets
shipped into the booking path.

### Deferred deliberately

No `/portal` or `/engineer` pages, no agent dashboard, no tenant scheduling, no
generator integration, no cron, no blob storage. The middleware covers those
prefixes already, so the first page added under one is gated from its first
commit.

---

## V2.1 — Portfolio

**Do this first: provision Neon and apply `0000` to a branch.** Set
`DATABASE_URL`, run `npm run db:migrate`, then `npm run admin:create`. Nothing
below can be verified against a database that does not exist.

- **Persist V1 bookings** (moved from V2.0.3). After the calendar event exists
  and the emails have been attempted, write the job, the customer and the
  property — wrapped so a failure logs and does nothing else. Add a
  reconciliation view in `/admin` listing calendar bookings with no job row.
  Verify by breaking the database deliberately and confirming a booking still
  completes.
- `/portal` shell, sign-in, organisation context.
- Landlords: list, create, edit.
- Properties: list, create under new or existing landlord, edit. Postcode
  validated through the existing `lib/address` provider.
- Tenancies: record a tenant against a property; ending one starts a new one
  rather than overwriting it.
- Property detail page: address, landlord, current tenancy, compliance
  position, job history, documents.
- Current and next compliance deadline recorded per property, entered by hand
  at this stage.

**Done when:** an agent can build a portfolio and see it, and cannot see
another organisation's; and a consumer booking appears in `/admin` as a job
while a database outage still leaves the booking flow working.

The isolation half is already unit-tested in `lib/auth/scope.test.ts`. What
V2.1 adds is proving it end to end through a real query — every portfolio read
goes through `organisationCondition`, and a handler that builds its own `WHERE`
is the failure this design exists to make hard.

---

## V2.2 — Jobs and pricing

**The pricing rules are already built and tested** (`lib/pricing/*`, V2.0).
V2.2 is the screens, the queries and the wiring, not the arithmetic.

- Admin screens for `pricing_agreement`, `pricing_agreement_line` and
  `volume_commitment`, validating bands with `validateTiers` on save so a gap
  or an overlap is refused before it can produce a surprising invoice.
- Load the active agreement and the month's commitment, then call the existing
  `resolvePrice`; write the result through `buildPriceSnapshot` onto the job.
- Volume counters per organisation per month: submitted, completed, invoiced.
  Derived from job timestamps, not stored.
- Agent job creation: landlord → property → service → tenant → deadline or
  ASAP → submit.
- Job reference and hashed scheduling token allocated on submission.
- Job detail page for the agent; job list with search and filter.
- Admin: pricing agreements, per-job price override with a reason.

**Blocked on:** approved tier figures. The mechanism is complete and no figure
is in the code; an organisation with no agreement, no commitment or no matching
band pays list price, which is why this was safe to build first. Do not enter a
figure until BSCJ approves one.

**Done when:** an agent submits a job, the price is resolved on the server,
and nothing the browser sends can change it.

---

## V2.3 — Tenant scheduling

The flow the whole product depends on, and the one with the most reuse.

- `(schedule)` route group, own layout, no site navigation, `noindex`.
- Entry A: `/schedule/[token]`. Token compared by hash, peppered with
  `SCHEDULING_TOKEN_SECRET`, single-use, expiring.
- Entry B: `/schedule` — reference plus postcode. Postcode normalised,
  rate-limited per IP and per reference, **one generic failure message for
  every failure mode**.
- Tenant session: signed HttpOnly cookie scoped to `/schedule`, carrying a job
  id and an expiry.
- The picker: `DatePicker`, `TimePicker`, `ReservationBar`, `StepIndicator`
  recomposed. Availability from `lib/booking/slots.ts`; reservation from
  `lib/booking/holds.ts`; the daily cap and the pre-write recheck unchanged.
- Confirming writes the appointment, moves the job to `scheduled`, queues the
  calendar write and the confirmations.
- Invitation email, queued through `outbound_email`.

**Done when:** a tenant can schedule from a link and from a reference, sees no
price and no other property, and cannot reach `/book` or `/portal` from
anywhere in the flow. Test the negative cases explicitly.

---

## V2.4 — Operations and engineer

- `/engineer`: today's jobs, ordered by time. Property, access notes, contact,
  service, notes. Tap to navigate, tap to call.
- Assign an engineer to a job; job moves to `engineer_assigned`.
- Start and complete a job: `in_progress`, then `completed` with
  `completed_at`.
- `remedial`: description, notes, photographs, estimated cost, whether it was
  done on the visit, approval state.
- Remedial authorisation: the organisation's threshold, a per-job custom
  amount, and an approval request to the agent when it is exceeded.
- Admin dashboard: needs attention, today, this week, failed calendar syncs,
  failed emails.
- Agent dashboard: the buckets in `V2_PRODUCT_SPEC.md` § 11.

**Blocked on:** `V2_CURRENT_STATE.md` 7 for the default threshold. £0 is the
safe placeholder and must be labelled as awaiting confirmation.

**Done when:** an engineer can work a day from the phone and an agent can see
what needs them, and neither can see anything the permission table says they
cannot.

---

## V2.5 — Certificates and invoices

VAT, numbering and identity are settled (V2.0). What remains outstanding is the
**footer wording and payment terms**, and the **legal entity**, which changes
around 4–5 October 2026. Both are settings rows; `canIssueInvoices()` refuses
until they are filled, so this phase can be built and only issuing is gated.

- Put both generators in version control first. They are still loose folders on
  one machine.
- Vercel Blob wired, private, with an authenticated streaming route that
  re-derives permission and records access in `audit_event`.
- Certificate prefill payload from the job.
- Generator bridge (step A in `V2_ARCHITECTURE.md` § 12): prefill out, PDF
  back, stored against the job.
- `certificate` rows with versioning: a correction creates a new version
  pointing at the superseded one, with a reason and an author. Issued rows are
  never updated.
- Certificate visible to the agent on the job and the property.
- Invoice draft from the job or from a month's jobs for an organisation;
  admin reviews and edits lines; issuing freezes it, snapshots the business
  identity, and allocates a number with `allocateInvoiceNumber()`.
- **Price every line from the job's `price_snapshot`**, never by re-resolving.
  Anything that calls `resolvePrice` to build an invoice is re-pricing
  historical work at today's rates.
- Invoice PDF in the portal, optionally emailed.

**Done when:** a completed job produces a stored, versioned certificate and a
reviewable invoice, and there is no code path that edits an issued one.

---

## V2.6 — Compliance automation

The renewal rule is confirmed and implemented (`lib/compliance/renewal.ts`).
V2.6 is the automation around it.

- `compliance_cycle` per property: what was certified, when it expires, which
  job produced it, which job renews it. The table exists; nothing writes to it
  yet.
- A completed, certificated job closes the current cycle and opens the next.
- `CRON_SECRET` and the four cron endpoints in `V2_ARCHITECTURE.md` § 10,
  each bounded, idempotent and authenticated.
- `renewal-sweep`: surfaces cycles entering their outreach window, creates the
  next job, starts its outreach.
- `email-drain` and `calendar-retry` promoted from manual to scheduled.
- Windows and thresholds read from `business_setting`.

**Done when:** a completed certificate produces a tracked next due date, and
the sweep creates the renewal job without anyone touching it — with every
timing value configurable rather than compiled in.

---

## V2.7 — Communications

- `contact_attempt`: channel, purpose, when, outcome. Visible to the agent and
  to admin.
- Tenant reminder schedule and non-response escalation, driven by
  `tenant-outreach`.
- Job-level messages between the agent and BSCJ, in the portal.
- Job activity timeline surfaced to the agent.
- The engineer's personal number appears nowhere. BSCJ's business phone and
  WhatsApp remain the escalation route.

**Done when:** an agent can see every attempt made to reach their tenant, and
reply about a job without leaving the portal.

---

## V2.8 — Security and polish

- Admin view-as-agent, with a visible banner, a recorded start and end, and
  every action attributing both the real admin and the impersonated account.
- Audit log viewer for admin.
- Rate limits on every public and semi-public endpoint, using the existing
  helper.
- Review the Content-Security-Policy deferred at V1 launch — now worth doing,
  since the portal ships new client code. See `LAUNCH_CHECKLIST.md`.
- Optional TOTP for admin accounts (`app_user.totp_secret` already exists).
- Certificate generator port (step B), if not already done.
- Fix the clock-dependent availability tests by pinning a clock.
- Reconcile `business-details.md`'s stale daily-limit figure with the code.

**Done when:** an admin can support an agent without a shared password, and
every sensitive action is attributable.

---

## V2.9 — Agent acquisition launch

- Bulk CSV/XLSX property import with a reviewable preview before any write:
  what will be created, what matched an existing record, what cannot be parsed.
- Agent onboarding: BSCJ creates the account, the first user sets their own
  password through a single-use link.
- An agent-facing page on the public site explaining the managed service. No
  pricing tiers unless and until they are approved.
- Operational runbook: what to do when a calendar sync fails, an email will not
  send, a tenant cannot be reached, a certificate needs correcting.

**Done when:** BSCJ can onboard a new letting agent without a developer.

---

## Migrations, environment and services

### Migrations expected

| # | Milestone | Contents |
| --- | --- | --- |
| `0000` | V2.0 ✅ | The whole foundation — all 22 tables |
| `0001` | V2.0 ✅ | Invoice number sequence, `BSCJ-` series from 1 |
| `0002`+ | V2.1 onward | Only what experience shows is missing |

`0000` carries every table the later phases need, including pricing,
certificates, remedials, messages, compliance cycles and the audit log. Those
phases should need no migration at all — and if one turns out to, that is
information worth having early rather than a sign the foundation was wrong.

Every one is generated SQL, committed, reviewed, has a down file, and is
applied to a Neon branch before production.

### Environment variables to add

- `DATABASE_URL` — **outstanding, and blocking V2.1.** Nothing works without it
- `SCHEDULING_TOKEN_SECRET` — V2.3
- `BLOB_READ_WRITE_TOKEN` — V2.5
- `CRON_SECRET` — V2.6
- `BOOKING_NOTIFICATION_EMAIL` — missing locally today; set it

### External services

Neon Postgres (new), Vercel Blob (new), Vercel Cron (new). Google Calendar,
Upstash Redis, Resend and Postcodes.io are all existing and unchanged. No
payment provider. No SMS provider.

---

## What would endanger V1, and how each is prevented

| Risk | Prevention |
| --- | --- |
| A V2 failure breaking a booking | The single `/api/book` touch point is wrapped and cannot throw into the booking path. Everything else is a new file. |
| A migration locking or damaging live data | V2 tables are additive and touch nothing V1 reads. Migrations are reviewed SQL applied to a Neon branch first, each with a down file. |
| A new page shipping without authorisation | Structural tests assert every private page calls a guard, extended to each new route group in the commit that creates it. |
| Portal code bloating the public bundle | Separate route groups with separate layouts. The public pages are already isolated in `(site)`. |
| An admin or portal page being indexed | `noindex` on each private layout; `sitemap.ts` lists the seven public pages explicitly. |
| One agency seeing another's portfolio | Organisation re-derived from the database, never from the token; a shared scoped-query helper; an explicit test. |
| A reference being treated as a credential | It never grants access on its own. Manual entry additionally requires the postcode, is rate-limited, and fails generically. |
| Agent pricing leaking into consumer pricing | Agent prices are rows that apply only to jobs with an organisation. The consumer path resolves no agreement and reads the code registry. |
| The daily cap or availability drifting | Both come from the existing V1 modules. No second slot engine exists. |
| A missing database taking the site down | `getDb()` returns null and V2 surfaces report not configured, exactly as Redis already degrades. |
| The engineer's identity leaking | `public-content.test.ts` already guards this. Extend it to the portal, the engineer view and the tenant flow. |
