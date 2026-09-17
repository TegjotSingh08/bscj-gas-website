# V2 — current state

**Read this first.** It exists so a new session does not have to re-audit the
repository. Update it at the end of every piece of work.

Last updated: 17 September 2026.

---

## Current milestone

**V2.0 Foundation — COMPLETE AND OPERATIONAL, verified 17 September 2026.**

**V2.1 Portfolio — complete.** V1 bookings persist as jobs, agency accounts
exist end to end, and the portfolio (landlords, properties, tenancies,
compliance dates) works.

**V2.2 Jobs — complete.** An agency can book work against its own property.

**V2.3 Tenant scheduling — complete.** A tenant reaches their own job through
a link or a reference, picks a real slot on the existing availability engine
and confirms it. Operations and the engineer view (V2.4) are next.

## Where the code is

Branch `v2-compliance-platform`, at `44b047a`, three commits past the last V1
commit (`6bd7c91`). Working tree clean.

**The branch is local only — it has no upstream and has not been pushed.**
That is the one outstanding risk to V2.0: the work exists on one machine.

**V2 is not deployed to production, but the schema is live on the Neon
development database** and the admin surface works against it.

**The schema is no longer free to reshape in place.** From here a change is a
new migration, not an edit to `0000`.

### Verification, 17 September 2026

Every check below was read-only. No DDL, no writes, and the invoice sequence
was inspected through `pg_sequences` rather than drawn from.

| Checked | Result |
| --- | --- |
| Live schema vs `schema.ts` | 22/22 tables, **260 columns**, 0 differences |
| Enum types | 20/20, **78 labels**, all in order |
| Indexes | 10/10 unique, 60/60 others present |
| Foreign keys | 54; **0 cascade off `job`**, so history cannot be deleted out from under itself |
| Migration hashes | both match the files on disk |
| Invoice sequence | `start=1000`, `last_value=null` — **BSCJ-001000 next, none consumed** |
| Admin account | 1 row, `role=admin`, active, no organisation (staff), scrypt hash, has signed in |
| Business data | 0 jobs, customers, invoices, certificates, organisations, settings |
| V1 runtime modules | **byte-identical** to `6bd7c91` |
| V1 pages | all 8 identical after the `(site)` move; no chrome lost |
| Secrets tracked | none; `.env.local` ignored, only `.env.example` tracked |
| Tests / typecheck / lint / build | 1067 pass, all clean |

### V2.0, as built

| Area | Files | State |
| --- | --- | --- |
| Schema | `src/lib/db/schema.ts` | **22 tables.** Reshaped for agent accounts before first migration |
| Migrations | `drizzle/0000_v2_foundation.sql`, `0001_invoice_number_sequence.sql`, both with down files | **Applied to Neon, 17 September 2026**, hashes verified |
| Migration tooling | `drizzle.config.ts`, `scripts/db-status.mjs` | Loads `.env.local`; `npm run db:status` reports state read-only |
| Database client | `src/lib/db/client.ts`, `index.ts` | Neon HTTP + Drizzle, lazy, null-safe |
| Roles and permissions | `src/lib/auth/roles.ts` | Capability matrix for the four roles |
| Organisation scoping | `src/lib/auth/scope.ts` | Scope derivation, access checks, query filter |
| User lookup | `src/lib/auth/app-user.ts` | One table for staff and agency users |
| Session guards | `src/lib/auth/session.ts` | `requireAdmin` / `requireAgent` / `requireEngineer`, DB-derived |
| Auth wiring | `src/auth.ts`, `src/types/next-auth.d.ts` | Auth.js, token carries id only as authority |
| Middleware | `src/middleware.ts` | Gates `/admin`, `/portal`, `/engineer` and their APIs |
| Job lifecycle | `src/lib/jobs/lifecycle.ts` | Nine statuses, transitions enumerated |
| Derived job state | `src/lib/jobs/derived.ts` | Stage, deadline risk, needs-attention |
| Job references | `src/lib/jobs/reference.ts` | Now refuses all-digit, so it cannot look like an invoice number |
| Renewal rule | `src/lib/compliance/renewal.ts` | +12 months − 1 day, one implementation |
| Pricing | `src/lib/pricing/tiers.ts`, `resolve.ts`, `snapshot.ts` | Tiers, resolution, frozen snapshot |
| Invoice numbering | `src/lib/invoices/number.ts`, `allocate.ts` | `BSCJ-001000` upwards, from a Postgres sequence |
| Business identity | `src/lib/settings/business-identity.ts`, `store.ts` | Configurable identity, VAT off, nothing invented |
| Admin shell | `src/app/admin/**` | Placeholder dashboard + login, on the new session module |
| Staff tool | `scripts/create-admin.mjs` | Creates an admin or an engineer |

