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

## 1A. The configuration contract — reported, checked, verified

Three different confidence levels, kept apart because conflating them is how a
pilot is declared ready and then does not send anything.

- **Reported** — stated by the owner. Not observable from this machine.
- **Checked** — the code agrees the setting is the one it reads, with the
  meaning claimed. A local `npm run preflight` is *this* row at most; it reads
  this shell and `.env.local` and **cannot see a Vercel project's variables**.
- **Verified** — a real call succeeded. Nothing below is verified.

| Setting | Code path that consumes it | State |
| --- | --- | --- |
| Project `bscj-v2-pilot`, prod branch `v2-compliance-platform` | — | reported |
| `BSCJ_APP_ORIGIN=https://bscj-v2-pilot.vercel.app`, Production | `lib/config/origin.ts` | **reported** — saved by the owner; not independently verified |
| Functions London only | — | reported |
| Neon Free `bscj-v2-pilot`, London, **not migrated** | `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | reported |
| Upstash `bscj-v2-pilot`, London | `UPSTASH_REDIS_REST_URL` / `_TOKEN` → `lib/kv/store.ts` | reported |
| Blob `bscj-v2-pilot-documents`, private, **Production only** | `BLOB_READ_WRITE_TOKEN` → `lib/storage/documents.ts` | reported; **see below** |
| `AUTH_SECRET`, `SCHEDULING_TOKEN_SECRET`, Google creds, calendar id — Production only | as named | reported |
| Dedicated pilot Google calendar | `GOOGLE_CALENDAR_ID` | reported |
| Resend sending-only key, verified `bscj-solutions.com` | `RESEND_API_KEY` | reported |
| `BOOKING_EMAIL_FROM=BSCJ Pilot <pilot@bscj-solutions.com>` | `lib/email/send.ts` | reported; **see below** |
| `BOOKING_EMAIL_REPLY_TO`, `BOOKING_NOTIFICATION_EMAIL` = `admin@…` | `lib/email/send.ts` | reported |
| `CRON_SECRET` absent | `lib/ops/cron-auth.ts` | reported, and **intended** |

### Three contract points worth checking against the code

**`BSCJ_APP_ORIGIN` is reported as saved** in the pilot project's Production
environment as `https://bscj-v2-pilot.vercel.app`. That is the right value, and
it is **owner-reported, not independently verified** — nothing on this machine
can read a Vercel project's variables, and a local `npm run preflight` reports
on this shell only.

Why it matters, so the check is worth doing: without it,
`resolveAppOrigin()` sees `VERCEL_ENV=production` on that project — a
project's production deployment is production regardless of which project it
is — and falls back to the **canonical marketing origin**,
`https://www.bscj-solutions.com`. Every invitation, reset and tenant link would
then point at the live site, where the account does not exist.

It becomes *verified* at the first send: §3.1 step 4 says to check the link's
host before clicking it. If it is `www.bscj-solutions.com`, the variable is not
in effect on that deployment.

**Blob connected to Production only** is consistent with how the driver
selects itself: `BLOB_READ_WRITE_TOKEN` present ⇒ `vercel-blob`. On a preview
of that project the token is absent, so `storageStatus()` reports "no document
store" and uploads are refused rather than silently writing somewhere. That is
the correct failure, and it means **document features only work on the pilot's
production deployment** — which is also the only deployment cron reaches.

**`BOOKING_EMAIL_FROM` as `BSCJ Pilot <pilot@bscj-solutions.com>`** is passed
straight through to Resend's `from` field, so a display-name form is fine.
Worth noting that `pilot@` must be a deliverable address on the verified
domain, and that `BOOKING_EMAIL_REPLY_TO` and `BOOKING_NOTIFICATION_EMAIL`
both being `admin@bscj-solutions.com` means internal alerts and customer
replies land in the same real inbox — intended for a pilot, and the thing to
change before anything wider.

### Not verifiable from here

Region placement, plan tier, which Vercel environment each variable is scoped
to, and whether the Neon/Upstash/Blob resources are the separate ones named.
None of that is observable without the pilot credentials or the Vercel API.
The first command in §2A.3 is what turns the database half of it into
*verified*.

