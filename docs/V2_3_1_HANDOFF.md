# V2.3.1 — corrective phase

> **Closed out.** A review pass after the first implementation found seven
> further defects in this phase's own work; all are fixed and covered by tests.
> See §9. This diff is ready for a checkpoint commit.
>
> The integration is **not production-ready.** Three classes of gap remain open
> and are listed together in **§10**: recovery that is not reliable under a
> simultaneous Postgres + Redis outage, an unreviewed customer-data retention
> decision, and the fact that Google Calendar and Resend have never been
> exercised against the real services.

**This is corrective work on V2.3, not the completion of it.** Deadlines and
tenant communications remain outstanding and are explicitly out of scope here.
V2.3 must not be described as complete.

---

## 1. Checkpoint

| | |
|---|---|
| Branch | `v2-compliance-platform` |
| Base commit | `686e1a625560eb43dbe087ef5d44eda8408a2691` — *"Complete V2.3 tenant scheduling"* |
| Working tree at start | clean, in sync with `origin/v2-compliance-platform` |
| State now | **uncommitted changes in the working tree.** Nothing committed, pushed, merged or deployed. |
| Migration | `0003_calendar_reconciliation` written, and applied **only** to the local development database |

---

## 2. What was wrong, and what was done

### 2.1 The tenant journey could not complete in a browser

Two independent defects, either of which was fatal.

**The invitation link threw.** `(schedule)/schedule/[token]/page.tsx` was a
Server Component calling `cookies().set()`. Next seals the cookie store outside
a Server Action or Route Handler, so the only thing a *valid* invitation could
do was raise `ReadonlyRequestCookiesError` — HTTP 500. The audit did not find
this because it reasoned about cookie *scope*; the page never got as far as
setting one.

*Fixed* by converting the page to a Route Handler
(`(schedule)/schedule/[token]/route.ts`). It attaches `Set-Cookie` to the
redirect in one hop. Nothing was rendered by the old page, so nothing is lost.

**The confirmation endpoint was outside the cookie's path.** The session is
scoped to `/schedule`; the endpoint was at `/api/schedule/confirm`, which does
not path-match, so the browser never sent the cookie and the handler answered
401 to every genuine tenant.

*Fixed* by moving the route to `/schedule/api/confirm` — inside the fence,
rather than widening the fence. `Path=/` was rejected for the reason the audit
gave. The path is containment, **not** authorisation: session verification,
rate limiting and generic refusals are unchanged, and an explicit same-origin
check has been added (`lib/scheduling/origin.ts`) so the protection
`SameSite=Lax` was providing is written down rather than implied.

`isWithinSchedulingCookiePath()` in `lib/scheduling/paths.ts` states the RFC
6265 §5.1.4 rule, and a test holds the endpoint to it.

### 2.2 The reference-and-postcode door 500'd (**new — not in the audit**)

`(schedule)/schedule/actions.ts` exported a string constant from a
`"use server"` module. Next refuses such a module at evaluation, so *every*
submission of the lookup form answered HTTP 500 before the action ran. Nothing
imported the constant. Found by driving the form in a browser; removed.

### 2.3 Rescheduling is now an explicit operation

`confirmTenantAppointment` distinguishes two operations decided from the row,
never from the request:

- **initial** — from `tenant_outreach` or `awaiting_tenant`, an ordinary
  lifecycle transition, still checked with `canTransition`.
- **reschedule** — from `scheduled` only. Not a transition (`scheduled` is not
  a legal move to itself), so it has its own allowed states rather than
  bypassing the lifecycle rule.

Lifecycle refusals are returned as `not_schedulable`, not thrown. The route
additionally wraps the call, so nothing the domain raises can become a 500.

**Concurrency.** The UPDATE is guarded on the row this request read — status
*and* `appointment_start`. Two reschedules both read `scheduled`, so status
alone was not enough. `updated_at` was tried first and is wrong: Postgres
stores `timestamptz` to the microsecond, a JavaScript `Date` carries
milliseconds, and the value never compares equal — **every** confirmation lost
its own race. That was found by the browser run, not by any unit test.

The loser gets `conflict` → HTTP 409, worded "reload", distinct from
`slot_taken`. A same-appointment retry returns `already` and writes nothing.

### 2.4 The calendar sequence is recoverable

Migration `0003` adds `job.calendar_previous_event_id` plus two indexes.