### Not started

Everything else. No portfolio screens, no agent job creation, no tenant
scheduling, no engineer UI, no certificate or invoice generation, no cron, no
blob storage, no messaging UI.

## V2.1, so far

**Website bookings are recorded as jobs** (17 September 2026).

`/api/book` gained exactly one new step: `persistWebsiteBooking`, called last —
after the calendar event exists, after the hold is released, after both emails.
It never throws, so it is called plainly, exactly as the email sends above it
are. A database outage leaves the booking confirmed and the response unchanged.

Retries write nothing at all: the job is looked up by idempotency key before
any insert, so a second submission leaves no duplicate customer or property
either. The unique index on `job.idempotency_key` guards the race past that
check.

`/admin/jobs` and `/admin/jobs/[id]` are the operational views — read-only, and
scoped through `organisationCondition` so an administrator sees consumer work
while an agency user never would.

**No migration was needed.** The applied `0000` already carries every column
this required.

### Proved against live Neon, 17 September 2026

| | |
| --- | --- |
| A — success produces one job | `created`, job count 0 → 1 |
| B — retries do not duplicate | two retries both `exists`, same id, 1 customer / 1 job |
| C — database failure cannot break a booking | route returns 200 with the reference and `emailSent: true` when persistence fails or is unconfigured |
| D — visible to ADMIN | appears in the admin list and detail; an agency scope sees neither |

Mapping on the real row: `price_total_pence=6000`, snapshot total `6000`,
source `list`, `lifecycle=scheduled`, `scheduling_method=self_booked`,
`source=website_self`, `calendar_sync_state=synced`, no organisation.

Verification rows were deleted afterwards; the database is back to zero jobs,
customers, properties and activities.

### Agency accounts and the portal (17 September 2026)

`/admin/organisations` opens an agency, adds its first `agent_owner`, and
suspends or reactivates either. `/portal` is the agency shell: branded sign-in
at `/portal/login`, dashboard naming the signed-in user and their agency, sign
out, and placeholder cards for Portfolio, Jobs, Compliance, Invoices and
Support.

**One auth system, two doors.** Staff and agency users are the same `app_user`
rows checked by the same credential path and the same shared form; only the
branding and the landing path differ. Middleware picks the sign-in page by
prefix; `safeNext` keeps a return path inside the surface it came from.

**Suspension is enforced in `toIdentity`**, which both `authenticateUser` and
`currentIdentity` map through — so a suspended user or a suspended agency is
refused at sign-in *and* on the next request of a live session, not when their
token expires.

**No migration was needed.** `agent_organisation.is_active` and
`app_user.is_active` were already there.

Proved live, then cleaned up: two agencies created with owners; duplicate email
refused; agent authenticates and gets their own organisation; an agency sees
zero consumer jobs and gets null for a consumer job id it knows; admin sees it;
cross-agency access refused; suspending the agency and suspending the user both
lock out immediately; a cross-organisation suspend attempt does nothing; no
password hash appears in any admin read.

**Naming note:** the brief said `agent_staff`; the applied enum says
`agent_member`. Kept as-is rather than migrating an applied enum for a synonym.

### Portfolio (17 September 2026)

`/portal/portfolio` lists every property with landlord, tenant and CP12 due
date, searchable across address, postcode, landlord and tenant.
`/portal/portfolio/new` adds one on a single page: pick or create the landlord
inline, enter the postcode and the town fills in from the V1 provider, then
optional tenant and optional certificate date. `/portal/portfolio/[id]` keeps
**property, landlord and tenancy visibly apart** and shows the full tenancy
history. `/portal/landlords` manages landlords; one landlord, many properties.

**Decisions worth keeping.** Coverage is reported, not enforced — the
twelve-mile radius governs public online booking, not what BSCJ will do for a
managed agency. An empty tenancy form records *no tenancy* rather than a blank
one. A missing certificate date reads "not known", never compliant or overdue.
A tenant change closes the old tenancy and opens a new one; a compliance update
supersedes rather than overwrites.

