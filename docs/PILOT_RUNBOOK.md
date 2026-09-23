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
- `DATABASE_URL` — the pilot database. **Every migration on disk must be
  applied to it.** `0000`–`0007` were applied on 20 September 2026;
  **`0008_landlord_contact_optional` is outstanding everywhere** and must be
  applied before the current commit is deployed — see §2E. Check with
  `BSCJ_PILOT=1 npm run db:status`.
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

**Migration 0010 — the engineer's certificate drafts**
- Adds one table, `certificate_draft`. Additive only: no existing table is
  altered, no column changes type or nullability, and no row is read or
  rewritten. There is no precheck to run and nothing it can conflict with.
- **Apply it before the deploy**, for the same reason as every other
  migration here: the new code reads the table, and a deployment that is
  serving the connected workflow against a database without it will fail on
  every draft save. The old code ignores the table entirely, so applying it
  early is harmless.
- Rolling back is `drizzle/down/0010_engineer_certificate_drafts.down.sql`.
  It discards any **unsubmitted** draft — an engineer's part-written record —
  and touches nothing that has been submitted or issued. The down file
  carries the query to check for work in progress first.

**Migrations 0011 and 0012 — the same table, two more columns**
- `0011_certificate_submission_lease` adds `submission_started_at`;
  `0012_certificate_draft_signatures` adds `signatures`. Both are one nullable
  column on the table `0010` created. Additive, no default written to existing
  rows, nothing read or rewritten, no precheck.
- **Apply all three in order, before the deploy.** The running build names
  `signatures` in its queries, so a deployment serving the connected workflow
  against a database without it fails on every certificate draft save. An
  older build ignores the column entirely, so applying early is harmless —
  which is why the order is always migrate, verify, then deploy.
- Rolling back is the reverse order: `0012`, then `0011`, then `0010`.
  Reversing `0012` discards signatures drawn on **unsubmitted** drafts;
  reversing `0011` loses only automatic recovery of an interrupted
  submission; reversing `0010` discards unsubmitted drafts entirely. **None
  of them touches a submitted or issued certificate** — verified by actually
  running them in `test/integration/migration-rollback.test.ts`.
- **Roll the application back first, or together.** Reversing `0012` under a
  build that still expects the column breaks certificate drafts immediately.

**After the three are applied**
- `npm run db:status` should report **13 of 13** applied, **25 tables, 22
  enums**. Before them the pilot reports 10 of 13 and 24 tables.

**If a migration run reports success and applies nothing — 24 September 2026**

This happened, on the pilot, and it is worth knowing the shape of it because
the symptom is indistinguishable from a successful run.

`drizzle-kit migrate` does not diff the journal against the migration table.
It reads the newest `created_at` in `drizzle.__drizzle_migrations` and applies
each journal entry only when that entry's `when` is **greater** than it:

```js
// drizzle-orm/pg-core/dialect.js
if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
```

`0010`–`0012` had been generated with their real timestamps while `0008` and
`0009` carried hand-picked round numbers running ahead of real time, so all
three sorted before the pilot's newest applied migration and were skipped
silently, exit code zero, every run. It was repaired by moving the three
unapplied timestamps above `0009`'s — `0000`–`0009` were not touched, so the
pilot's applied rows and hashes stay valid and nothing in the migration table
needs editing.

**There is now a gate in front of the command.** `npm run db:migrate` runs
`npm run db:journal` first. It opens no connection and mutates nothing, and it
prints one line when it is happy:

```
Journal            : 13 migrations, ordered, newest 0012_certificate_draft_signatures (1790800000000)
```

If that line is missing, or the command stops with *"The migration journal is
not in a state the migrator will act on"*, **nothing was applied and no
database was opened**. Fix the journal; do not reach for the migration table.

`npm run db:journal` is safe to run on its own, at any time, from anywhere.

**Blob storage**
- Attach a Vercel Blob store; `BLOB_READ_WRITE_TOKEN` is injected and nothing
  else is needed. The local driver refuses to run when `NODE_ENV=production`,
  and on a deployment that refusal cannot be talked out of: a production build
  folds the check away at compile time, so setting `NODE_ENV` in the project's
  environment changes nothing. Blob is the only document store a deployment
  has.