---

## 2A. Bringing up the pilot database — the exact procedure

> **DONE — 20 September 2026, owner-observed.** The steps below were run by the
> owner against the pilot database using the guarded commands. Reported
> terminal output:
>
> - `Mode: pilot`, confirmed endpoint **matches**
> - migrations `0000`–`0007` applied — **24 tables, 22 enums**
> - invoice sequence: next number **`BSCJ-001000`**, none issued
> - administrator `admin@bscj-solutions.com` created, `role=admin`
>
> That is exactly the expected post-migration state in §2A.6. **Do not re-run
> §2A.5 or §2A.7.** `db:migrate` is safe to repeat (it applies only what is
> outstanding), but `admin:create` against an existing address is a *reset* and
> now requires the address to be retyped — see §2A.7.
>
> This is **owner-observed, not independently verified**: nothing on the
> development machine can reach the pilot database, and it deliberately holds
> no pilot credentials. The procedure is kept below as the record of what was
> run, and for rebuilding the database if it is ever recreated.

Nothing below has been run. Every command targets the **pilot** database and
is written so it cannot silently reach development.

### 2A.1 How these tools find a database

All three commands — `db:status`, `db:migrate` and `admin:create` — now go
through one loader (`scripts/load-env.mjs` / `src/lib/ops/env-file.ts`) and one
target resolver (`src/lib/ops/db-target.ts`), so they cannot disagree about
which database they mean.

**Development (default).** Unchanged: `.env.local` is loaded, a variable
already in the environment wins, a missing file is not an error.

**Pilot (`BSCJ_PILOT=1`).** Sealed:

- `.env.pilot` is the **only** source. `.env.local` is not read.
- Inherited `DATABASE_URL*` variables are **deleted** from the process before
  the file's values are applied, so nothing can be supplied by the calling
  shell.
- `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and `BSCJ_PILOT_ENDPOINT` are all
  **required, and checked against the file**. A value exported in the shell
  does not satisfy one.
- A missing file, a malformed line or a missing value **stops the command
  before any connection is opened**.

#### Correction: two variables, not one overriding the other

An earlier draft of this runbook said "exporting `DATABASE_URL` overrides the
`DATABASE_URL_UNPOOLED` value in `.env.local`". **That is wrong**, and the
mistake is worth stating plainly because the correct shape is the whole
hazard.

They are *different variables*. Exporting one has no effect on the other. What
actually happened is a **preference**: the tools read

```
DATABASE_URL_UNPOOLED ?? DATABASE_URL
```

so a `DATABASE_URL_UNPOOLED` present anywhere — including loaded from
`.env.local`, where an exported value never touches it — was used **in
preference to** an exported pilot `DATABASE_URL`. The pilot value was not
overridden; it was never consulted.

Two things now close it: pilot mode deletes inherited `DATABASE_URL*` and
requires both from the file, and `resolveTarget` **refuses outright** when the
two name different databases rather than warning and continuing.

### 2A.2 Getting the pilot credentials in place — privately

Do **not** put pilot credentials in `.env.local`; that file is development's
and is loaded whenever pilot mode is off.

Create a git-ignored `.env.pilot` (the existing `.env*` rule already covers it)
containing exactly three lines:

```
DATABASE_URL="<pilot pooled connection string>"
DATABASE_URL_UNPOOLED="<pilot direct connection string>"
BSCJ_PILOT_ENDPOINT="<pilot endpoint host, read from the Neon console>"
```

**Quote the values.** A Neon URL carries `?`, `&`, `=` and often `#`, and an
earlier draft told you to `source` this file in a shell — where every one of
those is a metacharacter and an unquoted URL can be mangled, truncated at a
`#`, or interpreted. It is no longer sourced: the commands parse the file
themselves, with a parser that treats those characters as data and reports a
line it cannot read instead of skipping it. The quotes are belt and braces, and
also what lets a value contain a `#`.

