# V2 — current state

**Read this first.** It exists so a new session does not have to re-audit the
repository. Update it at the end of every piece of work.

Last updated: 22 September 2026 (release-readiness correction pass; migration 0009 outstanding).

---

## Current milestone

**V2.0 Foundation — COMPLETE AND OPERATIONAL, verified 17 September 2026.**

**V2.1 Portfolio — complete.** V1 bookings persist as jobs, agency accounts
exist end to end, and the portfolio (landlords, properties, tenancies,
compliance dates) works.

**V2.2 Jobs — complete.** An agency can book work against its own property.

**V2.3 Tenant scheduling — complete.** A tenant reaches their own job through
a link or a reference, picks a real slot on the existing availability engine
and confirms it.

**V2.4 Operations and engineer — complete.**

**V2.5 Certificates — complete.** Upload, review, release, delivery.

**V2.8 Invoicing — complete.** Draft, issue, deliver, settle.

**V2.9 Onboarding and import — complete, 19 September 2026, uncommitted.**
Agency owners are invited by expiring single-use link and set their own
password; BSCJ never chooses or sees one. A password reset ends existing
sessions immediately. Agencies import their portfolio from CSV through a
reviewed preview that writes nothing until confirmed. Migration `0007` is
applied to development. **Still outstanding for V2.9:** the agent-facing
public page and the operational runbook.

## Where the code is

Branch `v2-compliance-platform`, at `44b047a`, three commits past the last V1
commit (`6bd7c91`). Working tree clean.

**The branch is local only — it has no upstream and has not been pushed.**
That is the one outstanding risk to V2.0: the work exists on one machine.

**V2 is not deployed to production, but the schema is live on the Neon
development database** and the admin surface works against it.

**The schema is no longer free to reshape in place.** From here a change is a
new migration, not an edit to `0000`.

## Onboarding and account credentials — the shape to know

1. **`app_user.password_hash` is nullable**, and null means *invited, not yet
   accepted*. `authenticateUser` refuses it at exactly the cost of refusing a
   wrong password, so the state is not measurable from the login form.
2. **`account_credential` is a separate table from `scheduling_token`, on
   purpose.** A tenant's scheduling link is reusable by design; an account
   credential is single-use. One table would mean one `used_at` column
   carrying two opposite rules, and one day carrying the wrong one.
3. **The purpose is inside the hash**, not beside it, so a reset token
   presented at the invitation door matches nothing — the separation survives
   a forgotten `WHERE` clause.
4. **Opening a link consumes nothing.** Mail clients prefetch; scanners follow.
   The credential is spent by the submission, in one atomic statement, so two
   browsers racing produce exactly one winner.
5. **`app_user.session_version` is how a JWT session is revoked.** Signed into
   the token, compared against the column on the row every request already
   re-reads. A reset increments it; every earlier token dies on its next
   request. A token from before the field existed reads as `0`, which is the
   column default, so deploying it signs nobody out.
6. **Nothing logs a token, ever.** The plain value exists in the worker that
   minted it and in the message body. `redactToken()` returns `<token>` — not
   a prefix, because eight characters of sixty-four is still a head start.

## Portfolio import — the shape to know

7. **No uploaded file is retained.** The reviewed plan travels in an
   HMAC-signed envelope bound to the organisation, with a nonce and a one-hour
   expiry. An abandoned preview leaves nothing behind at all.
8. **`portfolio_import (agent_organisation_id, plan_digest)` is unique**, and
   that index — not a read-then-write — is what makes confirmation retry-safe.
   The loser of a double-submit is shown what the winner did.
9. **Conflicts default to doing nothing**, every difference states its effect
   in plain words, and history is preserved: a tenancy is replaced rather than
   overwritten, a compliance position superseded rather than edited.
10. **A blank column is "not stated", never an instruction.** An omitted tenant
    column does not end a tenancy; an omitted date does not clear one.
11. **An import creates no job, contacts no tenant and books nothing.** Held by
    a structural test over the whole import directory.

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

## V2.9 closeout — verified 19 September 2026

Three scenarios were run against the development database and the fixture
harness. One real defect was found and fixed; the other two held.

**1. A superseded credential must never set a password.** Held, with no gap.
Two invitations for one account: redeeming the newer refuses the older and the
password is unchanged. The same across purposes — an outstanding *invitation*
is dead once a *reset* has been redeemed. Two **different** valid credentials
submitted concurrently produce exactly one winner, six runs out of six, with
`session_version` incremented once.

The mechanism is designed rather than emergent, which was worth confirming: the
winner's `revoked` CTE sets `revoked_at`, and the loser's `claimed` guard
includes `revoked_at IS NULL`. Under READ COMMITTED the loser's UPDATE blocks on
the row lock, then re-evaluates its `WHERE` against the committed row and
matches nothing. No deadlock occurred in any run. Opening a link still consumes
nothing: five opens leave `consumed_at` and `revoked_at` null and the credential
still redeems.

**2. A stale approval must not overwrite a changed record. — DEFECT FOUND AND
FIXED.** It was real and it was destructive. An agent approved "replace Nina
with Priya"; a colleague changed the tenant to Sam before Confirm; the import
ended **Sam's** tenancy under an approval nobody had given for Sam. The agent
never saw Sam.