- **Certificates are the one part of the release still unproven against a live
  service.** Upload, review, release, the renewal moving and the recovery
  button are all browser-verified against the *local* store (acceptance pack
  §0). The screens are identical on Blob; the driver underneath them has never
  been called from here. Exercise it once, on the pilot, with the
  `TEST-NOT-VALID` specimen.

**Scheduled processing**
- `CRON_SECRET`, at least 24 characters. Vercel sends it automatically as an
  `Authorization: Bearer` header on every cron invocation.
- Set it on the **pilot project**, not the live one. See §2.

### 1.3 Turning "set" into "verified"

Run these in order. Each is a read or a scoped write inside the pilot's own
fixtures; none touches real customer data.

1. `npm run db:status` — connects, lists migrations, confirms every tag on
   disk is applied, prints the invoice sequence. Read-only.
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

**Vercel Pro is active**, and `vercel.json` declares:

```json
{ "path": "/api/cron/outbox", "schedule": "*/15 * * * *" }
```

*Corrected 21 September 2026.* This section previously said `* * * * *`, once a
minute. That expression is within what Pro allows, but it never lets a Neon
Free compute idle and would exhaust the monthly allowance in about sixteen
days. **Fifteen minutes is the schedule in the repository and the one in
force**; the arithmetic behind it is §2B.1, which is where the interval is
explained rather than merely stated.