A reschedule writes the superseded event id **in the same UPDATE that moves the
appointment**, so the obsolete event and the fact that it is obsolete become
true together. Then:

1. `syncJobToCalendar` creates the replacement.
2. `cleanupSupersededEvent` removes the old one — and **refuses to** until the
   replacement is confirmed present, because until then the old event is the
   only appointment the engineer can see.
3. The column is cleared only if it still holds the id that was deleted.

A process that dies anywhere in that sequence leaves a row naming exactly what
is outstanding. **Postgres and Google are not atomic and this is not a
two-phase commit** — the intent is durable, the outcome is recorded separately.

Stale retries: the event id is derived from the row *as it is now*, and the
final "synced" write is guarded on the appointment it was computed for. A sync
finishing after the tenant moved again reports `superseded` and deletes the
event it just wrote.

### 2.5 Capacity across every booking path

`lib/booking/reservations.ts` reads appointments that are committed but whose
calendar write is `pending` or `failed` — the set Google cannot report. Used by:

- `/api/availability` (via the new shared `lib/booking/availability.ts`),
- the tenant's appointment page (same module, server-rendered),
- `/api/book`'s pre-write re-check and daily-cap count,
- `confirmTenantAppointment`'s pre-write re-check.

Only `pending`/`failed` are counted, so an appointment already in Google is not
counted twice. A job's own reservation is excluded for its own request.

**Release:** a reservation ends when the job reaches `synced` (Google now holds
it), is cancelled, or completes. **Uncertain Calendar outcomes** stay `pending`
or `failed`, which keeps the slot reserved *and* keeps the job on the
reconciliation queue — the uncertainty is resolved by the retry, which verifies
what is actually in Google rather than guessing.

**Database outage, stated plainly.** `fetchUnsyncedReservations` returns
`unavailable`, never an empty list, and callers fall back to Google alone —
exactly the protection that existed before this phase. This is deliberate: the
public booking flow has never depended on Postgres, and a database outage able
to refuse a paying customer would be the worse failure. It is a documented
degradation, not a silent new failure mode. The window it reopens is bounded by
how long jobs stay unsynced.

Redis holds are unchanged and remain a 30-minute convenience. They are
explicitly **not** the durable reservation.

### 2.6 Calendar outcomes are verified

`createEvent`'s 409 is no longer trusted. The existing event is fetched and
compared on identity, appointment window and liveness
(`eventMatchesAppointment`). A cancelled or mismatched event under the same id
is overwritten with `replaceEvent` (new), not called synced. Ambiguous failures
(timeouts) are recorded as `failed` — the honest state for "we do not know" —
and resolved by the retry. `deleteEvent` and `fetchEvent` are new; nothing logs
customer data or secrets.

**Reconciliation** (`lib/ops/reconcile.ts`) is bounded and authenticated:
`/admin/reconcile` (admin session, Server Action, audited) and
`POST /api/admin/reconcile` (admin session, audited). It *recovers* rather than
displays: it writes missing events, removes superseded ones, and drains
unpersisted bookings.

### 2.7 Database atomicity

`persistWebsiteBooking` now writes customer, property, tenancy, job and the
first activity in **one `db.batch`** — a single transaction on the Neon HTTP
driver. Ids are generated in code because a batch cannot feed one statement's
`RETURNING` into the next. The job insert deliberately drops
`onConflictDoNothing` so a duplicate aborts the whole transaction: the losing
request of a race now leaves **no orphan customer and no orphan property**,
which the unique job key never covered.

*Behaviour change:* a failed activity insert now rolls the job back instead of
being swallowed. The booking is still unaffected — the caller ignores the
result, and the failure leaves a recovery note (§2.8).

In `confirmTenantAppointment`, the activity and outbound-email inserts run
**only after** the guarded UPDATE returns a row, and are batched together. A
confirmation that loses the race writes neither. Proven live: two concurrent
confirmations produced one appointment, one activity row, one email row.

### 2.8 Public bookings are recoverable without rebooking

The completed-booking marker still goes in **before** persistence — moving it
would allow a second Calendar event and a second confirmation email.
*Recognition* and *recovery* are separated instead: a duplicate submission is
still refused, but on the way past it re-attempts the missing database record.