The fix is `fingerprintOf` in `lib/portfolio/import/plan.ts`: the state each
conflict was judged against is hashed, carried **inside the signed envelope**,
and re-checked against a fresh read at write time. Any movement and the row is
left completely alone with "This property changed after you reviewed it".
Verified for the tenancy case and the certificate-date case, and verified not to
false-positive: an untouched record still applies normally, and a phone number
reformatted from `01902 000000` to `+441902000000` is not treated as an edit.
A database read failure yields an empty snapshot, which makes every conflict
skip rather than apply on a guess.

**3. An interrupted import must be safe to re-upload.** Held. A five-row import
was killed after two rows, leaving its row on `running` with no result. The
agent re-uploads the same file: the preview reports the two as "already match"
and offers the remaining three, the new nonce makes it a new review rather than
a blocked repeat, and confirming wrote exactly three. Afterwards: five
properties one per address, one tenancy each with none ended, one compliance
cycle each with none superseded, and one landlord row reused across all five.
No duplicate properties, no tenancy replacement churn, no compliance history
churn.

**No automatic recovery was added**, because none is needed to prevent those
defects — re-uploading already produces the right outcome. What was added is
**honest reporting**: `listUnfinishedImports` surfaces a stalled run on the
import page. It deliberately shows **no counts**, because a stalled row's
counters are still at zero and that is not the truth; it says we cannot tell how
far it got and that re-uploading is how to find out.

### Migration 0007 — actual status

*As recorded at the time; `0008` has since been added — see "Migration 0008"
below.* `0007_account_onboarding` is **applied to the development database
only** (19 September 2026). It has **not** been applied to production, and
production has no V2 deployment to apply it to. `npm run db:status` reported
8 of 8 applied, 24 tables, 22 enums. The invoice sequence was not touched: `last_value` is
`1001`, so the next number is still `BSCJ-001002`, exactly as before this phase.

No further migration was created during closeout — the fix in (2) carries its
state inside the existing signed envelope and needed no schema change.

### Fixture data

This phase's fixtures were removed: `Fixture Lettings`, `Rival Lettings`, their
users, properties, landlords, tenancies, compliance cycles, import records,
credentials and queued messages, plus the `@example.invalid` staff account.
**Preserved:** the real `admin@bscj-solutions.com`, and all 62 `audit_event`
rows — the log is append-only and is the record of what this phase did.

---

## Pilot preparation — 20 September 2026

### Repository state, resolved

One checkout only: `/Users/tegjot/Projects/bscj-gas-website`, with a real
`.git` directory (not a worktree or a gitfile). A filesystem sweep found no
second clone, so nothing is stranded and no recovery is needed. `HEAD` is
`0e03282` on `v2-compliance-platform`. See the corrected entry under "Known
issues, V2" for the push position.

### Transactional links no longer point at production from everywhere

`business.url` was a single constant doing two different jobs. It is the
canonical **marketing** origin — right for the sitemap, `robots`,
`metadataBase`, schema.org and an email footer, in every environment. It was
also being used to build **transactional** links: account invitations, password
resets, tenant scheduling links and portal deep links. So an invitation minted
anywhere but production pointed at production, where the account does not exist
and the token hashes to nothing — the link looks forged to the recipient and
broken to us. That is precisely the configuration a pilot runs in.

`lib/config/origin.ts` now resolves the app origin server-side, validated, with
explicit behaviour per deployment: an explicit `BSCJ_APP_ORIGIN` wins
everywhere; production falls back to the canonical origin, so a correct
production deployment needs no new variable; a preview uses the
platform-injected `VERCEL_URL`; development uses localhost. `VERCEL_ENV` is
read rather than `NODE_ENV`, because a preview builds with
`NODE_ENV=production` and reading `NODE_ENV` alone is how a preview sends
production links.

**No request header is read.** `Host` and `X-Forwarded-Host` are attacker
controlled, and a request carrying `Host: evil.example` must not be able to
mint an invitation pointing there — the token in it is a working credential.
A structural test asserts the module reads no header, and a second asserts the
outbox no longer references `business.url` at all.

An unresolvable origin is a refusal, not a fallback: an invitation is *its*
link, so it is left queued with `app_origin_not_configured` and the credential
is not minted. A certificate or invoice degrades instead — it carries the
document as an attachment, so the convenience portal link is simply omitted.

### The scheduler — resolved, and a method defect found

> **Superseded on the interval only.** This section records `* * * * *`. The
> schedule in `vercel.json`, and in force on the pilot, is **`*/15 * * * *`** —
> see "Automatic email processing" below for why. Everything else here still
> stands.

**Vercel Pro is now active**, so `vercel.json` declared `* * * * *`: the outbox
drained once a minute. Pro allows a one-minute minimum with per-minute
precision; Hobby is once a day and rejects a sub-daily expression at deploy
time, which is why the expression requires Pro.

**A defect was found while confirming this.** Vercel Cron invokes a job with a
**GET**, and `/api/cron/outbox` was POST-only — every scheduled run would have
answered `405` and the queue would never have drained, silently. Nothing in the
application reports that state: every invitation, reset, tenant link,
certificate and invoice would simply have sat `pending` while the site looked
healthy.