**There is no premise lookup** and the flow never implies one: the agent still
types the house number, exactly as a customer does on the public site.

**New migration `0002_property_uniqueness`** — applied. A partial unique index
on `(agent_organisation_id, postcode, lower(house_or_name))`. The application
checks before inserting, but two submissions racing both see "not there"; only
the index can refuse that, and a portfolio holding one address twice produces
two jobs, two invoices and two renewal cycles. Partial so consumer bookings,
which have no organisation, are unaffected. Addresses are canonicalised at the
write, not only in the parser, so the index cannot be slipped past.

Proved live, then cleaned up: landlord + property + tenancy + compliance
created together; a second property reused the same landlord (1 landlord, 2
properties); unknown tenant accepted; tenancy replacement left exactly one open
and one closed record with the previous tenant intact; Agency B could not read
or mutate any of Agency A's property, landlord, tenancy or compliance by direct
id, nor attach a property to A's landlord; consumer records stayed out of the
agency's portfolio and landlord list; duplicate protection held for exact,
untidy, case and edit-onto-taken variants, with the index refusing a raw race;
and the consumer job was untouched.

### Agent job creation (17 September 2026)

"Book work" on a property opens `/portal/portfolio/[id]/book`: pick the
service, ASAP or a deadline, appliance count where the service prices by one,
an optional note, and a server-calculated price shown before submission.
`/portal/jobs` and `/portal/jobs/[id]` are the read-only views.

**Everything that decides money, ownership or state is derived server-side.**
`createAgentJob` takes an organisation from `requireAgent()`, a property id and
a service id — there is no parameter for a price, reference, status,
organisation or snapshot, and the action reads none from the form. The property
is re-read under the organisation before anything is written.

**The scheduling boundary is preserved.** The agent requests work; the tenant
picks the time in V2.3. So no slot is held, no calendar event is written and no
email is sent. A job lands in `tenant_outreach` with `source = portal`,
`calendar_sync_state = not_required` and no appointment — that is the queue
V2.3 will drive.

**Idempotency** reuses `job.idempotency_key`, namespaced as
`portal:<orgId>:<submissionKey>` so one agency's key can never collide with
another's. The key is minted once per rendered form; a retry returns the
existing job and mints no second reference or token.

**Scheduling tokens** are minted with the job in the same transaction and
stored only as a self-describing hash (`hmac$…` under
`SCHEDULING_TOKEN_SECRET`, `sha256$…` without it) so a pepper can be introduced
later without invalidating links already sent.

**No migration.** The applied schema already carried every column.

Proved live, then cleaned up (A–N): job created with correct lifecycle, source,
scheduling method and frozen snapshots; reference valid and the **invoice
sequence never drawn** (`last_value` still null); token hashed, expiring, and
unmatched by a wrong value; list price with no agreement and the agreed £39.99
tier price with one, extras charged on the agreed rate; retry returned the same
job and minted no second token; Agency B reusing A's submission key and
property id got `not_found` and created nothing; B could not read or book A's
property or job; a refused write left no job, no orphan token, and every portal
job had exactly one token; consumer jobs stayed out of agency scope; ADMIN saw
all three.

### Tenant scheduling (17 September 2026)

`/schedule/[token]` spends the invitation token at the door and replaces it
with a signed, path-scoped session; `/schedule` is the reference-plus-postcode
way in. `/schedule/appointment` is the picker, `/schedule/confirmed` the
receipt. `/api/schedule/confirm` writes the appointment.

**The session names one job and nothing else.** Signed with a key derived from
`AUTH_SECRET` under its own label, `HttpOnly`, `SameSite=Lax`, scoped to
`/schedule` so the browser never presents it to the portal, the admin area or
the consumer API. Editing the job id or the expiry breaks the signature. There
is **no job id in any scheduling URL** after the token hop — the simplest way
to guarantee one cannot be substituted.

**Both doors fail identically.** Unknown token, expired, revoked, wrong
reference, wrong postcode, rate limited — one message. Manual entry is limited
per caller *and* per reference, because per-IP alone misses many machines
sweeping one reference. Reference and postcode are matched in a single query,
so a real reference does not answer faster than a fake one.

**Nothing about scheduling is forked.** The same `DatePicker`, `TimePicker`,
`ReservationBar`, `/api/availability`, `/api/hold` and 30-minute Redis holds
the public site uses, recomposed. At confirmation the hold is rechecked against
the caller's own token, availability is re-read from Google, and the daily cap
is counted under the same short lock — a hold is never taken as permission on
its own. The status change is guarded by the status it expects to find, so two
confirmations racing produce one appointment.