`lib/jobs/booking-recovery.ts` writes the note to **Redis, not Postgres** — the
write failed because Postgres was unreachable, so a recovery row there is the
same bet placed twice. Recovery verifies the Calendar event still exists and is
not cancelled, then calls the idempotent `persistWebsiteBooking`. It **creates
no Calendar event and sends nothing**, both asserted by tests.

**Honest limits.** If Postgres *and* Redis were both unavailable at booking
time there is no note and no automatic recovery; the appointment is still real
(Calendar event, customer confirmation, internal alert) but rebuilding the job
is manual. Reconstruction from the event description is **not** attempted: it
holds a *formatted* address, not the parts a property row is made of, and
guessing where the street ends would put invented data into the operational
record. Historical bulk backfill remains out of scope; no historical customer
event was touched.

**Privacy note, flagged rather than buried.** The note holds the booking as the
server derived it, including the customer's name, contact details and address —
the same data already in the Calendar event and in two emails. It is held for
**7 days** and deleted the moment the job is recorded. Redis previously held no
customer data. This is worth a decision before deployment.

### 2.9 Session and quality

- Both lint findings fixed without disabling rules. The mount `useEffect` is
  gone because the first set of times is now server-rendered through the same
  shared `loadAvailability` the API route uses — a change item 3 required
  anyway, not one made to satisfy lint. `window.location.assign` →
  `useRouter().push`.
- `loadAvailability` cannot throw: it is called during a server render, where
  an escaping error is a blank page rather than a failed fetch.
- **Suspended agency:** `loadTenantJob` and `accessByReference` now refuse when
  the commissioning organisation is inactive, re-read every request. **No
  existing appointment is cancelled** — a tenant is not party to the agency's
  account and would otherwise find an engineer simply not arriving.
  Withdrawing booked work is a commercial decision to take job by job.
- Renewal calculation remains inert. No commercial default, deadline exception
  rule or payer policy was introduced.

---

## 3. Unresolved access-policy dependency (reported, not invented)

**Tenancy replacement.** A job holds `tenancy_id` and a frozen
`property_snapshot.tenant` from creation. If the agency later replaces the
tenancy, the job keeps pointing at the old one and an invitation link issued to
the previous tenant keeps working until it expires (90 days).

Both answers cost something: revoking strands a tenant mid-booking; not
revoking leaves a former occupant able to see an address they have left. **This
is recorded in `lib/scheduling/access.ts` and deliberately not decided.** BSCJ
must choose:

1. Does replacing a tenancy revoke outstanding scheduling tokens?
2. Does a new household inherit the existing appointment, or get invited afresh?

---

## 4. Verification

### 4.1 Gates — actual exit codes, unfiltered

| Command | Exit |
|---|---|
| `npm test` | **0** — 1343 tests, 0 fail |
| `npm run typecheck` | **0** |
| `npm run lint` | **0** (was 1) |
| `npm run build` | **0** |

### 4.2 Real browser journey — executed

Against an **isolated** stack: a copy of the working tree in a scratch
directory, its own env, the local development database (0 business rows before
and after), and `scripts/browser-fixtures.mjs` replacing `globalThis.fetch` for
Google Calendar, Upstash and Resend. **No real Calendar event, no real email,
no production data.** The application code under test is unmodified.

Driven in the built-in browser at `localhost:3100`:

| Step | Result |
|---|---|
| `GET /schedule/<token>` | 307 → `/schedule/appointment`, `Set-Cookie: bscj-schedule=…; Path=/schedule; HttpOnly; SameSite=lax` |
| Appointment page | rendered with server-side availability, property and reference |
| Date → time → reserve | hold acquired, 29:59 countdown shown |
| **Confirm** | 200 → `/schedule/confirmed`, "Your appointment is booked" |
| Database | `scheduled`, `synced`, 1 activity (`appointment.scheduled`), 1 queued email |
| Calendar | exactly 1 event, matching the appointment |
| **Reschedule** to another day | 200 → confirmed at the new time |
| After reschedule | 1 live event; calendar ops were `insert(new)` → `delete(old)`, in that order; `appointment.rescheduled` activity with `previousStart`; `calendar_previous_event_id` cleared |
| **Reference + postcode door** (`BSCJ-FX0001` / `wv11aa`) | session issued, appointment page reached |

Negative cases over HTTP, cookie obtained the way a browser obtains it:

| Case | Result |
|---|---|
| Confirm, no cookie | 401 |
| Confirm, cookie, no `Origin` | 401 |
| Confirm, cookie, cross-site `Origin` | 401 |
| Confirm, cookie, same origin, bad hold | 409 `hold_expired` |
| Forged cross-job cookie | 401 |
| Unknown token / malformed token | 307 → `/schedule?problem=1` (identical) |
| `/schedule/appointment` with no session | 307 → `/schedule` |

**Concurrency, live:** two simultaneous confirmations of one job for different
slots → one 200, one 409 `conflict`. Result: **1 appointment, 1 activity row,
1 outbound-email row, 1 calendar event.** Same-slot retry → 200, idempotent.

**Reconciliation, live:** a job forced to `pending` with an orphaned previous
event, plus an unpersisted-booking note. One sweep: event written, orphan
deleted, booking recovered as a job, both queues empty, **one** live event for
that appointment and no second event for the recovered booking.

### 4.3 Automated tests added

Mocked (fast, deterministic) unless stated:

- `lib/scheduling/origin.test.ts` — path-match rule, same-origin checks.
- `lib/scheduling/confirm.test.ts` — initial vs reschedule, idempotent retry,
  lost race → `conflict` with **no** activity/email, 409 verification
  (matching / cancelled / different window), stale sync → `superseded` +
  cleanup, cleanup refusing to run before the replacement exists, calendar
  success + database acknowledgement failure and its retry.
- `(schedule)/schedule/api/confirm/route.test.ts` — HTTP handler: 401 paths,
  tampered/expired session, body cannot carry a job, no domain throw becomes a
  500, conflict wording, reconciliation only after a commit.
- `lib/booking/reservations.test.ts` — which states reserve, no double count,
  outage ≠ empty.
- `lib/jobs/booking-recovery.test.ts` — note survives the outage, no second
  event, **no email**, cancelled/vanished event not resurrected, idempotent.
- `api/availability/route.test.ts`, `api/book/route.test.ts` — capacity
  additions and public-booking recovery.
- `lib/jobs/persist-booking.test.ts` — updated for the batch; the losing
  transaction leaves no orphan customer or property.

### 4.4 Limitations — what was *not* proven

- **The Postgres driver's SQL is not asserted by the mocked tests.** The
  Drizzle fakes restate the predicates. The real SQL is covered by the live
  browser and concurrency runs above, against a real Postgres.
- **Google Calendar is a fixture in every run.** Real Google behaviour for
  409-on-cancelled-event, event restoration via `PUT`, and free/busy period
  merging is modelled from documentation, **not** observed. This is the largest
  remaining verification gap and needs a throwaway real calendar.
- **Resend was never exercised**; no email was sent by anything.
- **Hold expiry was not driven in real time** (30 minutes). Reservation
  behaviour independent of holds is proven by `reservations.test.ts` and by the
  reconciliation run; the interaction over a real 30-minute TTL is not.
- **No multi-instance test.** Concurrency was proven within one dev server.
- **The admin reconciliation UI was not driven in a browser** (no admin session
  was created). The engine underneath it was run live; the page and route are
  thin wrappers over it, verified by build and typecheck only.

---

## 5. Deployment prerequisites

1. ~~**`.env.local` is malformed and would break the app.**~~ **Fixed.** See
   §9.1. One newline inserted; no value read, rewritten or reordered. Both
   loaders now resolve every key identically and `DATABASE_URL` parses.
   **One thing still needs an owner decision:** the file contains *two
   different* `SCHEDULING_TOKEN_SECRET` assignments. Both were already there —
   one was hidden mid-line — and both loaders already resolved to the same
   (later) one, so nothing changed. The earlier, shorter value is dead and was
   left in place rather than deleted, because choosing which secret to destroy
   is not a decision to take silently. Removing the redundant line is a
   one-line edit for whoever owns the secret.
2. **Migration `0003` must be applied** before this code runs anywhere with a
   database. It is additive: one nullable column, two indexes, no rewrite. A
   down migration is provided. It has been applied **only** to the local
   development database.
3. **Decide the Redis retention question** in §2.8 before the recovery note
   carries customer data in a deployed environment.
4. **Schedule the reconciliation sweep**, or accept that unsynced appointments
   wait for someone to open `/admin/reconcile`. `POST /api/admin/reconcile`
   requires an admin session by design; a scheduled caller needs one.