Fixed by giving the route a GET handler that requires
`Authorization: Bearer $CRON_SECRET` **with no session or same-origin
fallback**. The original objection to a mutating GET — that prefetchers and
link checkers follow it — is answered by the credential rather than the method:
without the secret a GET is `401` and changes nothing. POST keeps the
administrator's same-origin manual drain. `vercel-cron/1.0` and
`x-vercel-cron-schedule` are deliberately *not* treated as credentials; both
are request headers anyone can send.

Verified against a live server: GET with no credential `401`, GET with a wrong
bearer `401`, GET with the correct bearer `200` and drains, POST with the
correct bearer `200`.

**Cron runs against a project's production deployment**, not a preview. That is
why the pilot is a **separate Vercel project tracking `v2-compliance-platform`**,
whose production deployment *is* the pilot, with its own database, calendar,
Redis, Blob store and controlled recipients. A preview of this branch on the
existing project would never drain. The live site is unaffected: the existing
project keeps deploying `main`.

Also confirmed and documented in the runbook: delivery is best effort, a failed
invocation is **not** retried, the same run can occasionally fire twice, and
overlap is possible at one-minute intervals. The drain is already safe on all
counts — it reconciles outstanding work rather than a delta, claims each row
conditionally under a 120-second lease, and sends with a stable provider
idempotency key.

*Historical:* before Pro, `vercel.json` declared `*/10 * * * *`, which Hobby
rejects at deploy time. The options recorded then were Pro, a once-daily
schedule, or an external scheduler. Pro resolved it. The external-scheduler
route still works unchanged if it is ever wanted — the endpoint's bearer auth
is not Vercel-specific.

### Fixture mode and local storage cannot reach production

Checked, no change needed. `scripts/browser-fixtures.mjs` throws when
`NODE_ENV=production`, additionally requires an opt-in `BSCJ_TEST_FIXTURES=1`,
and lives outside `src` where nothing can import it. The local document driver
is refused by `storageStatus()` when `NODE_ENV=production`, and that check is
at the chokepoint every read and write already passes through, not merely on a
status screen.

### `npm run preflight`

New, and offline: it reports which configuration is **present**, never whether
it works, and prints no value — not truncated, not masked. It also flags the
cron plan limitation above. Turning "set" into "verified" is the runbook's job.

### Still not done

*At that checkpoint.* `0007` remained applied to development only. No migration
was created that phase. Nothing was provisioned, purchased, pushed or deployed, and no live
write or real email was made.

---

## Typecheck needs generated route types

`npm run typecheck` is `next typegen && tsc --noEmit`, not bare `tsc`.

`src/app/layout.tsx` uses `LayoutProps<"/">`, which Next **generates** into
`.next/types/routes.d.ts`; `tsconfig.json` includes that path. So the type
exists only after a build, a dev server, or `next typegen`. Locally it passed
because `.next` was already populated from earlier builds — on a clean
checkout, which is what Vercel's standalone TypeCheck runs, it failed with
`TS2304: Cannot find name 'LayoutProps'`.

Reproduced and fixed in a clean detached worktree with no `.next`, no
incremental caches, no `node_modules` and no local environment files: bare
`tsc --noEmit` reproduced the exact error, and `next typegen && tsc --noEmit`
exited 0, after which the build compiled.

`LayoutProps` and `strict` are unchanged — the error was never suppressed, only
given the types it needed. `next typegen` reads no environment and touches no
service, and `.next` stays ignored so nothing generated is committed. Any CI
step running a bare `tsc` will need the same prefix.

---

## Pilot database — brought up 20 September 2026

**Owner-observed**, using the guarded commands. Reported terminal output:
`Mode: pilot` with the confirmed endpoint matching; migrations `0000`–`0007`
applied; **24 tables, 22 enums**; invoice sequence next number
**`BSCJ-001000`**, none issued; administrator `admin@bscj-solutions.com`
created with `role=admin`.

That matches the expected post-migration state exactly. It is **not
independently verified** — nothing on the development machine can reach the
pilot database, and it holds no pilot credentials by design. The development
database is unchanged and separate: still 8/8 applied, 24 tables, next invoice
`BSCJ-001002`.

**Do not re-run the migration or the bootstrap.** `db:migrate` is idempotent
and would be a no-op, but `admin:create` against an existing address is a
*reset*, not a create — it would change the password, sign out every session
and revoke outstanding links. It now requires the address to be retyped first.

### Scheduled processing — being activated 21 September 2026

A submitted agency job left "Invitation to book → tenant: Queued, not yet
attempted" with no Resend send, because nothing drains the queue: `CRON_SECRET`
was deliberately absent, so every cron invocation returned `401` before
touching the database. Requiring a browser-console POST is not a delivery
mechanism.

The schedule is now **`*/15 * * * *`**, down from every minute. Any interval
under five minutes never lets a Neon Free compute idle — it suspends after five
minutes and cannot be told otherwise — so every-minute polling runs the compute
continuously at roughly 182 CU-hours against a 100 CU-hour monthly allowance,
exhausting it in about sixteen days. Fifteen minutes costs roughly 61, which is
a model rather than measured usage. **Expected email delay: up to 15 minutes,
around 7–8 on average**, for every queued message.

**No other change was needed.** The route already takes the scheduler's GET
with bearer auth and no session fallback, keeps POST for the administrator's
manual drain, retries per row under a 120-second lease, and sends with a stable
provider idempotency key. Function duration needs no configuration either:
Vercel's default is 300 seconds and the drain's worst case is about 200.