**The calendar write is outside the transaction**, as the architecture
requires. The job commits as `scheduled` with `calendar_sync_state = pending`;
the event is written after, with an id derived from the job and the slot, so a
retry collides rather than duplicating and a `409` is recorded as success. A
failure leaves `failed` for the retry sweep — never a tenant told their booking
failed after it worked.

**Communication is intent only.** An `outbound_email` row is queued with a
unique key; sending is the V2.6 drain. A mail outage cannot reach this
transaction at all.

The tenant sees the property, the service, the reference and the times. **No
price, no landlord, no other property, and no navigation into the rest of the
site.**

**No migration.** The applied schema already carried every column.

Proved live against Neon, Redis and Google Calendar (A–P), then cleaned up —
including deleting the real calendar event the proof created. Highlights:
token grants exactly its own job and not the agency's other one; expired and
revoked tokens fail like unknown ones; both rate limits bite; a competing hold
is refused and the atomic switch keeps the tenant's token; confirming with a
foreign hold token is refused; confirmation set `scheduled`,
`tenant_selected`, the right window and `pending`; a retry returned `already`
with one appointment and one activity row; re-syncing created no second
calendar event and a `failed` state re-synced cleanly; Agency B saw none of it;
the invoice sequence was never drawn.

**Also fixed here:** the clock-dependent availability test. It now picks the
first matching weekday *after* today, so the afternoon-notice window cannot
make it pass in the morning and fail in the afternoon. The whole suite is green
at any hour.

## Completed work

- Full repository audit (16 September 2026)
- V2 product spec, architecture and implementation plan written
- **V2.0 Foundation**: schema reshaped and regenerated, unified auth with
  roles and organisation scoping, and the domain rules — renewal, pricing,
  invoice numbering, business identity — as pure tested modules

## Next task

**V2.1 Portfolio.** The schema and the guards are in place, so this is screens
and queries: `/portal` shell and sign-in, landlords, properties, tenancies, and
a property detail page.

Two things to do first, in this order:

1. ~~Configure Neon, apply `0000`, create an administrator.~~ **All done and
   verified, 17 September 2026.**
2. **Route every portfolio read through `organisationCondition`** from
   `lib/auth/scope.ts`. A handler that builds its own `WHERE` is the failure
   mode the whole design is arranged to make hard.
3. **Push the branch.** V2.0 and V2.1 exist on one machine and nowhere else.

The next V2.1 slice is the `/portal` shell and agency sign-in, then landlords,
properties and tenancies.

## Major decisions

1. **Extend the existing Next.js monolith.** No new service, no queue broker,
   no separate API. See `V2_ARCHITECTURE.md` § "Why nothing new was added".
2. **Postgres is the operational record; Google Calendar stays scheduling;
   Resend stays communication.**
3. **The code product registry keeps the public list price. Agent pricing is a
   separate database layer that overrides it for agent jobs only.** The £45
   consumer CP12 is untouched by anything an agent negotiates.
4. **Certificate Issued and Invoiced are derived, not lifecycle statuses.**
   A job can be completed, certificated and invoiced at once; one enum cannot
   say that. `lib/jobs/derived.ts`.
5. **Deadline risk is computed, never stored.**
6. **Tenant sessions are not Auth.js.** A path-scoped, short-lived signed
   cookie carrying a job id and nothing else. Not built yet (V2.3).
7. **The CP12 generator and the invoice generator are reused, not rebuilt.**
8. **V1's `/api/book` gains exactly one new step** — a best-effort persistence
   write that cannot fail a booking. **Not yet written**; it moved from V2.0 to
   V2.1 because it needs a live database to be verifiable.
9. **One user table, not two.** `app_user` holds BSCJ staff and agency users.
   A second login path is a second place to get password comparison, timing and
   deactivation subtly wrong.
10. **The session token identifies the user and nothing more.** Role and
    organisation are re-read from the database on every request, so
    deactivating an account takes effect immediately rather than in eight
    hours.
11. **An engineer is scoped by assignment, not by organisation.** Modelling one
    as an organisation-less admin would hand them everyone's data.
12. **A tenancy, not a tenant.** An occupancy with a period, so a new tenant
    does not erase who we actually contacted last year.