5. **`/admin` is noindex via metadata but `robots.txt` still allows `/`.**
   Pre-existing; worth closing before a public launch.

---

## 6. Remaining defects and deferred decisions

Carried forward from the audit, **not** addressed here and still open:

- **Deadlines are stored and ignored** (`complete_by_date`,
  `deadline_exception_at`, `compliance_cycle.due_date`). A tenant with a 3-day
  deadline can still book 30 days out. Unchanged by this phase.
- **Tenant invitation delivery does not exist.** Tokens are minted and never
  sent; the raw value is unrecoverable by design, which constrains the outbox.
- **Secret rotation breaks live links.** `hmac$`/`sha256$` prefixes support
  *introduction*, not rotation — no key version, no previous-key fallback.
- **Google free/busy merging** can make a reschedule onto an adjacent slot
  report `slot_taken`. Safe direction, but a real limitation.
- BSCJ decisions still required: late-booking policy, deadline source of truth,
  renewal rule approval, payer separation, agency onboarding shape, tier
  pricing. None was invented here.

---

## 7. Next permitted phase

**V2.3.2 — deadlines and tenant communications.** Deadline cutoff applied in
availability and re-checked at confirmation, the recorded exception path
(`deadline_exception_at`) when no slot fits, and the invitation/confirmation
outbox with a worker. It depends on the late-booking policy decision above.

Do not begin V2.4.

---

## 8. Development tooling added (not application code)

None of this is imported by `src`; none can reach a production bundle.

- `scripts/browser-fixtures.mjs` — preloaded `fetch` interceptor standing in
  for Google Calendar, Upstash and Resend. File-backed state so a test can read
  what the server wrote.
- `scripts/dev-with-fixtures.sh` — dev server with those fixtures, a throwaway
  RSA key generated per run, and fixture credentials exported *before* Next
  starts so they win over `.env.local`.
- `scripts/seed-scheduling-fixture.mjs` — one agency/property/tenancy/job/token.
  Refuses to run without `BSCJ_ALLOW_FIXTURE_SEED=1`; every row is prefixed
  `FIXTURE`; `--clean` removes exactly what it created. **All fixture rows were
  removed**; the development database is back to 1 admin user and 0 business
  rows.
- `scripts/next-headers-stub.mjs` + a resolver entry — lets route handlers that
  use `next/headers` be unit tested, mirroring the existing `next/server` stub.
- `.claude/launch.json` — a `fixtures` entry added alongside the existing
  `bscj-dev` one.


---

## 9. Close-out review (after the first implementation)

A second pass over this phase's own diff, on the axes the owner named. It found
seven defects, all in work added by this phase. All are fixed; each has a
behavioural test.

### 9.1 Configuration

`.env.local` had `DATABASE_URL="…"SCHEDULING_TOKEN_SECRET=…` on one line.
Exactly one newline was inserted between the two assignments — no value was
read, re-quoted, reordered or removed, and the file mode is unchanged.

Verified by fingerprint (SHA-256 prefix + length; **no value printed or
recorded anywhere**), before and after, under both loaders:

| | Node `loadEnvFile` before | Next loader before | Both, after |
|---|---|---|---|
| `DATABASE_URL` | valid (149) | **invalid (239)** | valid (149) |
| `SCHEDULING_TOKEN_SECRET` | 96 | 96 | 96 |
| every other key | — | — | unchanged |

So no scheduling token is invalidated and no other setting moved. A dev server
started on the real fixed file then served `/schedule/<token>` (a read-only
database path), `/api/availability` and `/admin/login` with **zero**
connection-string errors, creating no business records; Google, Upstash and
Resend were stubbed throughout, so no customer was contacted.

### 9.2 Defects found and fixed