Activation is two owner steps — set `CRON_SECRET` on the pilot project
(Production only) and redeploy, since both a schedule change and a new variable
need one. `PILOT_RUNBOOK.md` § 2B.3.

### Activated, and observed

**`CRON_SECRET` is configured on the pilot project** (Production only) and
`/api/cron/outbox` runs every 15 minutes — owner-reported, 21 September 2026.
**Do not regenerate it.** A secret that differs between Vercel and the
deployment makes every invocation `401`, and nothing in the application reports
that state.

Scheduled processing **has** been observed: the queued invitation was delivered
by a drain and the tenant booked from it, recorded under "First tenant journey"
below. The three individual pieces of evidence in §2B.4 — the `GET … 200` in
the cron log, the matching Resend send, the admin page no longer showing
"Queued" — were not separately recorded at the time, so they remain the checks
to repeat if the queue ever stops moving.

**Automatic retries stay unverified even after that succeeds.** A first-attempt
success exercises none of the retry path, and claiming otherwise on that
evidence would be wrong. They remain unproven until a row is actually seen to
fail and be attempted again. Do not manufacture a failure against live services
to close it.

Live delivery through the pilot's own calendar, Blob and Redis services is
likewise unverified, as is certificate and invoice delivery.

Live service delivery is equally unverified — no email has been sent, no
calendar event written, no Blob object stored, and no Redis operation
performed against the pilot's own services. Each becomes verified at the
corresponding step of the § 3 walkthrough, not before.

---

## Pilot tooling — 20 September 2026

Commands are mode-aware. **Development is unchanged**; pilot mode is opt-in by
name (`BSCJ_PILOT=1`) and sealed: `.env.pilot` is the only source, inherited
`DATABASE_URL*` are deleted before the file is applied, `.env.local` is not
read, and a missing file, malformed line or missing value stops the command
before any connection. `src/lib/ops/env-file.ts` and
`src/lib/ops/db-target.ts` are pure and unit-tested; `scripts/load-env.mjs`
does the file I/O and is shared by `db-status`, `create-admin` and
`drizzle.config.ts`, so the three cannot disagree about which database they
mean.

**Correction to an earlier note in this document's runbook companion.** It
claimed "exporting `DATABASE_URL` overrides `DATABASE_URL_UNPOOLED`". It does
not — they are different variables and neither overrides the other. The real
hazard was the *preference* `DATABASE_URL_UNPOOLED ?? DATABASE_URL`: a value
loaded from `.env.local` was used ahead of an exported pilot one, which was
never consulted. Conflicting targets now **stop** rather than warn.

**`BSCJ_APP_ORIGIN` is owner-reported as saved** on the pilot project's
Production environment (`https://bscj-v2-pilot.vercel.app`). Not independently
verified — nothing here can read a Vercel project's variables. It becomes
verified at the first invitation, by checking the link's host.

Admin bootstrap now requires an interactive terminal, reads the password
**without echoing it**, still demands the address be retyped before resetting
an existing account, and no longer upserts: a fresh creation inserts with
`ON CONFLICT DO NOTHING` and stops if the row was taken concurrently, so a
create can never silently become a reset.

Scheduling is **unchanged** (`* * * * *`, inert while `CRON_SECRET` is absent).
The Neon Free compute figures in the runbook are a **model, not measured
usage**.

---

## Agency import profiles — 21 September 2026

Onboarding effort, not a new feature: an agency exports from its own system and
the template's headings are not what comes out. **BSCJ now records how each
agency's spreadsheet is read, once, from `/admin/organisations/<id>`**; the
agency uploads against it. One importer, no per-agency code — adding an agency
is data, and a renamed heading is an edit on a screen.

Stored in `business_setting` under `portfolio-import-profile:<organisationId>`.
The organisation is in the key, so there is no shared row on which a query
could forget a `WHERE`. **No new table, no migration.**

A profile decides the four things a heading cannot: which column is which, what
a second person-name column means, how to read addresses and dates, and what to
do when landlord contact details are missing. Every one defaults to the
cautious reading. In particular `occupierRole` defaults to **no tenancy** — a
tenancy asserts somebody lives there and is who a scheduling link is sent to,
so a column nobody has confirmed is kept as an access note instead.

Combined addresses are split, preserving flat identifiers: "Flat 2, 14 Example
Street" keeps `Flat 2, 14`, because "Flat 2" alone is not unique in a postcode
and "14" alone is the whole building. A unit with no building number is refused
and shown to a person — `house_or_name` plus `postcode` is the key the
duplicate check and the unique index both use, so a wrong split merges or
splits real properties.

**A changed profile invalidates an outstanding preview.** `profileDigest`
travels inside the signed envelope and is compared at confirmation; a change is
a refusal, not a merge. Existing records are never rewritten — a profile
applies to future imports only. Validation, agency isolation, duplicate and
conflict protection, repeat-import safety and preview-before-confirmation are
all unchanged, and importing still sends nothing, creates no job and charges
nobody.

Full rationale and the findings so far: `docs/IMPORT_PROFILES.md`.