`BSCJ_PILOT_ENDPOINT` must come from the **Neon console**, not from the
connection string you just pasted — its whole job is to be an independent
second opinion.

Then prefix each command with `BSCJ_PILOT=1`. The earlier
`( set -a; . ./.env.pilot; set +a; … )` form is **withdrawn**: `set -a` does
not fail the subshell if the file is missing or unreadable, so the command ran
on with whatever the shell already had.

### 2A.3 Target identity and existing-schema checks — before anything

```bash
BSCJ_PILOT=1 npm run db:status
```

Read-only. It prints `Mode`, `Target` (host/database, never a credential),
which variable supplied it, and the confirmed endpoint. Then check:

1. **`Target`** — compare the printed host and database against the pilot
   project's endpoint in the Neon console. **If it is not the pilot, stop.**
2. **It ran at all.** Conflicting pooled/direct URLs now *stop the command*
   before connecting rather than warning, so reaching output at all means the
   two agree.
3. **What is already there.** A fresh database prints `Tables in public : 0`,
   `Enum types : 0` and *"Public schema is empty"*.

**An absent migration journal does not prove an empty database**, which is why
the tool counts tables and enums on that path instead of announcing "empty". If
it finds objects with no journal it exits non-zero: something else created
them, and a migration may collide part-way.

**A matching pair of connection strings does not establish which database this
is.** Two copies of the same wrong string agree perfectly. That is what
`BSCJ_PILOT_ENDPOINT` is for — a value read off the Neon console rather than
out of the file that supplied the connection. It is required before anything
**writes** (`db:migrate`, `admin:create`), and its purpose is to disagree when
the connection string is wrong.

### 2A.4 What will be applied

All eight outstanding migrations, `0000`–`0007`, in journal order. Every tag
has both an up and a down file. Across all eight there is exactly **one** data
statement — the `password_set_at` backfill in `0007` — and it is a no-op on a
fresh database because there are no rows to backfill. Everything else is DDL.

`0001` creates `invoice_number_seq` with `START WITH 1000`, so the pilot's
first invoice would be `BSCJ-001000`. That sequence is **independent of
development's**, which is correct for a separate database; it only becomes a
business question if this database were ever promoted to production.

### 2A.5 Apply

```bash
BSCJ_PILOT=1 npm run db:migrate
```

`db:migrate` is **silent on success** — a run that applies everything prints a
driver line, a websocket warning, then nothing, which looks identical to a run
that did nothing. Do not read anything into the silence; use the next step.

### 2A.6 Post-migration checks

```bash
BSCJ_PILOT=1 npm run db:status
```

Expect, against the pilot target:

- `Migrations on disk : 8` and `Migrations applied : 8`
- all eight tags `applied`, none `NOT APPLIED` or `DIFFERS FROM DISK`
- `Tables in public : 24`
- `Enum types : 22`
- `Invoice sequence : starts at 1000, next number BSCJ-001000 (none issued yet)`

A `DIFFERS FROM DISK` line means a migration file changed after being applied.
Stop and understand it before anything else.

### 2A.7 Bootstrap the first administrator

`create-admin.mjs` does not load `.env.local`, so pass the environment in:

```bash
BSCJ_PILOT=1 npm run admin:create -- "<address>" "<Full Name>" admin
```

It now prints the **target database and the account** before prompting, so a
wrong-database bootstrap is visible rather than silent.

Three things to know about it:

- **An existing address is not a no-op.** `ON CONFLICT DO UPDATE` resets the
  password, reactivates a suspended account, increments `session_version` so
  every session that account holds stops working, and revokes any outstanding
  invitation or reset link. It now requires the address to be **typed again**
  before doing any of that. A fresh address asks nothing extra.
- **The role is applied on insert only**, so re-running never promotes an
  engineer to an administrator.
- **The password is typed at the terminal and is echoed.** That is a
  deliberate existing choice — masking while the value sits in the scrollback
  would be theatre — so run it in a private terminal and clear the scrollback
  afterwards. It is never passed as an argument, so it does not reach shell
  history or the process list.