| # | Defect | Fix |
|---|---|---|
| 1 | `recoverUnpersistedBooking` **rethrew** anything that was not a `KvUnavailableError`. It is called from `/api/book` outside the handler's try/catch, so a repeat click during a store fault would have been **HTTP 500 on a booking that had already succeeded** — a new failure mode in the public flow, introduced by the machinery meant to protect it. | Every failure is now a value (`store_error`). Both recovery calls in `/api/book` are additionally wrapped. |
| 2 | When **both** Postgres and Redis failed, nothing was recorded anywhere — the note's failure was discarded by the caller. The booking was real and unrecoverable **in silence**. | `recordUnpersistedBooking` now reports `NOT RECORDED` with the reference and a category. A test asserts the line carries no name, email, phone, postcode, street or idempotency key. **This is detection only — it is not recovery, durable or otherwise.** See §9.4. |
| 3 | The reconcile page showed "the store could not be listed" **only when every other queue was empty**. With any other work outstanding, unrecorded bookings were reported as absent when they were merely unknown. | The alert renders whenever the listing failed, and the empty state reads "Nothing outstanding that this page can see." Verified in a browser (§9.3). |
| 4 | `calendar_previous_event_id` holds **one** id. Two moves in a row while Google is unreachable overwrote the first, and the event it named was orphaned forever — the `calendar.cleanup_outstanding` activity written instead was a **dead letter** nothing read. | An event id is a pure function of (job, slot), and every slot a job has left is on its timeline as `previousStart`. `orphanedEventIdsForJob()` recovers them; the sweep deletes them. Never proposes the live event — the **A → B → A** case is tested explicitly. |
| 5 | A job mid-reschedule is a Google booking at its old time *and* a Postgres reservation at its new one, so it **counted twice** against the daily cap and could close a day a booking early. | `fetchUnsyncedReservations` now returns `supersededEventIds`; availability, `/api/book` and `confirmTenantAppointment` exclude them from the count. The old event's **times** still block their slot, which is correct — the entry really is in the diary. |
| 6 | `POST /api/admin/reconcile` had **no origin check** — protected only by Auth.js's `SameSite=Lax` default. | Explicit `checkSameOrigin`, refused before the session is read. Same reasoning as the tenant endpoint. |
| 7 | `scripts/browser-fixtures.mjs` replaced `globalThis.fetch` **unconditionally on import**. A stray `NODE_OPTIONS` would have stubbed a real process's network silently. | It now requires `BSCJ_TEST_FIXTURES=1` and throws outright if `NODE_ENV=production`. Verified both ways. |

### 9.3 Admin reconciliation page — verified in a browser

Access protection, signed out: `/admin/reconcile` → 307 to
`/admin/login?next=%2Fadmin%2Freconcile`; `POST /api/admin/reconcile` → 401
with and without a cross-site `Origin`; `GET` on the mutation endpoint → 401.

Signed in as a throwaway `FIXTURE Admin` (created with the application's own
hasher, used only here, **deleted afterwards**), against the isolated fixture
stack with one job forced to `pending` + an orphaned event, and the reservation
store deliberately absent:

- The page rendered both queues **and** the "could not be listed" alert — the
  §9.2/3 fix, visible.
- **Run reconciliation now** reported `1 done, 0 still failing`, `1 of 1` old
  events removed, and `store could not be listed` for bookings.
- Result: job `synced` with the correct derived id, `calendar_previous_event_id`
  cleared, **exactly one** live calendar event, calendar ops in the order
  `insert(new)` → `delete(old)`, and one audit row carrying counts only.

Everything created for this was removed: the development database is back to
**1 app_user and 0 business rows, 0 audit rows**.

### 9.4 What happens when both stores fail — **an open gap, not a fix**

Stated plainly, because it is the design's floor:

1. Calendar event written — **the appointment is real from here**.
2. Customer confirmation and the internal alert attempted.
3. Postgres persistence fails.
4. Redis note fails too.
5. `console.warn("[booking-recovery] NOT RECORDED … for reference BSCJ-XXXXXX")`.

**The log line is detection, not recovery.** It does not preserve the booking,
it cannot be replayed, and nothing consumes it: it is a stderr line whose
survival depends entirely on whatever the host happens to do with process
output. If nobody reads the logs, the booking is lost from the operational
record exactly as it was before — the only thing that changed is that the loss
is now *noticeable* rather than silent.

Concretely, after a double failure:

- There is **no automatic route back**. Nothing will retry it.
- `/admin/reconcile` will not show it; the sweep cannot find it; there is no
  queue entry, because writing the queue entry is the step that failed.
- Reconstruction from the calendar event is deliberately **not** attempted —
  the description holds a *formatted* address, not the parts a property row
  needs, and guessing would put invented data into the operational record.
- The booking survives only as: the Google Calendar event, the customer's
  confirmation email, and BSCJ's internal alert email. Rebuilding the job from
  those is **manual**, and the reference in the log line is what makes it
  findable.