**That blocker is now closed in code.** `customer.email` and `customer.phone`
are nullable in `src/lib/db/schema.ts` and in migration
`0008_landlord_contact_optional`; `property.customer_id` stays `NOT NULL`, so a
property still belongs to an identified owner. The requirement moved to the
operations that have to *reach* somebody, which refuse by name when there is no
address for the recipient they chose. Payer identity and recipient selection
are unchanged.

**Migration `0008` is not applied to any database.** It must be applied to the
pilot **before** the current commit is deployed — `PILOT_RUNBOOK.md` §2E.

### Dashboard wording corrected

The portal dashboard still advertised Jobs and Invoices as "coming soon" and
said portal booking was "next", long after all three shipped. An agent reading
it had no way to know the pages existed, which is much the same as not having
built them. Jobs, Invoices and Landlords are now links; Compliance and Support,
which genuinely have no page, still say coming soon.

---

## Release-readiness pass — 21 September 2026

A correction pass over the four unpushed commits, prepared as **one release**.
Nothing was pushed, deployed, migrated or sent.

### The deployment order was recorded wrongly, and is corrected

The four commits are linear, so deploying `4d7511b` deploys `721abb7` with it.
An earlier recommendation to ship the branding commit first and migrate
afterwards was therefore describing a choice that does not exist — and if
followed by deploying the tip, it would run application code that expects
nullable `customer.email` and `customer.phone` against a database that still
refuses them. A contactless import would fail at insert time and the agent
would be told only "That property could not be added".

**Migration first, then push.** `0008` is two `DROP NOT NULL` statements: it
drops nothing, rewrites no data, and the currently-deployed older code cannot
notice it, because that code always supplies both values and nothing has yet
created a row without them. The exact owner steps, the checks around them and
the rollback limits are `PILOT_RUNBOOK.md` §2E.

**Rollback is asymmetric and the runbook says so.** Code rolls back freely;
the schema does not. Restoring `NOT NULL` fails while any landlord has a null
email or phone, which is the state the migration exists to allow. Leaving
`0008` applied is almost always the right answer — a nullable column the code
no longer uses is inert. Nothing is to be invented to satisfy the constraint
and no business record is to be deleted to make the SQL succeed.

### A unique matching name no longer attaches a property

`match_existing_by_name` previously set `matchedLandlordId` on its own when
exactly one landlord of that name existed, and the commit attached the property
to them. A unique name is evidence; it is not identity. Two people share names,
and the second may simply not be recorded yet — so the property, and eventually
an invoice, could land in front of a stranger with nothing downstream to
notice.

It is now a **suggestion requiring an explicit recorded choice**: the preview
asks, per row, whether this is the same person or a different one of the same
name, and **an unanswered row is held** rather than written. Declining records
a second landlord of that name, which is the honest outcome for two distinct
people — nobody is told to merge records because a spreadsheet repeated a name.
An ambiguous name still holds the row, and its message no longer suggests
merging either.

The existing mechanics carry it: the suggested id travels **inside the signed
envelope**, so the browser may accept or decline a suggestion the preview made
and can never name a different landlord; the answer is read as an allow-list of
two values with everything else meaning "unanswered"; `createProperty`
re-checks that the landlord belongs to the agency; and the answer is part of
the plan digest, so answering later is a new import rather than a blocked
repeat.

### Two preview promises the commit was not keeping

Both about a landlord's own details on a property already held:

- **Neither side has an email.** `conflictsBetween` offered "Landlord details"
  as applicable; `commitImport` had nothing to identify the landlord by and
  skipped it. The agent ticked a box and nothing happened. Now reported and
  **not applicable**, with the reason stated.
- **The file names a different landlord.** The preview correctly refused to
  re-parent the property, and the commit — looking the incoming email up across
  the agency — updated *that other landlord's* name, company and phone anyway.
  A landlord record is now only updated when the file carries the same,
  non-empty email as the landlord the property already belongs to, and the
  update goes to that owner **by id** rather than by a search.

### Later dates: tested against production logic, and two wordings fixed

`lib/scheduling/later-dates.ts` is new and holds the rule the tenant scheduler
renders from. The previous test file reimplemented the rule inside itself and
otherwise grepped the component's source, so it would have passed against the
broken component; the cases now run against the code that ships.

Two wordings were wrong against what the page displays:

- **"You are now choosing from times after <date>"** was describing a filter
  the page does not apply — revealing later dates *widens* the list rather than
  replacing it, and the earlier times are still shown. It now says the list
  includes them, and keeps the old sentence only for an overdue job, where
  there is genuinely nothing earlier.
- **"We open more dates as they get closer"** was said in two different
  situations. A diary that does not reach past the deadline will open more; one
  that reaches past it and is fully booked will not, and telling somebody to
  wait when waiting cannot help is the thing worth avoiding. The horizon is
  read off the days the availability API returns — it is **not** widened, and
  `maximumAdvanceDays` is still nowhere near this component.

Covered: a deadline inside, at and beyond the booking window; later dates that
exist, that are all taken, and that the window does not reach; an empty diary;
returning to the earlier list with the reservation retained; and the late
acknowledgement remaining server-decided.

### Documentation corrected

Stale statements reconciled with the code: the cron interval (`*/15`, not every
minute), `CRON_SECRET` (configured and exercised, not "deliberately absent"),
the nullable-contact blocker (closed in code, migration outstanding), the
migration count and which are applied, and the "branch is unpushed" claim.

### What is still unverified