Per Vercel's published limits (docs updated 2026-07-15), Pro allows a minimum
interval of once per minute with per-minute precision. Hobby is once per day
and **rejects a sub-daily expression at deploy time** rather than running it
less often — which is why a sub-daily expression requires Pro at all and why
`npm run preflight` states that requirement.

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
| Neon Free `bscj-v2-pilot`, London, migrated `0000`–`0007` | `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | owner-observed 20 September 2026; **`0008` outstanding**, see §2E |
| Upstash `bscj-v2-pilot`, London | `UPSTASH_REDIS_REST_URL` / `_TOKEN` → `lib/kv/store.ts` | reported |
| Blob `bscj-v2-pilot-documents`, private, **Production only** | `BLOB_READ_WRITE_TOKEN` → `lib/storage/documents.ts` | reported; **see below** |
| `AUTH_SECRET`, `SCHEDULING_TOKEN_SECRET`, Google creds, calendar id — Production only | as named | reported |
| Dedicated pilot Google calendar | `GOOGLE_CALENDAR_ID` | reported |
| Resend sending-only key, verified `bscj-solutions.com` | `RESEND_API_KEY` | reported |
| `BOOKING_EMAIL_FROM=BSCJ Pilot <pilot@bscj-solutions.com>` | `lib/email/send.ts` | reported; **see below** |
| `BOOKING_EMAIL_REPLY_TO`, `BOOKING_NOTIFICATION_EMAIL` = `admin@…` | `lib/email/send.ts` | reported |
| `CRON_SECRET` set, Production only | `lib/ops/cron-auth.ts` | **reported, and exercised** — the first tenant invitation was delivered by a scheduled drain (§2D) |

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

> **This section describes the original bring-up.** A ninth migration,
> `0008_landlord_contact_optional`, has since been added and is **not applied
> anywhere**. For an existing pilot database that is the only outstanding one —
> see §2E. For a database being rebuilt from scratch, all nine apply, and the
> notes below still hold for the first eight.

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

Expect, against the pilot target — as it was on 20 September 2026, before
`0008` existed:

- `Migrations on disk : 8` and `Migrations applied : 8`
- all eight tags `applied`, none `NOT APPLIED` or `DIFFERS FROM DISK`
- `Tables in public : 24`
- `Enum types : 22`
- `Invoice sequence : starts at 1000, next number BSCJ-001000 (none issued yet)`

Today the same command reports `Migrations on disk : 9` and `Migrations
applied : 8`, with `0008_landlord_contact_optional` listed `NOT APPLIED`. That
is the expected state until §2E is carried out.

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

## 2B. Automatic email processing

Queued email used to move only on a manual admin POST from a browser console.
That is unsuitable for a pilot: an agency job queues an invitation and nothing
happens until somebody remembers. Scheduling is now the delivery mechanism, and
the manual drain is the fallback.

### 2B.1 The schedule, and why 15 minutes

`vercel.json` declares:

```json
{ "path": "/api/cron/outbox", "schedule": "*/15 * * * *" }
```

The drain queries the database on **every** run, and Neon **Free** suspends a
compute after 5 minutes idle, cannot be configured otherwise, and allows
**100 CU-hours per project per month** — exhausting it suspends the database
until the next billing period.

So any interval under five minutes never lets the compute idle, and runs
continuously whatever it finds:

| Interval | Compute awake | CU-hours/month | |
| --- | --- | --- | --- |
| every minute | ~100% | ~182 | exhausts Free in ~16 days |
| every 5 min | ~100% | ~182 | exhausts Free in ~16 days |
| every 10 min | ~50% | ~92 | no headroom |
| **every 15 min** | ~34% | **~61** | **chosen** |
| every 30 min | ~17% | ~31 | ample, slower |

**A model, not measured usage** — 730 hours at 0.25 CU with the drain as the
only activity. Portal traffic adds to it, so treat ~61 as a floor and check the
Neon console's own usage page once the pilot runs.

**Expected email delay: up to 15 minutes, about 7–8 on average.** That applies
to every queued message — agency invitations, password resets, tenant
scheduling links, certificates, invoices. Two consequences worth stating:

- A password reset credential lives one hour, so a 15-minute delay consumes up
  to a quarter of it. Still workable; worth knowing before somebody reports it
  as broken.
- It is too slow for a live onboarding call. For the pilot that is acceptable;
  before wider use, either move the pilot database off Neon Free or accept the
  delay deliberately.

An alternative, if the delay proves annoying: `*/10 8-18 * * 1-5` gives a
10-minute delay in business hours at roughly half the compute, at the cost of
overnight messages waiting until morning. Not chosen — predictable beats
clever for a supervised pilot.

### 2B.2 No code change was needed beyond the interval

The route already accepts the scheduler's **GET** with
`Authorization: Bearer $CRON_SECRET` and no session fallback, keeps POST for
the administrator's same-origin manual drain, retries per row with a bounded
attempt count and a 120-second lease, and sends with a stable provider
idempotency key so a retry cannot become a second email. None of that changed.

Function duration was checked and needs no configuration: Vercel's default is
**300 seconds** on every plan, and the drain's worst case is 25 rows × an
8-second send timeout ≈ 200 seconds.

### 2B.3 Activating it — exact steps

> **DONE — owner-reported, 21 September 2026.** `CRON_SECRET` is configured on
> the pilot project and `/api/cron/outbox` runs every 15 minutes. **Do not
> regenerate the secret**: changing it while a deployment holds the old value
> makes every invocation `401`, and nothing in the application reports that.
> The steps are kept as the record of what was done, and for rebuilding the
> project. §2D is the evidence that it works.

1. **Set `CRON_SECRET` on the pilot project**, Production environment only.
   At least 24 characters; generate it in a password manager. Vercel sends it
   automatically as `Authorization: Bearer <value>` on every cron invocation.
   *Vercel → bscj-v2-pilot → Settings → Environment Variables → Add →
   Production only.*
2. **Redeploy.** A schedule change and a new environment variable both take
   effect only on a new deployment. *Deployments → ⋯ → Redeploy*, or push a
   commit. An Instant Rollback does **not** update active cron jobs.
3. **Confirm the job is registered.** *Settings → Cron Jobs* should list
   `/api/cron/outbox` at `*/15 * * * *`, enabled.

Confirm `CRON_SECRET` **by presence only** — that the variable is listed and
scoped to Production. Never reveal or paste its value.

### 2B.4 Verifying with the invitation already queued

> **DONE — owner-observed, 21 September 2026.** The queued invitation was
> delivered by a scheduled drain and the tenant booked from it; see §2D. The
> checks below are kept because they are what to repeat if the queue ever
> stops moving again, and because two of the three pieces of evidence — the
> `GET … 200` in the cron log and the Resend send — were not individually
> recorded at the time.

There is already a queued tenant invitation — "Invitation to book → tenant:
Queued, not yet attempted" — with no corresponding Resend send. **Use it. Do
not create another**: a second one would make it ambiguous which drain sent
what, and the existing row is the honest test of the path that was failing.

After step 2B.3, wait for the next quarter-hour boundary, then collect three
pieces of evidence:

1. **The invocation happened and was accepted.** *Vercel → bscj-v2-pilot →
   Settings → Cron Jobs → View Logs* (or Logs filtered to
   `requestPath:/api/cron/outbox`). Expect **`GET … 200`**, not `401` and not
   `405`. The response body is counts only:
   `{"ok":true,"trigger":"schedule","report":{…}}` — look for
   `"claimed":1` and `"accepted":1`.
   - `401` → the secret is absent or differs between Vercel and the
     deployment. Nothing was read from the database.
   - `405` → the deployment predates GET support; redeploy the current commit.
2. **The message was actually accepted by the provider.** Resend → Emails: one
   new send to the tenant address, subject *"Choose a time for your gas safety
   appointment"*. `accepted` in the report means Resend took it, which is not
   a delivery receipt — Resend's own status is the next level of evidence.
3. **The application agrees.** The admin job page's notification row should no
   longer read "Queued"; it should show the sent state with a timestamp.

Then open the link in that email and **check its host is
`bscj-v2-pilot.vercel.app`**, not `www.bscj-solutions.com`. That is what turns
`BSCJ_APP_ORIGIN` from owner-reported into verified.

### 2B.5 What this does and does not prove

Proves: Vercel invokes the job; the bearer check accepts Vercel's header in
production; a scheduled GET drains the queue; an invitation reaches Resend; and
the link is addressed to the pilot.

**Does not prove retries.** A first-attempt success exercises none of the retry
path. Claiming retries work on this evidence would be wrong. They remain
unverified until a row actually fails and is seen to be attempted again —
`attempts` incrementing on a `pending` row across two drains, with a
`last_error`. Do not manufacture a failure against live services to get it;
record it as unverified and let it be observed if it happens.

Also unproven by this: certificate and invoice delivery, and the manual drain
under the new schedule (unchanged, but not re-exercised).

### 2B.6 The manual drain still exists

A signed-in administrator can still POST to `/api/cron/outbox` from the pilot
origin without the secret, so nobody is locked out of the queue if the schedule
is misconfigured. It is the fallback now, not the mechanism.

---

## 2C. Sender name, and what a tenant sees

`BOOKING_EMAIL_FROM` is currently `BSCJ Pilot <pilot@bscj-solutions.com>`,
which is right for a supervised pilot: every message is visibly a test, and
nobody mistakes one for live correspondence.

**Before any message reaches a real tenant or landlord, that display name has
to change.** A tenant who receives "BSCJ Pilot" about their own home has been
told, accurately, that they are an experiment — and a link from an unfamiliar
sender is a link most people do not click.

To change it, set the variable on the pilot project to:

```
BSCJ Gas & Heating <pilot@bscj-solutions.com>
```

or, once a customer-facing mailbox exists, to that address instead. It is an
environment variable on the Vercel project — **not changed here**, and not
something the code decides. `lib/email/send.ts` passes it straight through to
Resend's `from` field, so the display-name form works as written and the
address must stay on the verified domain.

Nothing else needs changing: the header inside every message already reads
"BSCJ Gas & Heating", so only the sender line differs today.

## 2D. First tenant journey — owner-observed, 21 September 2026

| Time | Event |
| --- | --- |
| 02:30 | Tenant invitation **received** |
| 02:39 | Tenant **booked** an appointment |
| 02:45 | Booking confirmation **received** |
| — | Appointment **visible in the dedicated pilot Google Calendar** |

One pass exercising the scheduled drain, the link's host, the scheduling flow,
the hold and confirm, the calendar write landing on the **pilot** calendar
rather than the live diary, and the confirmation send.

**Owner-observed, not independently verified** — nothing on the development
machine can reach the pilot's services, and it holds no pilot credentials.

**Automatic retry is still unverified.** A first-attempt success exercises none
of the retry path, and a failure must not be manufactured against live services
to close it.

---

---

## 2E. Releasing the current commit — migration before deploy

> **0009 is applied — owner-observed.** `db:status` reported 10 of 10
> migrations applied, 24 tables, 22 enums, and `da189bb` was pushed and
> deployed after it. This is the owner's own report, not something
> independently checked from here.
>
> **Corrects an earlier version of this note**, which said 0009 remained
> outstanding and gave `9` as the applied count. Both were wrong.
>
> The reasoning below (§2E.1–§2E.5) describes how 0008 and 0009 were released
> and is kept for the pattern — substitute names and it is exactly the
> reasoning for what is outstanding **now**: `0010_engineer_certificate_drafts`
> and `0011_certificate_submission_lease`, covered in §2E.7. Neither has a
> pre-condition to check first, unlike 0009.

The pilot is running an **earlier** commit. Commits land locally and go out as
**one release**. Nothing here is optional ordering.

### 2E.1 There is nothing to choose between

`67bb2be → 721abb7 → 7087b74 → 4d7511b` is a straight line. Deploying the tip
deploys all four, so "ship the branding first and migrate later" was never
available: **`4d7511b` already contains `721abb7`**, the commit whose
application code expects the relaxed columns. There is no cherry-pick, no
reordering and no partial deploy — those would rewrite history to create a
choice that does not exist.

So the order is decided by one fact: `0008` must be applied **before** the code
that depends on it starts serving.

### 2E.2 Why migrating first is safe for what is running now

`0008` is two `DROP NOT NULL` statements. It drops nothing, rewrites no data
and changes no existing value.

- **The deployed older code keeps working.** It supplies an email and a phone
  on every write it makes, so a relaxed constraint is one it never reaches.
- **It cannot be surprised by a null.** Only the *new* code can create a
  landlord without contact details, and it is not deployed yet. Until it is,
  no such row exists to be read.
- **Consumer booking is untouched.** `/book` collects and validates both before
  a job exists, in application code, and nothing here relaxes that path.

The reverse order is the one that breaks: deploying `4d7511b` against an
unmigrated database leaves the application expecting nullable columns the
database still refuses, so a contactless import fails at insert time and the
agent is told "That property could not be added" with nothing to act on.

### 2E.3 Owner steps, in order

**1. Confirm which database you are about to change.** Read-only, and it is the
step that makes the rest safe.

```bash
BSCJ_PILOT=1 npm --prefix /Users/tegjot/Projects/bscj-gas-website run db:status
```

Check three things before going on:

- `Mode: pilot`, and the confirmed endpoint **matches**.
- `Target` is the pilot host and database, compared against the Neon console —
  **if it is not the pilot, stop.**
- `Migrations on disk : 9`, `Migrations applied : 8`, with
  `0008_landlord_contact_optional` the only `NOT APPLIED` tag, and no
  `DIFFERS FROM DISK` line anywhere.

**2. Apply the one outstanding migration.**

```bash
BSCJ_PILOT=1 npm --prefix /Users/tegjot/Projects/bscj-gas-website run db:migrate
```

It applies only what the journal says is outstanding, so it is safe to repeat.
It is also **silent on success** — a driver line, a websocket warning, then
nothing. Read nothing into the silence.

**3. Verify it, rather than assuming it.**

```bash
BSCJ_PILOT=1 npm --prefix /Users/tegjot/Projects/bscj-gas-website run db:status
```

Expect `Migrations on disk : 9`, `Migrations applied : 9`, all nine `applied`,
and still **24 tables and 22 enums** — `0008` adds neither. The invoice
sequence is untouched.

**4. Only then push and deploy.**

```bash
git push origin v2-compliance-platform
```

The pilot project builds `v2-compliance-platform`, so the push is the deploy.
Confirm afterwards that *Settings → Cron Jobs* still lists `/api/cron/outbox`
at `*/15 * * * *`: a new deployment carries the schedule, and an Instant
Rollback does not.

**Do not re-run `admin:create`.** The pilot administrator exists, and running
it against an existing address resets the password, increments
`session_version` and revokes outstanding invitations.

### 2E.4 What to check after the deploy

- Sign in to the pilot portal and open **Portfolio → Import**. A CSV whose
  landlord rows carry no email should now preview rather than refuse.
- A row whose landlord name matches one already on file should ask **which
  landlord it is** and refuse to import until answered. That is the intended
  behaviour, not a fault.
- Nothing about the tenant journey in §2D should change.

### 2E.5 Migration 0009 has a pre-condition — check it first

**Owner-observed complete.** This section describes the check that was
already run and the migration that is already applied. Kept for the pattern
it establishes, which §2E.7 follows for what is actually outstanding now.

`0009_one_active_cycle_per_service` creates a **partial unique index**: one
active `compliance_cycle` per property, per service. Additive and enforcing
only — no column added or dropped, no data rewritten.

Unlike 0008, **it can fail on existing data.** Creating a unique index over rows
that already violate it is refused by Postgres, and that refusal is the correct
outcome: it means two active positions exist for one service and a person has to
decide which is right.

Run this against the pilot **before** applying. It must return **no rows**:

```sql
SELECT property_id, product_id, count(*)
FROM compliance_cycle
WHERE status = 'active'
GROUP BY property_id, product_id
HAVING count(*) > 1;
```

If it returns any, supersede the wrong ones by hand — `UPDATE compliance_cycle
SET status = 'superseded', superseded_at = now() WHERE id = '<the wrong one>'`.
**Do not delete a compliance cycle**: it is the property's history and a job,
certificate or invoice may reference it.

Expect `Migrations on disk : 10` and `Migrations applied : 9` before, and
`10` / `10` after, with **still 24 tables and 22 enums** — an index is neither.

**Rolling 0009 back is free**, unlike 0008. Dropping an index removes a
guarantee and touches no data:
`drizzle/down/0009_one_active_cycle_per_service.down.sql`. The application keeps
working; it simply goes back to being the only thing preventing two active
positions.

### 2E.6 Rolling back, and its one hard limit

The code rolls back freely: an Instant Rollback to the previous deployment
restores it, and the older code works against the migrated schema for the
reasons in §2E.2. **Do the code rollback first, and in most cases do only
that** — a schema that permits more than the code uses costs nothing.

**The schema does not roll back freely.**
`drizzle/down/0008_landlord_contact_optional.down.sql` restores `NOT NULL`, and
that statement **fails while any customer row has a null email or phone** —
which is precisely the state the migration exists to allow. There are only
three honest ways through it, and two of them are not on offer here:

1. **Leave `0008` applied.** Nullable columns the application no longer uses
   are inert. This is the right answer almost always.
2. **Have BSCJ supply the missing details**, then reverse it. Find the rows
   with `SELECT id, name FROM customer WHERE email IS NULL OR phone IS NULL;`
   and fill them in from something real.
3. **Remove those customer records.** They are landlords, with properties,
   certificates and history hanging off them.

**Never invent an email or a phone number to satisfy the constraint**, and
never delete a business record to make a rollback succeed. A fiction in a
`customer` row ends up on an invoice addressed to a landlord, and a deleted
landlord takes their properties' history with them. If neither (1) nor (2) is
acceptable, the answer is to stop and decide, not to unblock the SQL.

### 2E.7 Migrations 0010 and 0011 — outstanding now, neither with a pre-condition

Two migrations were added on this branch **after** `da189bb` was deployed, and
neither has been applied anywhere, including the pilot.

**`0010_engineer_certificate_drafts`** adds one table, `certificate_draft`, so
the engineer's connected gas safety record has somewhere to hold a draft
server-side rather than in the browser. It alters nothing that exists and has
no pre-condition — there is no equivalent of §2E.5's check to run first. It
must be applied before the deploy, because the connected certificate workflow
reads this table on every draft save and the currently-deployed code does not
know it exists.

**`0011_certificate_submission_lease`** adds one nullable column,
`submission_started_at`, to the table `0010` created. It is what lets an
interrupted certificate submission recover on the engineer's own retry rather
than leaving them told for ever that a submission is already in progress. No
default is written to existing rows and nothing is rewritten.

```bash
BSCJ_PILOT=1 npm --prefix /Users/tegjot/Projects/bscj-gas-website run db:status
```

Expect `Migrations on disk : 12`, `Migrations applied : 10`, with `0010` and
`0011` the only `NOT APPLIED` tags. **If the applied count is not 10, or 0009
is not among the applied ones, stop** — the baseline this section assumes has
not held, and that needs reconciling against the owner's own record before
anything else here is run.

```bash
BSCJ_PILOT=1 npm --prefix /Users/tegjot/Projects/bscj-gas-website run db:migrate
```

Then verify `12` / `12`, all applied, **still 24 tables and 22 enums** before
this deploy, **25 tables** after — `certificate_draft` is the one new table;
`0011` adds a column to it, not a table.

**Rolling 0010 back has a condition.** It discards any engineer's
**unsubmitted** draft — nothing submitted or released, which lives in
`document` and `certificate` and is untouched. Check for an open draft first;
the query is in `drizzle/down/0010_engineer_certificate_drafts.down.sql`'s own
header.

**Rolling 0011 back is free.** It only records when a submission claim was
taken; dropping it loses the automatic-recovery behaviour, not any data — an
engineer stuck on a claim after the rollback needs an administrator to release
it from the reconciliation page instead.

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