**Recovery is therefore reliable only while at least one of Postgres or Redis
is reachable.** Making it reliable under a simultaneous outage needs a durable
sink on a third failure domain — an append-only file the host ships, or a queue
— which is a design change beyond this corrective phase and is not attempted
here.

### 9.5 Retention — unchanged

The recovery note still holds customer data in Redis for **7 days**. Nothing in
this pass altered that, deliberately: it is a policy decision for BSCJ, not one
to change while fixing defects. It remains a deployment prerequisite (§5.3).

### 9.6 Gates, re-run

| Command | Exit |
|---|---|
| `npm test` | **0** — 1369 tests, 0 fail |
| `npm run typecheck` | **0** |
| `npm run lint` | **0** |
| `npm run build` | **0** |

### 9.7 Migration 0003 — departure from instruction, recorded

The instruction was not to apply the migration to existing databases. **It was
applied to the existing local development database** during the first
implementation, because the browser journey could not run without the column.
Confirmed still applied: `calendar_previous_event_id` (text, nullable) and both
indexes are present, journal shows 4 of 4.

It has **not** been rolled back and **no further change** has been made to any
existing database. The migration is additive; the down migration is committed.
No other database has been touched.

### 9.8 Remaining real-service verification gaps

Unchanged from §4.4 and still the honest limit of this work:

- **Google Calendar has never been exercised for real.** 409-on-cancelled-event,
  `PUT` restoration of a deleted event, and free/busy period merging are all
  modelled from documentation. This is the largest gap and needs a throwaway
  real calendar.
- **Resend has never sent anything.**
- **Hold expiry over a real 30-minute TTL** has not been driven.
- **No multi-instance concurrency test** — races were proven within one server.
- The new **orphan-from-history sweep** is proven against the fixture calendar
  only; its cost against real Google quota is unmeasured.

---

## 10. Remaining gaps, in one place

Everything below is **open**. None of it is fixed by this phase.

### 10.1 Recovery

| Gap | Status |
|---|---|
| Postgres persistence fails, Redis reachable | **Covered.** Note written to Redis; `/admin/reconcile` lists it; the sweep replays it idempotently — no second event, no second email. |
| Postgres *and* Redis both fail | **Open.** Detection only: a `NOT RECORDED` log line carrying the reference. No queue entry, no retry, no listing. Rebuilding the job is manual. Closing this needs a durable sink on a third failure domain — see §9.4. |
| Recovery note expires unread after 7 days | **Open.** The note is deleted on expiry and nothing records that it existed. A booking whose note expires before anyone runs the sweep falls back to the manual case above. |
| Nothing runs the sweep on a schedule | **Open.** `/admin/reconcile` is manual; `POST /api/admin/reconcile` requires an admin session by design, so a cron caller needs one. Until that is arranged, unsynced appointments wait for a person. |

### 10.2 Retention — needs a decision before deployment

The recovery note holds the booking as the server derived it — **the customer's
name, contact details and address** — in Redis for **7 days**, deleted the
moment the job is recorded. The same data already sits in the Google Calendar
event and in two emails, but Redis previously held **no customer data at all**,
so this is a new processing location.

Deliberately left unchanged by the close-out pass: altering retention while
fixing defects would be a silent policy change. BSCJ must decide whether this
is acceptable, and whether the privacy notice needs to say so.

### 10.3 Real-service verification

| Service | State |
|---|---|
| **Google Calendar** | **Never exercised for real.** Every run used the in-process fixture. 409-on-cancelled-event, `PUT` restoration of a deleted event, and free/busy period merging are modelled from documentation. **The largest gap** — needs a throwaway real calendar. |
| **Resend** | **Never sent anything**, in any run. |
| **Upstash Redis** | Real REST semantics were reimplemented in the fixture; the live service was never called. |
| **Hold expiry** | Not driven over a real 30-minute TTL. |
| **Concurrency** | Proven within a single dev server only; no multi-instance test. |
| **Orphan-from-history sweep** | Proven against the fixture calendar only; its cost against real Google quota is unmeasured. |

### 10.4 Carried over from V2.3, still open

Deadlines stored and ignored; tenant invitation delivery does not exist; secret
**rotation** breaks live links (introduction works, rotation does not); tenancy
replacement has no access policy (§3); and the BSCJ decisions in §6 — late
booking, deadline source of truth, renewal rule, payer separation, agency
onboarding, tier pricing — remain unanswered. None was invented here.