- **Outlook and every other real mail client.** The branded emails were
  rendered in a browser only. Conservative markup is a reason to expect them to
  work, not evidence that they do. `npm run previews` writes both emails, light
  and dark, to the git-ignored `previews/` directory from fictional content and
  sends nothing. No defect was found in them this pass, so they were left
  alone.
- **Automatic retries**, exactly as before.
- **The import identity flow against a real database.** It is proved against
  the planning code and against recording fakes of the mutations, which is
  what `identity.test.ts` is. Nothing on this machine can reach the pilot.

---

## Release-readiness correction pass — 22 September 2026

Four corrections and one new capability. No feature expansion.

### False outstanding-renewal alerts — fixed

`outstanding.ts` asked "is there an active cycle pointing at this certificate"
and called everything else an unresolved repair. That is true of a genuine
failure, and equally true of a certificate a **later visit legitimately
replaced** and of one the rules **correctly declined** to apply (`keep_newer`).
Both would have sat on the reconciliation page for ever advertising work no
retry could do, until everyone learned to ignore the list.

The test is now "would applying this certificate *now* establish or supersede a
position" — `decidePosition`, the same rule the retry uses, so the list can only
contain repairs the button can make. Nothing is deleted and nothing unrelated is
marked superseded. `renewalIsOutstanding` also returns **`unavailable`** rather
than a confident `resolved` when the database cannot be read, and the job page
says so.

### Retry assurances — corrected to what the evidence supports

`retryDuplicationRisk` read the provider's window off `updatedAt`, which moves
on every claim and on the retry itself — so a fortnight-old message reported as
freshly attempted, and each retry made the sentence *more* confident. It now
uses `createdAt`, the only sound lower bound, and says **unlikely** rather than
*will not*: Resend de-duplicates on the key **and a matching payload**, and
nothing stored records whether the content changed.

The credential wording was also wrong about our own code. It claimed only the
newest link works; `credentials.ts` deliberately keeps earlier credentials alive
until one is redeemed, and `access.ts` accepts any unexpired scheduling token.
Both now describe their actual behaviour. **Token validity policy is unchanged.**

### Signed-in browser acceptance — done, with one path blocked

The real Next server now runs against the disposable PostgreSQL. Every key in
`.env.example` is fixed by the harness before Next starts, so no `.env` file can
supply one; the first sign-in is as a fixture administrator who exists only in
the throwaway database, which is the proof rather than a claim. Accounts carry
real password hashes and sign in through the ordinary form — **no bypass**.

`db/disposable.ts` lets the server build a handle for that database behind two
conditions no deployment satisfies: `BSCJ_DISPOSABLE_DB=1` **and** a whitelist
of exact loopback/port/database/user values.

Clicked and verified: profile save, import preview, held rows, the
contactless-landlord consequence, the identity question and its outcome, repeat
import, renewals filtering and pagination, service-correct job matching, agency
isolation, failed-message retry persisting across a refresh, a validation error,
and 375px layout.

**Was blocked, now closed.** Certificate release in a browser was recorded here
as blocked: "the local document store refuses under `NODE_ENV=production`,
`next start` forces production, `next dev` could not run because another
process held the directory."

The diagnosis was half wrong. The Next CLI *does* honour an already-set
`NODE_ENV` — `process.env.NODE_ENV = process.env.NODE_ENV || defaultEnv`. What
actually defeats it is that a production **build** folds
`process.env.NODE_ENV === "production"` away at compile time; the compiled
check in `.next/server` reads `"local" == driver ? { ready: false, … }` with
the comparison gone, so no runtime variable can reach it.

So the harness runs `next dev` — the only configuration the local store
permits, which honours the safeguard rather than working around it — from a
**separate checkout** at the tested revision, so it cannot take a `.next`
another process is holding. Upload, review, release, the renewal moving and
the recovery button were all driven by clicking. See the acceptance pack §0.

What remains unverified is the **Blob driver**, which is a live service. The
screens are the same; the driver underneath them is not.

### Two defects the browser found

The batch shim deadlocked on its own pool connection — an import claimed its
run, wrote nothing and hung. And a row held for **ambiguous identity** was shown
under the hold-policy heading, telling an agent their settings said something
they did not.

---

## Overnight pass — 22 September 2026

**Four confidence levels, kept apart.** Conflating them is how a pilot is
declared ready and then does not work.

| Level | Meaning |
| --- | --- |
| **Historical** | Recorded at an earlier checkpoint. May have been superseded. |
| **Deployed, owner-observed** | The owner saw it happen against the pilot. Not independently verified from this machine, which holds no pilot credentials. |
| **Verified locally** | Tests run here, at the level stated. Unit, service or browser — never live. |
| **Unverified** | Nobody has seen it work. Said so plainly. |

**No disposable database exists on this machine** — no Docker, no Postgres, no
embedded engine — and development and pilot are not disposable. So everything
below marked *verified locally (service)* exercises the real production code
with the **database and external adapters faked at their boundary**. Permissions,
signing, idempotency, ordering, recipient selection and error handling are
genuinely run; the unique indexes, the foreign keys and the real transaction
semantics are not. Nothing here is a live-database or live-delivery pass.

### The import's hold policy was not holding — fixed