13. **An invoice is a header plus lines.** The only shape a consolidated
    monthly agent invoice fits in.
14. **Issued certificates are versioned, never updated.** A correction is a new
    row pointing at the one it supersedes.
15. **`activity` and `audit_event` are separate tables.** One is the agent's
    timeline; the other is the security log.
16. **A new agent account authorises no remedial spend.**
    `remedial_authority_pence` defaults to `0`, so an engineer puts nothing
    right without asking. Raising it is a deliberate, recorded decision per
    account (`agent_organisation.remedial_authority_pence`) or per job
    (`job.remedial_authority_pence`, which is null until someone sets it).

## Blocker decisions — resolved 16–17 September 2026

| # | Decision | Where it lives |
| --- | --- | --- |
| 1 | **Renewal** = inspection date + 12 months − 1 day | `lib/compliance/renewal.ts`, one implementation, tested |
| 2 | **VAT**: BSCJ is *not* registered. Modelled in full, switched off, no VAT wording rendered | `lib/settings/business-identity.ts`, `invoice.vat_*` |
| 3 | **Invoice numbers**: new `BSCJ-######` series from a Postgres sequence, starting at `BSCJ-001000` (17 September 2026) so the first invoice is not obviously the first. The `D-` series is not continued | `lib/invoices/number.ts`, `drizzle/0001` |
| 4 | **Identity is configuration**, not code: display name, legal entity, company number, address, contact, footer, VAT — all settings, snapshotted onto each invoice | `lib/settings/business-identity.ts`, `invoice.identity_snapshot` |
| 5 | **Volume tiers** committed in advance per month; bands 1-14 … 100+; prices per service and tier, agent overrides supported; price frozen on the job | `lib/pricing/*`, `volume_commitment`, `pricing_agreement_line` |
| 6 | **Generators** are reused, not rebuilt. Integration is V2.5 | — |
| 7 | **Remedial authority for a new agent account is £0** — nothing is put right without asking. Confirmed 17 September 2026 | `agent_organisation.remedial_authority_pence` default `0` |

## Still open — need BSCJ input

1. **Agent pricing figures.** The tier *mechanism* is built and tested; no
   figures are in the code. The 75-at-£39.99 example in the brief is an
   illustration and has not been entered anywhere. Nothing can be quoted to an
   agent until real numbers are approved. *(Needed for V2.2.)*
2. **Legal entity change.** BSCJ Solutions is expected to be incorporated
   around 4–5 October 2026. Nothing is hard-coded, so this is a settings edit
   when it happens — but the settings are empty and no invoice can be issued
   until they are filled. *(Needed for V2.5.)*
3. **Invoice footer wording and payment terms.** Confirmed as "to be supplied
   separately". `canIssueInvoices()` refuses until they are. *(V2.5.)*
4. ~~**Default remedial authorisation threshold.**~~ **Confirmed 17 September
   2026: £0.** A new agent account authorises nothing without asking. Anything
   above zero is a deliberate, recorded decision per account or per job.
5. **Both generators are still untracked**, in `~/Gas Cert Generator/` and
   `~/Invoice Generator/`, on one machine. They should be under version
   control before V2.5 depends on them.
6. ~~**Neon is not provisioned.**~~ **Done, 17 September 2026.** Provisioned,
   migrated and verified. `drizzle.config.ts` now loads `.env.local` itself, so
   `source .env.local` is no longer needed before `db:migrate`.~~

## Known issues, V2

- **The branch is unpushed.** No upstream is set. This is the highest-value
  thing to fix and costs one command.
- **Next 16 deprecates the `middleware` file convention** in favour of
  `proxy`. The build warns; it still works. Renaming touches several
  structural tests that read `src/middleware.ts` by path, so it stays queued
  for V2.8 rather than being folded into a feature milestone.

## Known issues, unrelated to V2

- ~~Clock-dependent tests in `src/app/api/availability/route.test.ts`.~~
  **Fixed 17 September 2026** as part of V2.3: the helper now skips today, so
  the notice window cannot make the suite time-of-day dependent.
- `docs/business-details.md` says "Maximum bookings per day: 8"; the code and
  `CLAUDE.md` both say ten. The code is authoritative; the doc is stale.
- `BOOKING_NOTIFICATION_EMAIL` is in `.env.example` but not in `.env.local`,
  so internal booking alerts are silently not sent in development.
