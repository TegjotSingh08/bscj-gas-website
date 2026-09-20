# Controlled pilot runbook

One agency, fictional records, a dedicated calendar and a controlled set of
recipients, taken end to end: **invitation → import → job → tenant booking →
engineer completion → certificate → invoice → payment**.

Written to be followed by the owner. Nothing in it has been executed: no live
write has been made, no email sent, and no service provisioned.

**Read `V2_CURRENT_STATE.md` § "Outstanding before launch" first.** This runbook
covers the *pilot*; that list covers everything still outstanding.

---

## 0. Before anything

```bash
npm run preflight
```

Read-only, offline, prints no value. It reports **presence**, never liveness —
a `[set]` means the variable exists, not that the credential works. Section 1
below is what turns `[set]` into verified.

---

## 1. Configuration

### 1.1 The distinction that matters

| | Meaning | How it becomes verified |
| --- | --- | --- |
| **Missing** | The variable is absent. The feature is off and says so. | Set it. |
| **Set, unverified** | Present and well-formed. Nothing has used it yet. | The live checks in 1.3. |
| **Verified** | A real call succeeded against it. | Only after 1.3. |

Most of a fresh deployment sits in the middle row, and that is the row that
hurts: a wrong Resend key looks identical to a right one until something needs
to send.

### 1.2 What the pilot needs

**Authentication**
- `DATABASE_URL` — the pilot database. **Migration `0007` must be applied to it**;
  it is applied to development only today. Check with `npm run db:status`.
- `AUTH_SECRET` — signs sessions, account credentials **and** import envelopes.
  All three fail closed without it. A fresh random value for the pilot
  environment; changing it later signs everyone out and invalidates every
  outstanding invitation, which is the correct behaviour but a surprising one.
- `BSCJ_APP_ORIGIN` — **set this for anything that is not production.** Without
  it a pilot invitation points at `www.bscj-solutions.com`, where the account
  does not exist. Origin only, https unless localhost.