*Verified locally (service).* `landlordMatch: reject_row` is labelled "hold the
row for review — nothing is written", and the importer consulted it **only on
the way into the name-matching branch**. Harmless while `customer.email` was
`NOT NULL`; from migration 0008 onwards a contactless row under `reject_row`
fell straight past it and was created. An agency configured for "do not import
it" was importing it, attached to a landlord nobody could contact.

There are now three options and each does what its label says — hold the row,
record without contact, or record without contact and ask about matching names.
None invents an address or a number. The policy sits inside the create branch,
so a property already held is never held for want of an address it would not
have written anyway. Preview wording separates rows *held by policy* from rows
that genuinely could not be read, and counts the properties that will carry an
uncontactable landlord. No profile shape change; `version` stays 2 and
`reject_row` now writes strictly less than before.

### Releasing a certificate now moves the renewal

*Verified locally (service).* `releaseCertificate` wrote a `certificate` row and
stopped, while every screen showing a due date reads `compliance_cycle`. A
reviewed CP12 could be released and the property would still show the old date,
or none.

Release now establishes the position **from the dates the administrator read off
the certificate** — `renewal.ts` is deliberately not applied. A CP12 job moves
the CP12 position; a combined job moves the CP12 and nothing else, because no
certificate attests to a boiler service; a boiler-service job moves nothing.
Older evidence never displaces newer: releasing or correcting an older job
leaves a later position alone, records that it did, and says so with the date it
kept. A correction to the certificate that established the current position
always applies, in either direction.

`setCompliancePosition` hardcoded `cp12` **and superseded every active cycle**,
so recording a CP12 position would have cancelled a boiler-service one. Now
scoped to the one service.

The certificate row and the cycle cannot be one statement — the cycle must point
at the certificate's id — so "released, renewal not moved" is reachable. It is
reported in the release message and cleared by an idempotent **Update the
renewal from this certificate** button that refuses a superseded version.

### `/admin/due` — the weekly operational question

*Verified locally (unit + build).* Overdue, due within a range the operator
chooses and which is shown back to them, and properties with no date on file. No
threshold, cadence or escalation is invented, and **nothing is contacted**. A
property with an open job carries its reference and status so nobody chases work
already in hand.

Deliberately **not** built: admin-initiated job requests. Work is requested by
the agency from their own portal; the page links to the agency and says so
rather than offering a control that would need an impersonation system.

### The message queue is legible and recoverable

*Verified locally (unit + service).* The pilot's failure was a green dashboard
over an undrained queue: counts, no reasons, and a browser console as the only
diagnostic. The queue is now row-by-row, with two distinctions the stored states
cannot make — *queued and never attempted* versus *attempted and waiting*, and
*failed* versus *cannot go until somebody supplies an address*. Both are derived
from the attempt count, the lease and the last reason, so nothing new is stored
and no second queue exists.

`sent` is reported as **accepted by the email provider** everywhere, and the
wording is asserted. A retry is offered only for a message that has genuinely
given up; it resets the bounded attempt count, is safe because the send carries
a stable provider idempotency key, is conditional in the `WHERE` so two
administrators produce one retry, and is audited with the previous reason.

The cron interval, the lease, the attempt bound and the drain are unchanged.

### `/letting-agents` — written, not published

*Verified locally (browser, desktop and 375px).* Describes only what exists. No
agency pricing, no compliance guarantee, no customer numbers or reviews, no
claim of automatic reminders. `noindex`, absent from the sitemap, unlinked.
Needs the owner's sign-off.

### Migration 0009 — prepared, applied nowhere

A partial unique index making one active compliance position per property per
service impossible in the database rather than only in the application. Two
requests arriving together can each read "nothing active" and each insert.
Additive and enforcing only; no column added or dropped, no data rewritten. The
pre-check query is in its header and in the acceptance pack. Rolls back freely —
dropping an index touches no data.

### What this pass did **not** verify

- Anything against a real Postgres.
- The deployed CSV identity/review/commit journey, which is the owner's to run.
- Automatic outbox retries against a real provider failure.
- Actual Outlook or any real mail client.
- Live calendar, Blob and Redis behaviour.
- The engineer, document and invoice journeys end to end in a browser — they
  need a database and a signed-in engineer.

Morning acceptance pack: `docs/acceptance/README.md`. Night's log:
`docs/OVERNIGHT_PROGRESS.md`.

---

## First tenant journey — 21 September 2026, owner-observed

Invitation received **02:30**, tenant booked **02:39**, confirmation received
**02:45**, and the appointment **visible in the dedicated pilot Google
Calendar**. One pass exercising the scheduled drain, the link's host, the
scheduling flow, the hold and confirm, the calendar write landing on the pilot
calendar rather than the live diary, and the confirmation send.

**Owner-observed, not independently verified.** Nothing on the development
machine can reach the pilot's services.

**Automatic retry remains unverified.** A first-attempt success exercises none
of the retry path. It stays unproven until a row is actually seen to fail and
be attempted again, and a failure must not be manufactured against live
services to close it.

---

## Outstanding before launch — the complete list

Everything below is inherited from earlier phases as well as this one. It is the
full list, not the pilot subset.

### Blocked on BSCJ supplying information

1. **Agent pricing figures.** The tier mechanism is built and tested; no figure
   is in the code. Nothing can be quoted to an agent until real numbers are
   approved. Until then an organisation with no agreement pays list price.
   *(V2.2.)*