The prompts now **fail closed** on a non-interactive stdin: a piped or
scripted invocation stops with "needs an interactive terminal" and writes
nothing, rather than throwing part-way.

### 2A.8 What this does not do

It creates the schema and one administrator. It sends nothing, contacts
nothing and writes no calendar event or Blob object.

---

## 2B. Email delivery during the supervised pilot

**`CRON_SECRET` is intentionally absent, so there is no automatic delivery and
no automatic retry.** Nothing queued moves on its own. Queued email is drained
by hand, by a signed-in administrator, from the pilot origin:

Sign in at `https://bscj-v2-pilot.vercel.app/admin/login`, then from that
same origin issue the authenticated POST (the browser console on a page of the
pilot site is sufficient):

```js
await fetch('/api/cron/outbox', { method: 'POST' }).then(r => r.json())
```

It answers with counts only — `considered`, `claimed`, `accepted`,
`cancelled`, `stillQueued`, `failed`, `missingRecipient` — and never a
recipient, a reference or a token.

**What remains unverified while the secret is absent:** that Vercel invokes the
job at all, that the bearer check accepts Vercel's header in production, and
that failed rows are retried on a later run. Those are properties of the
*scheduled* path, and the manual drain does not exercise them.

The declared schedule still fires every minute against the deployment, but
without the secret each run returns `401` **before touching the database**. So
it costs Vercel invocations and fills the cron log with 401s — worth knowing,
because that noise could mask a real failure later — but it does not keep the
Neon compute awake.

### 2B.1 The smallest sustainable schedule, before activation

The drain queries the database on every run. Neon's **Free** plan suspends a
compute after **5 minutes** idle, **cannot be configured otherwise**, and
allows **100 CU-hours per project per month**; exhausting that suspends the
database until the next billing period.

**These are assumptions, not measured usage.** They model a 730-hour month at
0.25 CU with the drain as the only activity, and Neon's published Free limits
as of this writing. Real portal traffic, the pilot walkthrough itself and any
other connection all add to the duty cycle. Treat every figure below as a
floor, verify against the Neon console's own usage reporting once the pilot is
running, and do not plan to the last CU-hour.

| Interval | Compute awake | CU-hours/month | Verdict |
| --- | --- | --- | --- |
| every minute | ~100% | ~182 | **exhausts Free in ~16 days** |
| every 5 min | ~100% | ~182 | **exhausts Free in ~16 days** |
| every 10 min | ~50% | ~92 | works, no headroom |
| **every 15 min** | ~34% | ~61 | **recommended on Free** |
| every 30 min | ~17% | ~31 | ample headroom |
| hourly | ~8% | ~15 | ample headroom |

Anything under five minutes never lets the compute idle, so it is continuous
regardless of how little work each run does.

`vercel.json` currently declares `* * * * *`. **Left as declared** — it is
inert while `CRON_SECRET` is absent, and the interval is a decision to take
deliberately. Before setting the secret, either:

- change it to `*/15 * * * *` and redeploy (a schedule change needs a
  redeploy), or
- move the pilot database to a paid Neon plan.

**Cost assumptions:** Vercel Pro covers the invocations either way; the
constraint is Neon Free's compute allowance, not Vercel. The arithmetic assumes
0.25 CU, a 5-minute autosuspend that cannot be disabled, and no other traffic.
None of that is measured here — it is a model, and the Neon console's usage
page is the authority once the pilot runs.

**Delivery delay:** an agency owner waits up to one interval for an invitation.
At 15 minutes that is tolerable for a supervised pilot and poor for a live
onboarding call. A password reset credential lives one hour, so a 15-minute
delay consumes a quarter of it.

**Retry implications:** a failed row waits one 120-second lease before it is
eligible again, then retries on the next drain. At 15 minutes,
`MAX_ATTEMPTS = 5` spans a little over an hour before a row is given up on and
needs a person. Vercel does not retry a failed invocation, which is safe here
because the drain reconciles outstanding work rather than processing a delta —
a missed run is picked up by the next one.

No new queue infrastructure is warranted for the pilot.

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