**Calendar — use a dedicated pilot calendar**
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_CALENDAR_ID`.
- Create a **new** Google calendar named e.g. `BSCJ PILOT — do not use for real work`
  and share it with the service account as *Make changes to events*.
- `GOOGLE_CALENDAR_ID` must be that calendar. Pointing the pilot at the live
  diary would let fictional tenants consume real availability and put fictional
  appointments in front of the engineer.

**Redis**
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
- Holds, the daily cap and rate limits. Without it these fall back to a
  per-instance counter, which is close to meaningless across serverless
  instances — usable for a demo, not for a pilot that tests the daily limit.

**Resend — controlled recipients**
- `RESEND_API_KEY`, `BOOKING_EMAIL_FROM` (a verified sending domain),
  `BOOKING_NOTIFICATION_EMAIL`, optionally `BOOKING_EMAIL_REPLY_TO`.
- **Every address used in the pilot must be one the owner controls.** Use
  plus-addressing on a real inbox — `owner+pilot-agency@…`,
  `owner+pilot-tenant@…`, `owner+pilot-landlord@…` — so every message is
  receivable and obviously fictional.
- Do **not** use `@example.invalid` addresses here. They are correct for unit
  fixtures and are undeliverable; the pilot has to prove delivery.

**Blob storage**
- Attach a Vercel Blob store; `BLOB_READ_WRITE_TOKEN` is injected and nothing
  else is needed. The local driver refuses to run when `NODE_ENV=production`.

**Scheduled processing**
- `CRON_SECRET`, at least 24 characters. Vercel sends it automatically as an
  `Authorization: Bearer` header on every cron invocation.
- Set it on the **pilot project**, not the live one. See §2.

### 1.3 Turning "set" into "verified"

Run these in order. Each is a read or a scoped write inside the pilot's own
fixtures; none touches real customer data.

1. `npm run db:status` — connects, lists migrations, confirms `0007` applied,
   prints the invoice sequence. Read-only.
2. Sign in at `/admin/login` — proves `DATABASE_URL` + `AUTH_SECRET`.
3. Open `/book` and load availability — proves Google Calendar **read** and
   Redis.
4. Create the pilot agency and invite the owner (§3.1) — the first real send;
   proves Resend and `BSCJ_APP_ORIGIN` together. **If the link in that email
   does not point at the pilot host, stop and fix `BSCJ_APP_ORIGIN`.**
5. Upload a certificate on a pilot job — proves Blob.
6. Drain the outbox once by hand (§2.4) — proves `CRON_SECRET`.

---

## 2. The scheduler

**Vercel Pro is active**, so the outbox drains once a minute:

```json
{ "path": "/api/cron/outbox", "schedule": "* * * * *" }
```

Per Vercel's published limits (docs updated 2026-07-15), Pro allows a minimum
interval of once per minute with per-minute precision. Hobby is once per day
and **rejects a sub-daily expression at deploy time** rather than running it
less often — which is why this expression requires Pro and why `npm run
preflight` states that requirement.

### 2.1 Cron runs against a project's PRODUCTION deployment

This is the fact the pilot's shape turns on. Vercel invokes a cron job by
making an HTTP request **to the project's production deployment URL**. It does
not run against preview or branch deployments.

So a preview of `v2-compliance-platform` on the existing project would never
drain: the queue would fill and nothing would send, silently.

**The pilot is therefore its own Vercel project**, tracking this V2 branch,
with that project's *production* deployment being the pilot environment:

| | Existing project | Pilot project |
| --- | --- | --- |
| Production branch | `main` (V1 site) | `v2-compliance-platform` |
| Cron | none needed | `* * * * *` on `/api/cron/outbox` |
| Database | — | its own Neon database or branch |
| Calendar | live diary | **dedicated pilot calendar** |
| Blob | — | its own store |
| Redis | live | its own Upstash database |
| Email | live recipients | **controlled recipients only** |
| `BSCJ_APP_ORIGIN` | unset (canonical) | the pilot host |

Nothing is shared between them. A pilot that reached the live calendar, the
live Redis or a real customer's address would be worse than no pilot.

**The live site is untouched by this.** The existing project keeps deploying
`main`; the pilot project is additive and separate.

### 2.2 The method, and why it matters

Vercel Cron invokes a job with a **GET**. `/api/cron/outbox` was POST-only,
so every scheduled run would have answered `405` and the queue would never
have drained — with nothing in the application reporting it. Fixed: **GET is
the scheduler's door and requires `Authorization: Bearer $CRON_SECRET` with no
session fallback**, so a prefetcher or link checker gets `401` and changes
nothing. POST remains the administrator's same-origin manual drain.

Vercel also sends a `vercel-cron/1.0` user agent and an
`x-vercel-cron-schedule` header. Neither is used for authentication — both are
request headers that anyone can send. Only the secret proves anything.

### 2.3 What the schedule does and does not guarantee

- **Delivery is best effort.** A run can be missed, and the same run can
  occasionally be invoked twice. Vercel does **not** retry a failed
  invocation.
- That is safe here because the drain is idempotent and reconciliation-based:
  it queries outstanding work rather than processing a delta, each row is
  claimed conditionally, and Resend receives a stable idempotency key. A
  missed minute is picked up by the next one.
- **Overlap is handled.** At one minute an invocation can start while the
  previous is still running. The outbox takes a 120-second lease on each
  claimed row, which is the lock pattern Vercel's own guidance recommends, so
  a second worker walks past rows in flight.
- **The timezone is always UTC.** Irrelevant to an interval drain; it matters
  for any future date-based sweep.
- **Changing the schedule needs a redeploy**, and an Instant Rollback does
  **not** update active cron jobs.
- **Cron does not follow redirects** — a 3xx ends the invocation. `/api/cron`
  is deliberately outside the middleware matcher so a scheduled call reaches
  the handler instead of being bounced to a login page that the scheduler
  would record as a completed run.

### 2.4 Draining by hand

A signed-in administrator can POST to the same endpoint from the same origin
without the secret. That path exists so nobody is locked out of the queue by a
misconfigured schedule, and it is how step 6 of §1.3 is done.

An external scheduler — if one is ever preferred over native cron — needs no
code change and may use either method:

```bash
curl -fsS https://<pilot-host>/api/cron/outbox \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## 3. The pilot walkthrough