2. **Legal entity.** BSCJ Solutions was expected to incorporate around
   4–5 October 2026. Nothing is hard-coded — it is a settings edit — but the
   settings are empty and **no invoice can be issued** until they are filled.
   *(V2.5.)*
3. **Invoice footer wording and payment terms.** "To be supplied separately".
   `canIssueInvoices()` refuses until they exist. *(V2.5.)*
4. **A CP12 renewal interval** is configuration and is still empty. The rule
   `inspection + 12 months − 1 day` is implemented and tested, but nothing has
   been confirmed as the business's own policy.

### Blocked on work not yet done

5. **Admin screens for pricing agreements**, `pricing_agreement_line` and
   `volume_commitment`. The resolution path works and is proved against a
   hand-inserted agreement; there is no UI to enter one. Gated behind (1).
   *(V2.2.)*
6. **Both generators are still untracked**, in `~/Gas Cert Generator/` and
   `~/Invoice Generator/`, on one machine. They should be in version control.
7. **A reconciliation view** listing calendar bookings with no job row. *(V2.1.)*
8. **The agent-facing public page** explaining the managed service. No pricing
   tiers unless and until they are approved. *(V2.9, not done.)*
9. **The operational runbook**: what to do when a calendar sync fails, an email
   will not send, a tenant cannot be reached, a certificate needs correcting.
   *(V2.9, not done.)*
10. **Optional TOTP for admin accounts.** `app_user.totp_secret` exists and is
    unused. *(V2.8.)*
11. **Impersonation / "view as"** for supporting an agent. Deliberately absent:
    `requireAgent()` refuses an administrator rather than inventing one.

### Deployment and configuration

12. **The branch is ahead of its upstream**, not unpushed — see the correction
    under "Known issues, V2". `v2-compliance-platform` tracks
    `origin/v2-compliance-platform`, and four local commits (`67bb2be`,
    `721abb7`, `7087b74`, `4d7511b`) are not pushed. They are linear, so the
    push is a fast-forward and deploys all four together.
13. **V2 is not on the live site.** `main` and `www.bscj-solutions.com` are
    untouched. It *is* deployed to the separate pilot project at
    `bscj-v2-pilot.vercel.app`, at an earlier commit than the branch tip.
14. **Environment variables required in production**, none of which are set
    there yet:
    - `DATABASE_URL` — nothing works without it
    - `AUTH_SECRET` — **account credentials and import envelopes fail closed
      without it.** New hard dependency from V2.9
    - `BSCJ_APP_ORIGIN` — **required on anything that is not production**, or
      invitations point at production. New from this phase
    - `SCHEDULING_TOKEN_SECRET` — tenant links *(V2.3)*
    - `BLOB_READ_WRITE_TOKEN` — document storage *(V2.5)*
    - `CRON_SECRET` — the outbox schedule *(V2.6)*
    - `RESEND_API_KEY`, `BOOKING_EMAIL_FROM` — all outbound mail
    - `BOOKING_NOTIFICATION_EMAIL` — also missing locally, so internal booking
      alerts are silently not sent in development
15. **A schedule on `/api/cron/outbox`.** Without it nothing in the queue is
    ever sent: no tenant invitation, no certificate, no invoice, and **no
    account invitation or password reset**. An agency invited with no schedule
    running simply never hears from us.
16. **Migration 0009 must be applied** to any database the current commit is
    deployed against. `0000`–`0008` are applied to the pilot (owner-observed,
    9/9, 24 tables, 22 enums); **`0009` is applied nowhere.** Order matters and
    is documented in `PILOT_RUNBOOK.md` §2E and `docs/acceptance/README.md` §4:
    check the pre-condition, migrate, verify, *then* push.

### Known issues

17. **Next 16 deprecates the `middleware` file convention** in favour of
    `proxy`. The build warns and still works. Renaming touches structural tests
    that read `src/middleware.ts` by path.
18. `docs/business-details.md` says "Maximum bookings per day: 8"; the code and
    `CLAUDE.md` say ten. The code is authoritative; the doc is stale.
19. One pre-existing lint warning: an unused `invitationRow` import in
    `src/lib/notifications/outbox.test.ts`. Predates this phase.

---

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

- ~~**The branch is unpushed. No upstream is set.**~~ **Wrong, corrected
  20 September 2026.** `origin` has been configured all along, at
  `https://github.com/TegjotSingh08/bscj-gas-website.git`, and
  `v2-compliance-platform` tracks `origin/v2-compliance-platform`. The real
  position is narrower: **two local commits are unpushed** — `f1769d7` (V2.8
  invoicing) and `0e03282` (V2.9 onboarding and import) — against
  `origin/v2-compliance-platform` at `43ecd5b`. Ahead 2, behind 0, so a plain
  fast-forward. Local `main` is likewise ahead 1 of `origin/main`, and that
  commit is already contained in the V2 branch.

  The claim was wrong twice over and both sources are worth naming: this
  document asserted it at an earlier checkpoint and it was carried forward
  unverified, and a later session ran `git remote -v | wc -l`, got `2` — which
  is one remote, printed as a fetch line and a push line — and reported "no
  remote configured" from a label typed into the command rather than from the
  output. Verify remotes with `git remote -v` and `git branch -vv`, not with a
  line count.
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