Fictional throughout. Suggested names: agency **Northgate Lettings (PILOT)**,
landlord **A. Pilot-Landlord**, tenant **T. Pilot-Tenant**, property
**1 Pilot Way, Wolverhampton**. Use a real postcode in the service area — the
address is validated against Postcodes.io — and make the house name obviously
fictional.

### 3.1 Agency invitation
1. `/admin/organisations` → create **Northgate Lettings (PILOT)**.
2. Add the owner with a controlled address. **No password is asked for** — this
   is the V2.9 behaviour.
3. Drain the outbox. The invitation arrives.
4. **Check the link host before clicking.** It must be the pilot host.
5. Open it, set a password, sign in at `/portal`.

*Failure checks* — each should be true and is worth actually trying:
- Opening the link twice does not consume it.
- Reusing it after setting the password refuses, generically.
- The same token at `/account/reset/<token>` refuses.
- Resending within two minutes is declined; an earlier invitation still works
  until one is redeemed.
- A password reset signs out an already-signed-in session on its next request.

### 3.2 Portfolio import
1. `/portal/portfolio/import` → download the template.
2. Build ~5 fictional rows. Deliberately include: one duplicate address, one
   bad postcode, one `01/02/26` date, one row missing the landlord.
3. Upload → the preview must show 4 categories and write nothing.
4. Confirm. Only the good rows land.

*Failure checks*:
- Re-upload the same file: everything shows "already match", nothing duplicates.
- Change a tenant in the portal, then confirm an older preview: it must skip
  with *"This property changed after you reviewed it"*.
- Confirm the same preview twice: the second reports the first's result.
- Upload an `.xlsx`: refused by name.

### 3.3 Job request
From a pilot property, request a CP12. Confirm the price is **£45** and came
from the server, not the form.

### 3.4 Tenant booking
1. The tenant invitation is queued; drain.
2. Open the link as the tenant, enter the property postcode, pick a slot.
3. Confirm the appointment appears **in the pilot calendar** — not the live one.

*Failure checks*: the reference alone does not open the job without the
postcode; a suspended agency stops new tenant scheduling but does not cancel an
appointment already given.

### 3.5 Engineer completion
Sign in at `/engineer`, start and complete the job, record the work.

### 3.6 Certificate release
Upload a fictional CP12 PDF, review, release to a controlled address. Drain.
Confirm the PDF arrives attached and the portal link points at the pilot host.

### 3.7 Invoice
Issue, deliver, then record payment.

**This will refuse until the business settings are filled.**
`canIssueInvoices()` blocks on the legal entity, invoice footer wording and
payment terms — all still outstanding. Either supply them for the pilot or stop
the walkthrough at 3.6 and record that 3.7 was not exercised.

**The invoice sequence is shared and monotonic.** A pilot invoice consumes a
real `BSCJ-` number and leaves a permanent gap when deleted. Either accept the
gap, or run the pilot against a database whose sequence is not the production
one. Do not reset the sequence.

---

## 4. Cleanup boundaries

**Safe to remove** — everything created under the pilot agency: the
organisation, its users, properties, landlords, tenancies, compliance cycles,
imports, credentials and queued messages; pilot events in the pilot calendar;
pilot documents in Blob.

**Must NOT be removed**
- `audit_event` — append-only, and the record of what the pilot did.
- The real administrator account.
- The invoice number sequence — never reset it.
- Any job, certificate or invoice not created by the pilot.
- Migrations. Rolling back `0007` fails while an invitation is outstanding,
  deliberately.

**Delete order** is forced by `restrict` foreign keys: activity → compliance
cycle → tenancy → portfolio_import → property → customer → credentials →
outbound_email → app_user → agent_organisation.

---

## 5. Stop conditions

Stop the pilot and fix before continuing if any of these occur:

- An invitation or scheduling link points at the wrong host.
- An appointment appears in a calendar other than the pilot calendar.
- Any message reaches an address the owner does not control.
- An import writes anything that was not in the preview.
- A superseded invitation or reset changes a password.
- A tenant can reach a job without the postcode, or one agency sees another's
  portfolio.
- The cron log shows `401` or `405` rather than `200` — the queue is not
  draining and nothing is being sent, however healthy the site looks.
