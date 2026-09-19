# V2.3 — booking and communication

> **The booking and communication phase is complete and committed.** An agency
> creates a job; the tenant is invited, verifies themselves, chooses a time
> within the deadline or knowingly after it; and everybody who needs to know is
> told.
>
> | Checkpoint | What |
> |---|---|
> | `2e854bd` | V2.3.1 corrective work (§1–§10) |
> | `e4103e9` | Deadlines and late-booking exceptions (§11) |
> | see §13 | Invitations, the email worker, and the tenant-surface closeout |
>
> **Email processing is not automatic yet.** The schedule is configured but
> takes effect only on a deploy that has not happened. Until then every send is
> a person pressing a button. See §12.6.
>
> **Next phase: the practical admin/engineer operations workflow** — see §14.

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

~~**V2.3.2 — deadlines and tenant communications.**~~ The deadline half is now
implemented — see **§11**. What remains of V2.3.2 is **tenant invitation
delivery**: tokens are minted and never sent.

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

---

# 11. V2.3.2 — deadline-aware scheduling and late-booking exceptions

Built on checkpoint `2e854bd`. **No migration was needed**: every column this
uses already existed (`job.complete_by_date`, `job.deadline_exception_at`,
`compliance_cycle.due_date`, `outbound_email`). No database was altered.

## 11.1 The approved rules, and where each one lives

| Rule | Where |
|---|---|
| Earlier of the requested completion date and the active certificate due date; both preserved separately | `lib/scheduling/deadline.ts` — pure, `resolveDeadline` |
| One date only → that one; neither → normal availability | same, `status: "none"` is distinct from a lenient cutoff |
| Must **finish** by the end of that date, Europe/London | `endOfDayInZone` — exclusive bound at the next day's London midnight |
| Show only compliant appointments first | `TenantScheduler`, filtered on the slot's **end** |
| "None of these times work" reveals later times after a clear warning | `TenantScheduler`, an explicit button — never a silent widening |
| Tenant must explicitly acknowledge; no BSCJ approval needed | unticked checkbox gates a disabled button; `acknowledgedLateBooking` permits |
| Preserve the deadline, record exception + acknowledgement, notify agency and BSCJ, flag needs-attention | `confirmTenantAppointment` writes all of it in **one batch** |
| Never imply the deadline was met or extend the certificate | asserted in tests and in the email/UI copy |

## 11.2 Enforcement is server-side

`confirmTenantAppointment` **re-reads both dates** (`fetchJobDeadline`) at
confirmation. The browser's filtering decides what is *shown*; this decides
what is *allowed*. An agent can move `complete_by_date` while a tenant is
choosing, and the confirmation catches it — tested.

`acknowledgedLateBooking` only ever **permits**. Forging it books late *and is
recorded, flagged and notified as late*. What it cannot do is make a late
appointment look on-time, which is the only property that matters.

## 11.3 Rescheduling

- Late → compliant: `deadline_exception_at` is **cleared**, so the job leaves
  the needs-attention list. The exception's timeline entry stays — history is
  not rewritten, only the current position.
- Late → another late slot: a new exception is recorded against the new
  appointment, and queued alerts for the old one are stood down.
- Any move: `cancelSupersededNotifications` cancels **unsent** rows only.
  Something the provider already accepted cannot be recalled, and rewriting its
  state to pretend otherwise would be a lie in the record.

## 11.4 Notifications

Durable intent in `outbound_email`, written **in the same batch as the
appointment**. Sending is separate and can never touch the appointment.

- `pending` = queued · `sent` = **the provider accepted it** · `failed` = gave
  up after 5 attempts · `cancelled` = superseded.
- **`sent` is not a delivery receipt** and nothing in the UI, the audit line or
  the report says it is: the admin view reads "accepted by the email provider".
- Keyed on job + **appointment** + recipient, so a reschedule is a new alert and
  a retry is not a duplicate; `onConflictDoNothing` stops a double submission
  queueing four.
- **Never ahead of the diary**: a row whose job is not `calendar_sync_state =
  synced` stays queued and does **not** consume an attempt.
- **Missing address is visible**: recorded as `agent_email_missing` /
  `bscj_email_missing`, surfaced by name on `/admin/reconcile`.
- Drained last in the existing reconciliation sweep, bounded.

## 11.5 Where it is displayed

`/admin/jobs/[id]` and `/portal/jobs/[id]` show the deadline, **both**
underlying dates, which one produced the cutoff, and when the tenant
acknowledged. The admin view additionally shows each notification's state.
`needsAttention` now includes `hasDeadlineException`.

## 11.6 Verification

Gates: `npm test` **0** (1435 tests) · `typecheck` **0** · `lint` **0** ·
`build` **0**.

New tests: `lib/scheduling/deadline.test.ts` (23 — including GMT/BST, both
clock changes, the 25-hour day, month/year/leap-year ends, and that the
appointment's **end** is what is compared), `lib/notifications/outbox.test.ts`
(29), and additions to `lib/scheduling/confirm.test.ts` covering ordinary
bookings, explicit late bookings, tampered acknowledgement, a deadline changed
mid-session, and both reschedule directions.

**Browser journey, isolated fixtures** (local dev database, Google/Upstash/
Resend stubbed in-process, no real email, no real calendar event):

- Deadline 21 Sep (requested) vs 1 Dec (certificate) → banner named **21 Sep**,
  and only the two compliant dates were offered.
- "None of these times work" → warning naming the date, stating it does not
  change and does not extend any certificate → 10 dates offered.
- Late slot selected → **"Confirm this late appointment" disabled** until the
  unticked box was ticked → confirmed.
- Recorded: `deadline_exception_at` set; exception activity with both dates,
  the source, the appointment and the acknowledgement; two queued alerts.
- Over HTTP: the same slot **without** acknowledgement → 409 `deadline_exceeded`
  carrying both dates; **with** it → 200.
- Overdue deadline (10 Sep) → straight to the warning, no empty list, no
  pointless escape button.
- Sweep with no addresses configured → `bscj_email_missing` and
  `transport_not_configured`, both visible, row still queued. With addresses
  configured → both **accepted by the provider**, timestamped; a second sweep
  considered 0.
- `/admin/jobs/[id]` rendered the notice with both dates and
  "accepted by the email provider".

**A defect this found:** `cancelSupersededNotifications` used a disjunction of
inequalities for its keep-set, which is true of every key — so a confirmation
cancelled the two alerts it had just queued and nobody would ever have been
told. Fixed to `notInArray`, with a regression test.

## 11.7 Limitations

- **Still no real email has ever been sent.** Resend is stubbed in every run;
  provider acceptance is modelled, not observed. Unchanged from §10.3.
- **Nothing schedules the sweep.** Alerts wait for someone to open
  `/admin/reconcile`. Unchanged from §10.1.
- **The compliance cycle is read, never written.** Nothing in this phase
  creates or supersedes one, so the certificate date only participates where an
  active cycle already exists.
- **Renewal calculation remains inert**; no pricing, payer or commercial
  default was introduced.
- **Only the tenant flow enforces the deadline.** The public consumer booking
  and agent-created jobs are unchanged — a consumer booking has no deadline to
  miss, and an agent choosing a time is choosing their own.
- `job.complete_by_date` is a `date` column that the driver returns as a
  timestamp; the admin row prints it raw. Cosmetic, not a data problem.
- **Seven-day customer-data retention (§10.2) is still unapproved.**

---

# 12. V2.3.2 — tenant invitations and the email worker

Built on checkpoint `e4103e9`. **No migration was needed**: `outbound_email`,
`scheduling_token` and `tenancy.email` already existed. No database was
altered.

## 12.1 The agency → tenant workflow

| Step | Where |
|---|---|
| Creating an agency job records a scheduling invitation | `create-agent-job.ts` — the outbox row is written **in the same batch** as the job and its token |
| The tenant gets a usable secure link | `lib/email/tenant-scheduling.ts` + the worker |
| The message identifies the agency and property | agency name, service, address, postcode, reference |
| **No pricing, no billing** | asserted live: no `£`, "price", "invoice" or "pence" in anything sent to a tenant |
| Hashed token verification preserved | only `token_hash` is ever stored; `accessByToken` is unchanged |
| Controlled resend with visible status | admin-only Server Action + the Messages panel on `/admin/jobs/[id]` |
| Existing confirmations and late-booking alerts delivered | the same worker now handles all three kinds |

**The link is minted at send time, not at queue time.** The token created with
the job is stored only as a hash, so its plain value cannot be recovered — a
property worth keeping, not working around. Each delivery attempt therefore
mints a fresh token and **leaves earlier ones valid**: a first attempt that
timed out may well have arrived, and invalidating its link would break a
message the tenant is already holding. Verified live — both links resolved.

**No raw token is ever logged.** Checked against the server log: zero 64-hex
strings. It exists in the worker's local scope and in the message body.

## 12.2 The worker

`drainOutbox` handles `tenant-scheduling-invitation`,
`tenant-appointment-confirmation` and `late-booking-exception`.

**Eligibility differs by kind, deliberately:**

- An **invitation** is about a job, not a time. It is eligible **before any
  appointment exists** and the calendar requirement does **not** apply to it.
- A **confirmation** and a **late-booking alert** describe one appointment.
  Both require that the job still holds it *and* that
  `calendar_sync_state = synced`. A row waiting on the diary stays queued and
  the attempt it spent on claiming is **given back** — waiting is not trying.

**Concurrency.** Claiming is a conditional update on the attempt count the
worker read: `SET attempts = n + 1 WHERE id = ? AND state = 'pending' AND
attempts = n`. Exactly one worker wins; the other moves on. No lease column, no
lock table, no migration. **Proven live**: two simultaneous workers, one claim,
one email.

**Ambiguous provider outcomes.** The attempt is counted *before* the send, so a
process dying between acceptance and the row update costs one retry rather than
looping. Resend's own idempotency key stops that retry becoming a second email.

**Stale retries.** Every appointment-scoped row is re-checked against the job's
current appointment at send time, and `cancelSupersededNotifications` stands
down unsent rows when an appointment moves. Rows already accepted are never
rewritten — something the provider took cannot be recalled.

## 12.3 States, and what they are allowed to claim

`pending` = queued · `sent` = **the provider accepted it** · `failed` = gave up
after 5 attempts · `cancelled` = superseded.

Nothing says "delivered". The admin Messages panel reads "Accepted by the email
provider"; `/admin/reconcile` says the same. Failure reasons are shown in plain
English — "no email address on file for the tenant",
"BOOKING_NOTIFICATION_EMAIL is not configured" — because a missing address is
fixed in configuration, not by retrying.

## 12.4 Verification

Gates: `npm test` **0** (1468 tests) · `typecheck` **0** · `lint` **0** ·
`build` **0**.

New tests: `lib/ops/cron-auth.test.ts` (10), `lib/scheduling/deadline-lookup.test.ts`
(10 — including that a **CP12 certificate expiry does not constrain a boiler
service**), and 13 added to `lib/notifications/outbox.test.ts` covering
invitations, confirmations, claiming and duplicate execution.

**End-to-end, isolated fixtures** (local dev database; Google, Upstash and
Resend stubbed in-process; no real email, no real calendar event):

1. A **real agency user** signed into the portal and booked CP12 work on a
   property — job `BSCJ-CYJZFG`, `tenant_outreach`, with an invitation queued
   by the application itself.
2. The worker sent it. The captured message named the agency and property,
   carried a working link, and contained no pricing.
3. The tenant opened the link. With only a **certificate** due date (22 Sep) and
   no requested date, the page offered exactly the three compliant days.
4. The tenant booked 21 Sep → confirmed → the worker sent the appointment
   confirmation, again with no pricing.
5. The tenant then moved to 25 Sep: refused **409** without acknowledgement,
   **200** with it. The worker sent a fresh confirmation plus alerts to the
   agency and BSCJ, both naming the deadline and stating it had not changed.
6. **Resend**, driven in the browser: "Queued. It will be sent on the next run
   of the outbox, with a fresh link." Two concurrent workers → one claim, one
   email, a **distinct** link, and both links still resolving.
7. **Retry**: with the transport unconfigured, five passes took the row to
   `failed` with `transport_not_configured`, visible on `/admin/reconcile`.
8. Endpoint protection: no credential → 401, wrong bearer → 401, correct bearer
   → 200.

Development database returned to **1 app_user, 0 business rows, 0 audit rows**.

## 12.5 Limitations

- **No real email has ever been sent.** Resend is stubbed in every run;
  provider acceptance is modelled, not observed. Still the largest gap.
- **Delivery is unknown by design.** No webhook, no bounce handling. A wrong
  address that the provider accepts looks identical to one that arrives.
- **The invitation link uses `business.url`** — the production domain. A
  staging deployment would send links pointing at production until that is made
  configurable.
- **Resend is not rate-limited per job.** An administrator can queue as many as
  they like; the audit log records each.
- **`cancelSupersededNotifications` does not cancel invitations**, deliberately:
  an invitation is not about a time.
- **Seven-day retention (§10.2) is unchanged and still unapproved.**

## 12.6 Activation — what is required before processing is automatic

**It is not automatic yet.** `vercel.json` declares the schedule, but a
`vercel.json` only takes effect on a deploy, and none has happened. Until all
of the following are done, every message waits for a person to press
**Run reconciliation now** or to call the endpoint.

| # | Required | Notes |
|---|---|---|
| 1 | Set **`CRON_SECRET`** (≥ 24 characters) | Until it is set the scheduler door **does not exist** — `checkCronSecret` fails closed. |
| 2 | Set **`RESEND_API_KEY`** and **`BOOKING_EMAIL_FROM`** | Without them every send records `transport_not_configured` and retries to `failed`. |
| 3 | Set **`BOOKING_NOTIFICATION_EMAIL`** | Without it BSCJ's own late-booking alert records `bscj_email_missing`. |
| 4 | Apply **migration 0003** | Additive; see §9.7. |
| 5 | Fix `business.url` for the target environment | Otherwise invitation links point at production. |
| 6 | Deploy, then confirm the cron appears in the Vercel dashboard | Every 10 minutes at `/api/cron/outbox`. |
| 7 | Send one real invitation to an address you control | The only way to close the "no real email" gap in §12.5. |

Tenants must have `tenancy.email` populated; without it an invitation records
`tenant_email_missing` and is visible on the job and on `/admin/reconcile`.

---

# 13. Closeout — the tenant surface, and one real worker defect

## 13.1 A link is no longer a key

**This was the significant change.** Opening an invitation link used to issue a
scheduling session and drop the tenant straight onto their appointment, so the
URL alone showed an address, a reference and a booked time. Links get
forwarded, screenshotted, left in shared inboxes and pasted into chats.

Now the token proves only that the holder was sent something, and what it buys
them is **a form with the reference already filled in**. The postcode is still
required and `accessByReference` still decides — generically, rate limited per
caller *and* per reference.

- The reference travels in a **signed, path-scoped, 30-minute prefill cookie**,
  not a query string: a URL ends up in history, a referrer and somebody's logs.
- A prefill is **not** a session and a session is **not** a prefill — separate
  signing labels, and both directions are tested.
- The prefill is cleared once a session replaces it.
- A bad token lands exactly where a good one does, bar the prefill.

## 13.2 The scheduling surface

Minimal BSCJ branding, no site navigation, no marketing pages, no prices, no
promotion. The logo is the only navigation a tenant gets and it goes to
`/schedule` — the entry screen — and nowhere else. Enforced by a test that
walks every file in the route group and rejects any `href` outside `/schedule`
(bar `tel:` and WhatsApp), and any mention of money.

After verification the existing date/time flow and the explicit late-booking
acknowledgement are untouched.

## 13.3 The worker defect this phase found

The targeted check — **pause worker A inside its send, start worker B after A
has claimed** — exposed a real defect, and the attempt-count comparison was
exactly what hid it.

**Before:** A read `attempts = 0` and claimed → 1. B, starting a second later,
read `attempts = 1` and claimed from there → 2. Both conditional updates
succeeded, because the row was still `pending` while A was in flight. **Two
invitations went out, with two different links, for one intent.** Both workers
incremented perfectly, so the counts looked healthy.

**Fix:** a claim now also takes a **lease**. `updated_at` moves, and a row that
recently moved is not considered at all. A freshly queued row (`attempts = 0`)
is exempt so a first send does not wait. The lease doubles as retry backoff and
as crash recovery — a process that dies holding a row loses its lease and the
row returns to the queue on its own.

**After, same scenario, evidence beyond attempt counts:**

| | Before fix | After fix |
|---|---|---|
| B's `considered` | 1 | **0** — it never saw the row |
| B's `claimed` | 1 | 0 |
| Messages at the provider | **2** (`invite-1`, `invite-2`) | **1** (`invite-1`) |
| Final `attempts` | 2 | 1 |

## 13.4 A second, smaller defect

`cookies().delete(name)` targets path `/`, which never matches a cookie scoped
to `/schedule` — so the prefill survived the session that replaced it and the
entry form came back filled in with a job the tenant had finished with. Fixed
by deleting on the path it was set with. Found in the browser.

## 13.5 Verification

Gates: `npm test` **0** (1490 tests) · `typecheck` **0** · `lint` **0** ·
`build` **0**.

**Browser, isolated fixtures** (local dev database; Google, Upstash and Resend
stubbed in-process; no real email, no real calendar event):

| Check | Result |
|---|---|
| Invitation link | 307 → `/schedule`, **not** the appointment; sets only `bscj-schedule-ref` |
| Link alone → `/schedule/appointment` | 307 back to `/schedule` — it opens nothing |
| Entry screen after a link | "We have your reference. Please confirm the postcode…", reference filled, **no job detail on the page** |
| Valid reference + **wrong** postcode | same generic refusal, still on the form |
| Valid reference + correct postcode | `/schedule/appointment` |
| Path B, no invitation at all, cookies cleared | reference + postcode typed → `/schedule/appointment` |
| Logo | returns to `/schedule` from the appointment page |
| Links on the tenant surface | exactly one: `/schedule` |
| Prefill after use | cleared |

Development database returned to **1 app_user, 0 business rows**.

## 13.6 Outstanding launch gaps

Nothing below is closed by this phase.

- **No real email has ever been sent.** Resend is stubbed in every run.
  Provider acceptance is modelled, not observed. Still the largest gap.
- **Delivery is unknown by design** — no webhooks, no bounce handling.
- **No real Google Calendar call has ever been made** (§10.3).
- **Automatic processing is not active** (§12.6).
- **Seven-day retention of customer data in Redis is unapproved** (§10.2).
- **Recovery is unreliable if Postgres and Redis fail together** (§9.4).
- **`business.url` is hard-coded**, so a staging deploy would send links
  pointing at production.
- Tenancy replacement has no access policy (§3); the commercial decisions in
  §6 are unanswered.
- `/admin` is `noindex` by metadata but `robots.txt` still allows `/`.

---

# 14. Next phase — the practical admin/engineer operations workflow

Everything so far gets work *booked*. Nothing yet helps BSCJ **do** it. The
next phase is the day the engineer actually drives somewhere:

1. **An engineer's day view** — today's appointments in order, with the address,
   the access notes and the tenant's number, on a phone.
2. **Assignment**, and the `engineer_assigned` transition the lifecycle already
   allows.
3. **On site**: `in_progress`, then `completed` — with the outcome recorded
   against the job rather than remembered.
4. **Remedials**, recorded against the stored remedial authority that already
   exists on the organisation and the job.
5. **The needs-attention queue**, now fed by real signals: failed calendar
   syncs, late-booking exceptions, failed messages, unrecorded bookings.
6. **Admin job search, filters and pagination**, which `/admin/jobs` does not
   have and which stops being optional the moment there are more than a screen
   of jobs.

Explicitly still out of scope: certificates and documents, invoicing, renewals
and outreach prioritisation, pricing tiers, and bulk import.

---

# 15. V2.4 — the admin and engineer operations workflow

**Uncommitted, for review.** Everything below is in the working tree on
`v2-compliance-platform` at `e3c2a2f`. Nothing was pushed or deployed, no
customer was contacted, and no real email or calendar call was made.

This is §14 items 1, 2, 3, 5 and 6. **Remedials (§14.4) are deliberately not
here** — they need the approval flow and the stored authority, which is its
own phase. Certificates, invoicing, renewals and pricing tiers remain out of
scope and nothing here touches them.

## 15.1 The one schema change

`0004_job_work_record` — two nullable columns on `job`, no index, no backfill,
a down migration alongside it:

- `work_started_at` — when the engineer said they were on site.
- `completion_notes` — what they found, free text. **Not a certificate**, not
  a substitute for one, and nothing parses it or derives a fact from it.

Neither is a filter: the lifecycle status already answers "has this started"
and "is it done", and an index on a free-text note would only invite querying
it as though it meant something.

**Applied to the development database** (confirmed by the owner before it was
run), which is where the browser pass below happened. It has not been applied
anywhere else.

## 15.2 Totals, and the private/agency distinction

`/admin` was a page of prose with a database-connected badge. It is now the
day's position, and two rules shape it.

**Every number is clickable.** Each tile links to the job list filtered to
exactly the rows it counted, so "7 need attention" and the seven jobs are the
same query rather than two that can disagree. A figure nobody can open is a
figure nobody can check.

**The overall total is shown with the private/agency split, not apart from
it.** A job either belongs to an agency or it does not, so the two are exactly
the parts of the total and a reader can check the page by adding them up.
Consumer work is the rows with no organisation — which only an
administrator's unfiltered scope can see at all.

The total is deliberately *not* a fourth tile in the row above: "today" and
"open" overlap each other, and a total sitting beside them reads as another
bucket rather than as the sum of the two figures beneath it.

All three counts come from one pass over the same scoped rows — `COUNT(*)`
plus conditional counts on `agent_organisation_id IS NULL` and `IS NOT NULL`,
which are mutually exclusive and exhaustive. Nothing is counted twice and
nothing is missed. Structural tests assert the single pass, the complementary
conditions, that the open halves are the same split narrowed the same way,
that `totals.all` is actually rendered, and that every figure links to the
rows it counted.

The counts are **one pass** over the caller's rows with conditional sums
(`COUNT(*) FILTER (WHERE …)`), not nine separate queries: nine scans on a page
opened every visit, and they could disagree with each other if a job moved
between them.

One thing the dashboard deliberately does **not** count: bookings that exist
in the calendar and were never recorded here. They live in the reservation
store, reading it can fail, and a failed read showing as a zero is the one
thing that page exists not to do. It links to `/admin/reconcile`, which
already reports them honestly.

## 15.3 Search, filters and pagination

Three kinds of control, kept separate because they are genuinely different
questions:

- **Views** — the question somebody opens the page with: today, upcoming,
  nobody allocated, needs attention, open, closed. Not statuses: "today" is
  true of jobs in four different statuses at once.
- **Filters** — a fact about the row: private or agency, stage, engineer
  (anybody / nobody yet / a named one).
- **Search** — free text over the four things a person actually has in front
  of them: a reference, a name, a postcode, a street.

A plain `GET` form. No JavaScript is needed to search, filter or page, every
state of the screen is a URL somebody can send to somebody else, and the back
button behaves.

**The query string can only ever narrow, never widen.** `lib/jobs/filters.ts`
validates every field against a closed set or clamps it to a range, and there
is deliberately **no organisation field in it** — which rows a caller may see
is decided by `AccessScope`, built from the session, and the scope condition
is the first term of every `WHERE`. There is a test asserting the absence.

Smaller decisions worth knowing: the page size is capped at 100 so a
hand-edited URL cannot ask for the whole table; an out-of-range page lands on
the last page rather than on an empty screen, because the row count can change
between a link being made and opened; changing any control resets to page one;
and `%` typed by a person is escaped, so a customer named `%` does not match
every row.

`ILIKE '%…%'` cannot use an index. That is a deliberate trade at this size —
the alternative is full-text infrastructure for a business with hundreds of
jobs — and it is bounded by the same pagination as everything else.

## 15.4 Needs attention, fed by real signals

`derived.ts` already answered *whether* a job needs attention. That is the
right shape for a badge and the wrong shape for a queue: a count tells nobody
what to do. `lib/jobs/attention.ts` turns the same facts into **named
reasons**, each with an obvious action:

| Reason | Signal |
|---|---|
| Not yet in the calendar | `calendar_sync_state` is `pending` or `failed` |
| Old calendar entry to remove | `calendar_previous_event_id` is set |
| A message could not be sent | a `failed` row in `outbound_email` |
| Booked after the requested date | `deadline_exception_at` is set |
| Past / close to the requested date | computed from `complete_by_date` |
| Remedial waiting for approval | a `remedial` row `awaiting_approval` |

Every one is a recorded signal. Nothing here is a heuristic or an invented
threshold — a queue that reports things nobody can verify is one that gets
ignored, and an ignored queue is worse than none.

**The badge and the reasons cannot disagree.** `attentionFor()` returns both,
and a test enumerates every combination of every status, risk and flag
(>1,000 cases) asserting that "needs attention" is true exactly when the
reason list is non-empty. The same signals are expressed once as SQL, so the
dashboard count, the `attention` view and the per-row chips are one definition.

A cancelled job needs nobody, whatever is outstanding on it: its messages are
stood down by the outbox and its calendar entry by the sweep.

## 15.5 The job detail page

It was a read-only check that a booking had been recorded. It now carries:
who is on it, when they started and finished, what they recorded, the reasons
it needs somebody, the deadline position, the agency or "private", and — the
new one — **the history**.

`jobTimeline()` reads `activity` **through the job**, so the caller's scope
decides there exactly as everywhere else: a timeline is a record of somebody's
property and tenant, and reaching it by job id must not be easier than
reaching the job. The actor's name is resolved for display; `detail` is never
rendered raw, only a short allow-list of fields, because it can carry internal
ids that mean nothing on screen and should not be on one.

## 15.6 Allocation, and the work itself

One mutation on the admin page — **allocation** — and two on the engineer's.
Starting and completing belong to whoever is standing at the property, so they
are not duplicated in the admin area; an administrator who needs them opens
`/engineer`, which they are allowed to do, and acts **as themselves** rather
than on somebody's behalf. There is still no "view as", and inventing one here
would be the wrong way to build it.

`lib/jobs/work.ts` holds the rules, pure and dependency-free, and **both the
buttons and the writes read the same functions** — so a control that is shown
and an action that is permitted cannot drift apart. The rules:

- Allocation needs an appointment. Allocating somebody to a job with no agreed
  time is allocating them to nothing, and the day view is built on the time.
- Reassignment is allowed, including mid-visit: an engineer being swapped is a
  real operational event, and making it illegal only pushes it into a
  hand-edited row.
- Unallocation is allowed only *before* the visit. Once somebody is on site,
  removing them would leave a job in progress with nobody on it — it is
  reassigned instead, so somebody is named on it throughout.
- **Assignment is the whole permission.** An engineer who is not on a job has
  no more access to it than a stranger. Start and complete check the actor
  against the allocation, not the screen the request arrived from.
- Only one action is ever offered. A choice to get wrong at a front door is a
  choice that gets got wrong.

`lib/jobs/work-actions.ts` performs the writes, and every one of them:

1. **Takes nothing from the caller but an id** (and, for completion, a note).
   No status, price, ownership or timestamp arrives from a browser; the job is
   re-read and every decision made from the row. The clocks are the server's.
2. Checks the **capability** (`job:assign` is BSCJ's, `job:work` is the
   engineer's) *and* the **row** (`canAccessAssignedJob`). Both are required.
3. Calls `assertTransition` before writing, so an impossible status fails
   where it is attempted.
4. Updates **conditionally on the state that was read**, so concurrent
   attempts produce one change and one honest refusal.
5. Writes its own timeline entry. Never fatal — a gap in the timeline is a
   smaller problem than a refused change.

Nothing here contacts Google or Resend. Allocation and completion do not move
an appointment, so the calendar has nothing to learn, and no customer is
written to.

## 15.7 The engineer's surface

`/engineer` and `/engineer/jobs/[id]`, in their own route group with their own
layout and their own header. Built for a phone held at a front door: one
column, one card per job, the time and postcode readable at arm's length, and
the two things needed before knocking — the access note and a number to ring —
on the card rather than a tap away. The whole card is the tap target; the
phone numbers are their own `tel:` links because ringing ahead is a different
intention from opening the job.

The day steps forwards and backwards by date. A date that is not a date is
today — the parameter chooses which of the caller's *own* days to show, so
there is nothing to refuse.

**No money appears, and none is loaded.** The engineer role has neither
`pricing:read` nor `invoice:read`. `engineer-queries.ts` selects no price
column at all, which is stronger than omitting it from the markup: a value
that is never read cannot be leaked by a later change to what a page renders.
Two tests enforce it — one on the queries, one that rejects a `£` anywhere
under the route group.

`assignmentCondition()` was added to `scope.ts` as the mirror of
`organisationCondition()`: an engineer gets an equality on their own id, an
administrator gets no filter (they may work these screens), and **an agency
gets `false`** — matching nothing rather than everything. A test asserts the
two helpers never both return "no condition" for the same scope.

## 15.8 A local day is not twenty-four hours

`dayBoundsInZone()` in `booking/time.ts`, because the day view and the "today"
filter both need one. Twice a year in London a day is 23 or 25 hours, and a
boundary built on `+ 24 * 60 * 60 * 1000` loses or duplicates an hour of
appointments on exactly those two days. It is built from the wall clock, the
end is exclusive so consecutive days meet with no gap and no overlap, and it
**refuses a date that is not one**: `parseIsoDate` checks the shape rather
than the calendar, so "2026-02-30" passed it and rolled into March. The result
now has to round-trip back to the date it was asked for.

## 15.9 Verification

Gates: `npm test` **0** (1578 tests, up from 1490) · `typecheck` **0** ·
`lint` **0** (one pre-existing warning) · `build` **0**.

**Which server, and what was actually isolated.** This matters, and an
earlier draft of this section overstated it, so it is set out plainly.

The browser pass ran against the **development server already running on port
3000** — `next-server` PID 19000, started 17 September, before this phase.
`scripts/dev-with-fixtures.sh` could not be used: Next refuses a second `next
dev` in the same directory, and killing somebody else's process was not worth
doing. So **the in-process network interceptor from §12–13 was not loaded.**
Three pieces of evidence, not an assertion:

- The process environment carries no `BSCJ_TEST_FIXTURES=1`, without which
  `browser-fixtures.mjs` refuses to install itself.
- `/tmp/bscj-fixture-state.json` does not exist. The interceptor writes it on
  the first call it answers, so its absence means it answered none.
- `.next/dev/logs/next-development.log` contains no mention of Resend,
  Upstash or googleapis.

What was isolated was therefore **the data and the code paths**, not the
network:

- **Data** — `scripts/seed-operations-fixture.mjs`, dev only, refuses without
  `BSCJ_ALLOW_FIXTURE_SEED=1`, every row marked `FIXTURE` or on
  `@example.invalid`, `--clean` removes exactly what it wrote. Seven jobs
  across both client kinds and six lifecycle states, its own admin and
  engineer accounts, and no existing account touched.
- **Code paths** — an import-closure walk from the seven verified entry
  points reaches **51 modules, exactly one of which contains an
  external-service call site**: `sendOutboxEmail` in `lib/email/send.ts`.
  That function is called only from `deliverInvitation`,
  `deliverConfirmation` and `deliverLateBooking`; those only from
  `deliverRow`; and that only from `drainOutbox`, which runs from the
  reconciliation sweep and the cron route. **Neither was opened or called.**
  The three functions this phase does use from `outbox.ts` —
  `readOutboxSummary`, `fetchNotificationStates`, `fetchRecordedException` —
  are plain Postgres reads. Google and Upstash are not reachable from these
  screens at all.

So no real email was sent and no real Google or Upstash call was made, but
that is because **nothing on these screens can make one**, not because a stub
caught it. A future phase that touches the booking flow, the outbox worker or
reconciliation must use the fixtures server, and will need the stale dev
server on port 3000 stopped first.

| Check | Result |
|---|---|
| Dashboard totals | 7 jobs · 3 private / 4 agency · 6 open · 3 today · 3 unallocated · 2 attention — each figure matched the list it links to |
| Totals add up on screen | all 7 = private 3 + agency 4; open 6 = 2 + 4; 6 open + 1 done + 0 cancelled = 7; the stage breakdown sums to the 6 open |
| Message counts | 1 given up on, 1 with no address configured, named separately |
| Search `WV3` | 2 of 7, matching on postcode |
| View `attention` | exactly the two flagged jobs, with their reasons as chips |
| Filters combined (`today` + `private` + `nobody yet`) | 1 of 7 |
| Pagination `size=3` | page 2 correct; `page=99` clamped to the last page, not an empty screen |
| Allocate an engineer | status → Allocated, timeline entry naming the administrator, unallocate control appeared |
| Engineer's day (phone width, 375×812) | 3 jobs in time order, access notes and tap-to-call, **no price anywhere** |
| Engineer → `/admin`, `/admin/jobs` | 307 to `/admin/login` |
| Engineer → `/portal` | 307 to `/portal/login` |
| Engineer → a job not theirs | **404**, identical to a job that does not exist |
| "I'm on site" | status → On site, `work_started_at` set, timeline entry |
| "Work is done" + note | status → Done, note stored and shown to both audiences, timeline entry |
| Admin view after completion | full history: recorded → allocated → on site → done, each with its actor |

**Concurrency, deliberately raced.** Five simultaneous `completeWork` calls on
one job: **one** succeeded, four were refused, and the row carried exactly one
completion, one note and **one** `job.completed` timeline entry. A second
engineer's id against the same job got the generic "could not be found".

Development database returned to **1 app_user, 0 business rows**. Four
`audit_event` rows from the verification remain: the log is append-only by
design, they name only a fixture reference and a fixture actor, and deleting
from a security log to tidy up would be the wrong precedent.

## 15.10 What this phase did not do

- **Remedials** (§14.4). The stored authority exists on the organisation and
  the job; the approval flow does not, and `remedial_awaiting_approval` is
  read as an attention signal but nothing yet writes it from a screen.
- **Cancellation from a screen.** The lifecycle allows it from every unfinished
  status and no interface offers it. It is the obvious next small thing.
- Nothing in §13.6 is closed. No real email has been sent, no real Google
  Calendar call has been made, automatic processing is still not active, and
  `robots.txt` still allows `/` while `/admin` — and now `/engineer` — rely on
  metadata alone.

One cosmetic thing noticed and **not** changed, because it predates this phase
and is outside the brief: pages directly under `/admin` render the browser tab
title as "… | BSCJ Gas & Heating" rather than the admin layout's "… | BSCJ
Admin". Nested pages such as `/admin/login` and `/admin/jobs` are correct. It
affects a tab title on a `noindex` page only.

## 15.11 Closeout

The phase was committed after a diff review. Two things came out of it.

**The overall job total was computed and never rendered.** `jobTotals`
returned `all` from the first commit of this page and the dashboard showed
only the breakdown — the number being broken down was not on screen. Added
with the split, where it can be checked by addition, and a test now asserts
it is rendered.

**§15.9's isolation claim was corrected.** It originally read "browser,
isolated fixtures", which in §12–13 means the in-process network stub. That
stub was not loaded for this phase. The section now says which server ran,
proves the stub was absent, and substantiates what was actually isolated.

Local launch configuration was excluded from the commit. The four
`audit_event` rows from verification were left in place: the log is
append-only by design.

Deliberately **not** in this closeout, and still open: cancellation from a
screen, and the remedial approval flow.

---

# 16. CP12 generator — integration baseline (no bridge yet)

**Preparation only.** No bridge is implemented, no database change, no
service call, and the original generator was treated as read-only throughout:
nothing in `~/Gas Cert Generator/` was edited, moved or deleted, and it
remains the tool BSCJ actually uses.

## 16.1 What was copied

`vendor/cp12-generator/` — three files, which is the whole application:

| File | State |
|---|---|
| `index.html` | Copied from the 1,048-line original, then sanitised (§16.2) |
| `lib/html2canvas.min.js` | Byte-identical, `e87e5507…`, 1.4.1 MIT |
| `lib/jspdf.umd.min.js` | Byte-identical, `98ccf17a…` |

`index.html` references nothing else — every `src` and `href` in it was read
— so nothing else was copied. The directory was **not** bulk-copied.

Deliberately left behind: `GAS CERTS/Certificates/` (six months of issued
certificates for real properties), `GAS CERTS/TEMPLATES/` (five PDFs the
generator never opens, four of them pre-branded for two named agencies),
`.tools/` and `.claude/`. There are no saved drafts in any file — the draft
lives in `localStorage` on whichever machine typed it.

## 16.2 What was found, and what was done about it

The inspection found five kinds of embedded data. All are removals; each is
commented in place.

| Found | Action |
|---|---|
| Engineer's **personal name**, seeded in `defaultEngineer()` | Emptied — comes from configuration |
| **Gas Safe registration** and **ID card number**, both real, in source | Emptied — the registration belongs in `business.identity`. Neither value is restated here |
| Company **trading name, address, postcode, telephone** | Emptied — `business_setting`, because the entity is expected to change |
| **Two real letting agencies** with addresses and phone numbers, seeded in `defaultLandlords()` | Dropped entirely — third-party records |
| Those agencies again in `landlordFolderName()` (4 shortcuts) and 3 form placeholders | Removed; the generic branches already do the same job |

**Kept:** the Gas Safe Register mark, a 5 KB embedded JPEG. A third-party
trade mark rather than private data, and one a record from a registered
engineer legitimately carries.

No credential, API key or token was found anywhere in the generator — it has
no network access at all.

## 16.3 Verification

Served locally over `127.0.0.1:8931` (a plain static server, stopped
afterwards) because a `file://` page cannot load its own `lib/`:

| Check | Result |
|---|---|
| Page opens | Title "Gas Safety Record Generator", **no console errors** |
| `jspdf` / `html2canvas` | Both loaded — `object` and `function` |
| Sheet controls | **157** — 31 static plus 6 × 21 appliance cells |
| Appliance table | 22 columns rendered (21 data + row number) |
| Engineer seed | **empty** — sanitisation effective |
| Landlord book | **0 entries** — the two agencies are gone |
| Draft round-trip | `saveDraft()` produced a flat 157-key `{id: string\|boolean}` map |
| Renewal arithmetic | signature 19/09/2026 → next **18/09/2027**, i.e. `+1 year − 1 day`, matching `compliance/renewal.ts` exactly |

`vendor/**` was added to the ESLint ignores: the value of this copy is that
it still matches its original, and linting it would invite reformatting.

## 16.4 The mapping

`docs/CP12_PREFILL_MAPPING.md`. In summary: the bridge fills **at most 13 of
the 31 static fields** and never one of the 126 appliance cells.

Sent — property (address, postcode, occupier name and phone), landlord or
agency (name, company, phone, and postcode for agency work), and the
engineer and business block from `business.identity`.

**Not** sent, each for a stated reason: `sigDate` (the engineer confirms the
inspection date on the day), `nextInspection` (derived from a date that is
not yet real; sending it would activate a renewal calculation and duplicate
an implementation), `certNo` (no numbering scheme exists and none may be
invented), every appliance cell, the six pass/fail checks, `defects`,
`labelsIssued`, `comments` and both signature names. `accessNotes` is also
withheld — it is guidance for getting in, not something for a document a
landlord keeps for two years.

**One hazard named for BSCJ, not acted on.** "New Certificate" ticks all six
safety checks *satisfactory* by default, and pre-ticks them in the markup.
That is a pass assertion nobody has made. The bridge does not touch them, so
it does not worsen it, but it does put the sheet in front of an engineer more
often. Whether those defaults should start unticked is BSCJ's decision — it
changes what a half-completed record claims — and it was left alone.

## 16.5 Transport, proposed and not built

A **download**, authorised server-side, with nothing in the URL:
`GET /api/engineer/jobs/<id>/cp12-prefill`, guarded by
`requireEngineerOrThrow()` and then `canAccessAssignedJob()` against the row,
returning the flat id map as an attachment with `Cache-Control: no-store`.
The job id is an opaque UUID in the path; no name, address or postcode
appears in any URL, and a booking reference authorises nothing.

The generator gains one *Import job details* file picker that applies the
file through `loadDraft()`'s path **behind an allow-list of the mapped ids** —
so an edited file naming `chkTightness`, `sigDate` or an appliance cell has
those keys ignored. The allow-list is the enforcement; a correct server
response is not enough, because a file on disk can be changed. One-way:
uploading the finished PDF is the next slice.

Rejected: a query string (address and phone in history, referrers and logs),
clipboard paste (unauthorisable, and it lingers in the clipboard), and
`postMessage` (right after the port, wrong while the generator is a local
file).

## 16.6 Missing inputs, carried forward

- `business.identity` is **empty**, so six installer fields arrive blank
  until BSCJ supplies them. The engineer types them once and saves them as
  defaults, exactly as today.
- The engineer's **Gas Safe ID card number** is stored nowhere;
  `app_user` has no column for it. `instIdCard` cannot be prefilled.
- **No customer address is stored** — `customers` holds name, company, email
  and phone only — so `landlordAddress` cannot be prefilled, and
  `landlordPostcode` only for agency work.
- **No certificate numbering decision.** `certNo` stays manual.
- **The original is still untracked**, on one machine. Until it is in version
  control the tool BSCJ uses and this baseline can drift apart. This remains
  the blocker recorded in `V2_CURRENT_STATE.md`.

Nothing in §13.6 is closed by this phase.

---

# 17. V2.5 — the CP12 job-prefill bridge

**Uncommitted, for review.** On `v2-compliance-platform` at `2fa51a2`. Nothing
pushed or deployed, no migration, no external-service call, no upload or
storage of any certificate, no invoice and no email.

The contract is §16 and `docs/CP12_PREFILL_MAPPING.md`, which was written
first and is now marked implemented.

## 17.1 The download

`GET /api/engineer/jobs/<id>/cp12-prefill`, reached from a *Download CP12 job
details* control on the engineer's own job screen.

- **Authorised twice, neither time by a reference.** `requireEngineerOrThrow()`
  for the audience, then the read is scoped by `assignmentCondition`, so an
  out-of-scope row is never loaded rather than loaded and then rejected. A
  booking reference is not accepted as an identifier at all.
- **Nothing private in the URL.** The path carries a job UUID and there is no
  query string. No name, address or postcode reaches browser history, a
  referrer or a proxy log.
- **An attachment**, `Cache-Control: no-store, max-age=0`,
  `X-Content-Type-Options: nosniff`, filename `<reference>-cp12-details.json`
  — the reference only, never a name or a postcode in something that will sit
  in a downloads folder.
- **Audited.** Who took it, which job, how many fields — never the contents.
  A file of customer details leaving the application is worth accounting for.
- It is otherwise a pure read: no job is written, nothing is sent.

The payload is a flat `{elementId: value}` map — the generator's own draft
format, so there is no new schema — restricted to the allow-list, plus a
`missing` list naming what the engineer still has to type and **why**.

## 17.2 The importer

*Import job details* in the generator's toolbar. It validates kind, version,
shape and reference, then applies **only allow-listed ids**.

The loop iterates the allow-list rather than the file's keys. That direction
is the point: looping over the file and skipping unknown keys is one
forgotten check away from applying everything, whereas looping over the list
cannot reach a field that is not on it. The server sending a correct payload
is not the defence — a file on disk can be edited.

An absent value is **omitted rather than sent as an empty string**, so an
import never clears a box the engineer filled from their own saved defaults.

**Two jobs are never combined.** If the sheet already carries inspection work
— any appliance cell, any outcome, defects, labels, comments, either
signature name, or a certificate number — the importer names the incoming job
and its property and asks. Confirming **starts a fresh certificate and then
imports**; declining leaves the sheet untouched. The guard deliberately looks
only at findings, not at prefilled boxes, so re-importing the same job onto a
sheet that has only ever been prefilled is not obstructed.

The result panel is `aria-live`, says how many fields were filled and for
which job, lists what still needs manual entry, and reports how many
unrecognised fields were ignored.

## 17.3 Safety outcomes: the pre-ticked pass is gone

The hazard named in §16.4, now fixed in the baseline.

The six checks were checkboxes, pre-ticked *satisfactory* in the markup and
re-ticked by "New Certificate". A half-finished record asserted six passes
nobody had made. They are now explicit outcomes:

**Not assessed** (the start) · **Satisfactory** · **Not satisfactory** ·
**Not applicable**

- **New drafts start unassessed.** Not assessed is amber and italic, not
  satisfactory is red — an outstanding outcome reads as outstanding rather
  than as an empty box somebody already dealt with.
- **Final PDF export is refused** until every one has been chosen, naming
  the ones outstanding and focusing the first.
- **Incomplete drafts still save.** `saveDraft()` runs first in
  `downloadPdf()`, before any check — an engineer halfway through, in a cold
  hallway, must never lose work to a gate.
- **No criterion is invented.** It checks only that a choice was made, never
  what the choice should be. *Not applicable* exists for the cases where the
  question does not arise, using the same vocabulary the appliance table
  already uses (Yes / No / N/A).
- **The certificate looks the same.** The printed sheet still shows a tick:
  the outcome carries a `data-print` mark and the capture path renders that,
  not the select's value. Nothing about the layout changed.
- **Historical documents are untouched.** Issued certificates are PDFs on
  disk. For a *draft* saved before this change, a legacy `true` — the shipped
  default, which says only that nobody changed it — becomes *Not assessed*
  rather than a pass nobody made; a legacy `false` was a deliberate untick
  and is kept as *Not satisfactory*.
- **The external original is untouched**, as throughout.

## 17.4 What stays manual, and what is still not invented

Editable by hand and never filled by the bridge: the certificate number, the
inspection date, the landlord's address, the Gas Safe ID card number, and any
installer field the business settings do not hold. Each appears in the
`missing` list with the reason, so a blank box is a known gap rather than a
bug to report.

- **No renewal rule is activated.** `nextInspection` is not sent and
  `cp12-prefill.ts` does not import `compliance/renewal.ts` — asserted by a
  test. The generator still derives it from the date the engineer confirms.
- **No certificate numbering is invented.** None exists to draw on.
- **An agency address is never passed off as a landlord's.** What is stored
  is the agency's *billing* postcode; it fills `landlordPostcode` on agency
  work only, and there is no `landlordAddress` key at all, so nothing can
  fill one.

## 17.5 Verification

Gates: `npm test` **0** (1615 tests, up from 1584) · `typecheck` **0** ·
`lint` **0** · `build` **0**.

**HTTP, against the development server with fixture rows:**

| Check | Result |
|---|---|
| Engineer, own in-progress job | **200**, attachment, `no-store`, `BSCJ-OP0003-cp12-details.json` |
| Payload contents | 8 fields; no date, no number, no reading, no outcome, no signature |
| `missing` list | 9 entries, each with a reason |
| No session | **401** |
| Engineer, job not theirs | **404** |
| Engineer, job does not exist | **404**, byte-identical body |
| Engineer, id that is not a UUID | **404** |
| Administrator | **200** — they may work the engineer screens |
| Cross-origin `fetch` with cookies | blocked by CORS; the endpoint is not readable from another origin |
| Audit | one row per download, naming who and which job, never the contents |

**Browser, the generator served locally:**

| Check | Result |
|---|---|
| Fresh load | all six outcomes *Not assessed*, amber |
| Export with outcomes unassessed | refused, all six named, **draft saved** with the half-finished note intact |
| Valid import | 8 fields applied; outcomes, appliance table, defects, comments, signatures, `certNo` all untouched |
| Tampered file (11 extra keys: outcomes, `certNo`, `sigDate`, `nextInspection`, defects, signature, appliance cells) | **all 11 ignored**, legitimate fields still applied, report said "11 unrecognised fields … ignored" |
| Not JSON · an array · wrong kind · wrong version · no `fields` · no reference · only forbidden keys | **7 of 7 refused**, each with its own message, sheet left empty |
| Import over existing findings, declined | prompt named the incoming job; sheet left exactly as it was |
| Import over existing findings, accepted | fresh certificate then import — job A's defects, outcomes, company and phone all gone, only job B present. **No merge** |
| All six assessed → export | proceeded and produced the PDF |
| Printed marks | `✔ ✔ ✔ ✔ ✔ N/A` — the certificate's appearance is unchanged |

**Engineer job screen** verified at tablet width (768×1024) and desktop: the
two numbered steps, the download button and the instructions read clearly,
and the instructions name the file to open and say no setup is needed.

Development database returned to **1 app_user, 0 business rows**. Six
`audit_event` rows remain, two of them from this phase's downloads; the log
is append-only by design.

## 17.6 Limitations

- **The generator is still opened by hand** from `vendor/cp12-generator/index.html`,
  and the file is moved by the engineer. That is step A by design; the port
  (step B) removes both.
- **Opened as a `file://` page, the vendored libraries do not load** — a
  browser will not fetch `lib/` from a file origin. Verification used a local
  static server. **This needs confirming on the engineer's actual machine**,
  where the original works because it is opened the same way; if it does not,
  the fix is to open it from a folder the browser will serve, or to bring the
  port forward.
- **Nothing is uploaded.** The finished PDF is saved by the engineer exactly
  as today; it is not stored against the job and not exposed to the agent.
- **Six of fourteen mapped fields are blank** until `business.identity` is
  filled in, and two more (`landlordAddress`, `instIdCard`) need schema
  changes that are out of scope.
- **The downloaded file is customer data at rest** in a downloads folder. The
  screen says to delete it; nothing enforces that, and a retention decision
  is still outstanding alongside the Redis one in §13.6.
- **`window.print()` is not gated**, only the PDF export. Printing a working
  copy mid-visit is legitimate, but a printed draft can carry unassessed
  outcomes. Worth a decision.
- Nothing in §13.6 is closed.

---

# 18. V2.5.1 — four corrections, and the bridge is finished

Four things in §17 were wrong or half-done. Each is corrected below. The
download/import bridge is retained as it is; **upload-back is still not
built**.

## 18.1 The generator opens from the job, not from a file path

§17.6 admitted the engineer had to find `index.html` on disk, and that a
`file://` page cannot load its own `lib/`. Both are gone.

`/engineer/certificate` serves the generator from a route handler, behind
`requireEngineerOrThrow()` — the same guard as every other engineer surface.
The job screen links to it, opening in a new tab so the job stays put. No
paths, no static server, no setup.

- **Not in `public/`.** Anything there is served to whoever knows the path.
- **Three files, named in a lookup table.** The handler does not join a
  request path onto a directory, so there is nothing to traverse — verified
  with `..`-style and unknown-file requests, all **404**.
- **`private` on every response**, so no proxy or CDN holds a staff URL. The
  page itself is additionally `no-store`; the two libraries are
  `private, max-age=3600, must-revalidate`, because 550 KB matters on a van's
  connection and they never change.
- **`outputFileTracingIncludes`** in `next.config.ts` carries the three files
  into the deployment. Nothing imports them, so the bundler cannot infer it,
  and the failure mode without it is a 500 in production only.

One change to the vendored file was needed: a `<base href="/engineer/certificate/">`,
because the route has no trailing slash and the two relative `src` attributes
would otherwise resolve a directory too high. **This was caught in the
browser, not in a test** — the libraries silently did not load and the page
looked fine until the PDF engine was needed. The script tags themselves are
untouched.

## 18.2 The party mapping is the party, not the agency

The correction that mattered most. `landlordCompany` used to fall back to the
agency's name, and `landlordPostcode` came from the agency's **billing**
postcode. Both are now gone:

- `landlordCompany` ← `customer.company` **only**.
- `landlordPostcode` ← removed from the allow-list entirely. We do not hold
  the customer's, and a finance address is not it.
- **`Cp12PrefillFacts` no longer carries an agency at all**, so no later edit
  can reach for one when a customer field is empty. That is a stronger
  guarantee than a rule in a comment.

Both address lines are reported in `missing`, each saying *why* — including
that an agency's address is not a substitute. The allow-list is now **13**
fields.

A focused test covers it: an agency job fills only the recorded customer,
neither address key exists, and the facts type is asserted to contain no
`organisation`, `billingPostcode` or `agentOrganisation`.

## 18.3 No finding is inferred from a legacy checkbox

§17.3 read a legacy `false` as *Not satisfactory*. That was an inference from
a control that could not express what it meant: under two states, an untick
could have been "not satisfactory", "not applicable" or "not done yet".

Now **both `true` and `false` become *Not assessed*** and the engineer
reassesses. Nothing is discarded:

- The pre-migration draft is kept verbatim under
  `gascert_draft_pre_outcomes_v1`.
- A notice lists each check and **what was stored** — "was stored as ticked"
  — without translating it into a finding.
- Everything else in the draft (address, defects, comments, certificate
  number) loads normally.

**"Not applicable" was also too widely offered.** It was added to all six
because the appliance table uses Yes/No/N/A — which is not a reason. It is
now on **`coTested` only**: the check above it records whether an alarm is
fitted, and where none is there is nothing to test. That is read off the
form's own structure. The other five — alarm fitted, emergency control,
tightness, pipework, bonding — offer **Not assessed / Satisfactory / Not
satisfactory**, and are applicable to any installation being certificated.
It is one line to remove if BSCJ reads `coTested` differently.

## 18.4 Incomplete working copies say so

- **Unassessed prints as `NOT ASSESSED` in red**, not as a blank. A blank in
  a tick column reads as a box somebody dealt with.
- **A `DRAFT — INCOMPLETE · NOT A VALID GAS SAFETY RECORD` banner** sits
  inside the sheet, so it is part of anything the sheet becomes — a print, a
  print-to-PDF, a screenshot. It is driven by the outcomes rather than by the
  print button, so it is already correct whatever route is taken out.
- **Incomplete drafts still save**, unconditionally and before any check.
- **Final PDF export is still gated.**

**Browser printing cannot be prevented, and nothing here claims it can.**
Ctrl+P, the operating system's print-to-PDF and a screenshot are all outside
this page's reach. What is possible is to make an incomplete copy declare
itself, and that is what this does. The print button now says so in the
status line rather than pretending to gate anything.

## 18.5 Verification

Gates: `npm test` **0** (1624 tests) · `typecheck` **0** · `lint` **0** ·
`build` **0**.

**The journey, from the engineer's job screen:**

| Step | Result |
|---|---|
| Job screen → *Download CP12 job details* | attachment, `no-store`, 7 fields for the agency job |
| Job screen → *Open the certificate generator* | `/engineer/certificate`, **both libraries loaded**, no page errors |
| Import the downloaded file | 7 fields applied; report named both address lines and why |
| Partly assessed | banner on screen **and in the print clone**; marks `✔ NOT ASSESSED ✔ ✗ NOT ASSESSED NOT ASSESSED` |
| Export while partly assessed | refused, three outcomes named, draft kept with its note |
| All six assessed | banner cleared, export ran, PDF saved |

**Access:**

| Check | Result |
|---|---|
| `/engineer/certificate`, no session | **307** to `/admin/login` |
| `…/lib/jspdf.umd.min.js`, no session | **307** |
| Both, signed in as engineer | **200** |
| `…/lib/../../../.env.local` (unencoded) | **404** |
| `…/README.md`, `…/index.html`, `…/lib/evil.js` | **404** each |
| Page `Cache-Control` | `private, no-store, max-age=0` |
| Library `Cache-Control` | `private, max-age=3600, must-revalidate` |

**Party mapping, against an agency job whose agency had a billing postcode
of `WV6 0RY`:** neither `WV6 0RY` nor the agency's name appeared anywhere in
the payload or on the sheet. `landlordCompany` was left empty rather than
filled from the agency.

**Legacy draft**, seeded with five `true` and one `false`: all six loaded as
*Not assessed*, the original draft was kept verbatim under its own key, the
notice listed what each had been stored as, and the address, defects,
comments and certificate number all survived.

One thing worth recording because it cost time: **the first export attempt
hung**. It was the File System Access directory picker — original, untouched
code — waiting for a human to choose a folder, which an automated browser
cannot do. With the picker unavailable the generator takes its documented
fallback and saves to Downloads, which completed in under ten seconds. Not a
defect, and not something this phase touched.

Development database returned to **1 app_user, 0 business rows**; eight
`audit_event` rows remain, the log being append-only.

## 18.6 Remaining limitations

- **No upload-back.** The finished PDF is still saved by the engineer. It is
  not stored against the job and not exposed to the agent. Deliberate.
- **The import is still a file the engineer moves.** Retained on purpose;
  `postMessage` becomes the right answer only once the generator is a page
  of the application rather than a served document, which is step B.
- **Five of thirteen mapped fields are blank** until `business.identity` is
  filled in; `landlordAddress`, `landlordPostcode` and `instIdCard` need
  schema changes that remain out of scope.
- **Printing is not preventable**, only marked. A completed certificate can
  also be printed before it is exported, and that print carries no banner —
  correctly, because it is complete.
- **The `coTested` "Not applicable" is a reading of the form**, not a quoted
  specification. Flagged for BSCJ to confirm or remove.
- **The original generator is still untracked** on one machine. Now that the
  application serves its own copy, the two can drift without anyone noticing
  — this is more pressing than it was, not less.
- Nothing in §13.6 is closed.

---

# 19. V2.6 — certificate upload, review and release

> **Superseded in part by §20 (in progress).** §19 describes the workflow as
> first built: fixture-only storage and an email that carried no document.
> §20 replaces the storage adapter and the email, and records what is
> actually activated. Where the two disagree, §20 is current.
>
> §20 stages, in order, each updated here as it completes:
> **(a)** the real Blob adapter and failed-upload cleanup ·
> **(b)** attachments, frozen recipients and eligibility re-checks ·
> **(c)** the journey and its states · **(d)** verification.

**Uncommitted, for review.** On `v2-compliance-platform` at `443a1b1`. No
migration, no database altered beyond the fixture rows this phase created
and removed, no real email, nothing pushed or deployed.

## 19.1 No migration was needed

The existing model already carried it. `document` has the blob key, the
filename, the size, the uploader and the `sent_at` / `sent_to` pair;
`certificate` has the number, the version, `supersedes_id`, the status, both
dates and `correction_reason`.

**Release is modelled as the existence of a `certificate` row**, not as a
flag on the document. A document with no certificate is uploaded and unread;
one with a certificate is released. That falls out of the schema rather than
being bolted onto it, and it makes "only released certificates appear in the
agency's view" a join rather than a condition somebody has to remember.

## 19.2 The four acts

Separate on purpose. Collapsing any two would mean a document reaching a
customer because a file finished uploading.

1. **Upload** — the assigned engineer, or an administrator. The bytes are
   checked, stored, and only then recorded.
2. **Review** — an administrator opens the PDF. The release form will not
   submit until they have; not a guarantee, but a form completable without
   the document ever being opened invites exactly that.
3. **Release** — the number and both dates are typed, and a `certificate`
   row is written. This is the moment the agency can see it.
4. **Send** — only if somebody chooses to, to recipients they pick from a
   list showing the actual addresses.

## 19.3 What is enforced, and where

Every check is server-side, re-derived from the row:

| Act | Capability | Row check |
|---|---|---|
| Upload | `certificate:issue` | `canAccessAssignedJob` — the engineer on the job, or an admin. Job must be `in_progress`, `remedial_required` or `completed` |
| Preview / download | signed in at all | Decided in `readDocumentFor` from the row |
| Release | `certificate:issue` **and** an unfiltered scope | An agency can never release |
| Email | `message:write` **and** an unfiltered scope | Recipients validated against a closed list |

`readDocumentFor` is the only way bytes are read. Staff see everything; the
assigned engineer sees their own job's, released or not; an agency sees its
own organisation's **and only once released**. Everything else is the same
404 — distinguishing "not yours" from "not there" turns an id into a probe.

**A tenant scheduling session grants nothing here.** It is a token for
choosing an appointment, it has never been an identity, and the download
route does not recognise it. The tenant is also absent from the recipient
list: whether they are entitled to a compliance document is a decision
nobody has made.

## 19.4 Storage

`lib/storage/documents.ts`, driver-based. Keys are random and opaque —
`doc_` plus 24 random bytes — encoding nothing about the job, because keys
end up in log lines. A key from anywhere else is rejected by shape before it
reaches a filesystem call.

**Bytes are stored before any row is written.** A storage failure leaves the
database untouched and the engineer is told nothing was saved, which is
true. The reverse — an orphaned blob when the insert fails — is unreferenced
and harmless, and is far better than a record pointing at a document that
does not exist.

**The `local` driver is implemented; `vercel-blob` is not.** Exact
activation requirement, as reported by `storageStatus()`:

> The Vercel Blob driver is not implemented. It needs the `@vercel/blob`
> package added, an adapter written against `putDocument`/`getDocument`, and
> `BLOB_READ_WRITE_TOKEN` issued with **private** access.

Until then, every screen that would offer an upload says so and tells the
engineer to send the PDF the way they do now. The local driver refuses to
load in production, because a serverless filesystem is ephemeral and a
certificate that vanishes on the next deploy is worse than one never stored.

## 19.5 Nothing is invented, and nothing is overwritten

- **The certificate number is typed.** No numbering scheme exists.
- **Both dates are typed.** `compliance/renewal.ts` holds a confirmed rule
  and this phase deliberately does not apply it — the date on the record is
  the one a person read off the PDF. A test asserts the release module
  cannot reach the renewal code.
- **Six assessed outcomes and a generated PDF are not a review.** Nothing
  treats an upload as an approval.
- **An issued certificate is never overwritten.** Releasing over one writes
  a new version with a required reason, marks the previous `superseded`, and
  keeps both rows and both documents. The supersede and the insert go in one
  batch, so there is never a job with two current certificates or none.
- Releasing the same document twice is refused; queueing the same version to
  the same recipient twice is refused by the unique key.

## 19.6 Email

A new outbox kind, `certificate-release`, keyed on **the certificate version
and the recipient** — so a correction is a fresh intent and a double click
is not. It uses the existing worker: claiming, leases, bounded retries.

The queue carries a **role**, never an address. The administrator sees the
resolved address before sending; the worker resolves it again at send time
and records what it actually used in `document.sent_to`, appended so a
second recipient does not erase the first, and only on acceptance.

**The PDF is not attached.** A forwarded message carries a document about
somebody's property to whoever it is forwarded to. The email states the
facts already on the record and points the agency at their own account.

At send time the worker re-checks that the version is still current, that
the document still exists, and that an address resolves. A missing address
is also refused *before* anything is queued, so a row that can only ever
fail is never created.

## 19.7 Verification

Gates: `npm test` **0** (1661 tests, up from 1625) · `typecheck` **0** ·
`lint` **0** · `build` **0**.

**Isolated environment.** A copy of the working tree in the scratchpad, its
own Next instance on port 3200, `scripts/browser-fixtures.mjs` intercepting
Google, Upstash and Resend in-process, and `BSCJ_DOCUMENT_STORE=local`
pointing at a scratch directory. No real service was contacted and no real
email was sent — the messages below were counted at the stub.

| Check | Result |
|---|---|
| Upload a JPEG named `.pdf` | refused: "That is not a PDF" |
| Upload a truncated PDF | refused: "looks incomplete" |
| Upload a valid PDF | stored `0600` under an opaque key; row records filename, 5000 bytes, `application/pdf` |
| Upload as an **administrator** | accepted — the second, corrected document |
| Document before release — no session | **401** |
| — engineer on the job | **200** |
| — administrator | **200** |
| — **owning agency** | **404** (not released) |
| — **rival agency** | **404** |
| — unknown id, non-UUID | **404**, identical body |
| Agency job page before release | "No certificate has been issued" — no filename, no link in the HTML |
| Review form before the PDF is opened | submit disabled |
| Release with a future inspection date and a due date before it | both refused by name |
| Release with valid details | version 1 issued, timeline and audit written |
| Document after release — owning agency | **200**; rival still **404**; rival's job page **404** |
| Agency job page after release | number, both dates, working download |
| Correction without a reason | refused |
| Correction with a reason | v1 → `superseded`, v2 `issued` with `supersedes_id`, **both documents kept** |
| Email with nothing selected | refused |
| Email to both, addresses shown first | 2 rows queued, no address in either |
| Queue the same version again | "Already queued for this version" |
| Drain | 2 accepted; `document.sent_to` recorded both addresses; **no attachment** at the stub |
| Address missing at send | `missingRecipient`, row stays `pending`, error `customer_email_missing` |
| Address restored, lease expired, drain again | **sent**, attempts 1 → 2, record intact |
| Storage absent (the other dev server) | upload control not rendered; the exact activation requirement shown |
| Admin review screen at tablet width | readable; addresses, versions and both documents legible |

Development database returned to **1 app_user, 0 business rows, 0 documents,
0 certificates**. The `audit_event` log is append-only and now holds 21 rows
from this and earlier phases' verification.

## 19.8 The `coTested` "Not applicable" is gone

It was inferred from the form's layout, never approved, and it has been
removed — all six checks now offer **Not assessed / Satisfactory / Not
satisfactory** only. A draft that recorded `na` during the one build where
it existed is not reinterpreted: the value is kept for the notice and the
outcome returns to *Not assessed*.

**The unresolved business decision, recorded rather than settled:** what
should an engineer record against *"CO Alarm(s) tested and satisfactory"*
when no alarm is fitted? Today the honest answer is *Not satisfactory*,
which may overstate a fault, or leaving it unassessed, which blocks export.
BSCJ needs to say. It is one line in the generator either way.

## 19.9 Limitations

- **Production storage is not available.** The Blob driver is the one piece
  of this phase that cannot be used live; §19.4 names exactly what it needs.
  Everything else is verified against fixtures.
- **No retention or deletion.** A stored document is kept indefinitely and
  nothing removes one. A superseded certificate's PDF stays readable to
  staff and to the agency.
- **No upload-back from the generator.** The engineer still saves the PDF
  and chooses it — the bridge is unchanged.
- **`sent` means the provider accepted it.** No webhooks, no bounce
  handling; unchanged from §13.6.
- **An agency with no account cannot read its certificate**, and a customer
  never can — the email tells them to ask. A customer-facing document link
  would need a token, which this phase deliberately does not introduce.
- **Storage failure mid-upload can orphan a blob.** Unreferenced and
  harmless, but nothing sweeps them.
- Nothing in §13.6 is closed.

---

# 20. V2.7 — production storage and useful certificate emails

**In progress. Uncommitted.** Stages are recorded here as they complete.

## 20.a Private Blob storage — **done**

`@vercel/blob` **2.8.0** added as a dependency, and the adapter written in
`src/lib/storage/blob.ts` against the SDK's own types.

- **`access: "private"` on every call, and it is not a variable.** There is
  no option, no environment variable and no fallback that makes a
  certificate public. If private access were ever unavailable the upload
  fails; it does not quietly become public.
- **The authorisation boundary is unchanged.** `/api/documents/[id]` still
  re-derives the caller's permission from the row and streams the bytes.
  The blob URL never leaves the server and is never rendered.
- Reads use `useCache: false` — a stale read after a correction would hand
  somebody the wrong version of a safety record.
- Everything lives under one `certificates/` prefix; `allowOverwrite` is
  false, so a collision fails rather than destroying a certificate.

**Failed-upload cleanup.** When the bytes are stored and the row then fails
to write, the object is removed. Bounded by construction rather than by a
limit: `deleteDocument` takes **one key**, never a prefix or a list; the key
must match the shape this module mints; and the caller passes the key it
minted seconds earlier in the same request, which no row references and
which cannot be a released certificate. If the removal also fails, the key
is written to the audit log as `document.orphaned` for removal by hand.

**There is deliberately no sweep.** A sweep would decide "unreferenced" from
a database read, and a read that failed or came back partial would delete
issued certificates. An orphaned object costs a fraction of a penny; a
deleted safety record cannot be recovered.

**Configuration now has three states, not two:**

| State | Meaning | What it takes |
|---|---|---|
| `ready` | Storage works | — |
| Blob driver, **no credentials** | *Adapter implemented*, one setting away | Create a Blob store on the Vercel project so `BLOB_READ_WRITE_TOKEN` is injected. **No code change.** |
| `none` | No driver selected | `BSCJ_DOCUMENT_STORE=local` + `BSCJ_DOCUMENT_DIR` for development, or attach a Blob store |

`isDriverImplemented()` exposes the distinction so a screen can say "this
needs a setting" rather than "this needs a release".

**Activation, exactly:** create a Blob store in the Vercel project and
attach it to this project. Vercel injects `BLOB_READ_WRITE_TOKEN`; the
driver is then selected automatically and `storageStatus().ready` becomes
true. Nothing else changes. **No store was provisioned and nothing was
purchased.**

## 20.b Useful emails — **done**

**The exact released PDF is attached.** Fetched from private storage at send
time and sent through the existing Resend transport, so a recipient with no
portal account gets the document without needing one. The agency still gets
its portal link as well.

**Migration 0005** adds `outbound_email.recipient_address`, nullable. It is
the one thing that genuinely could not be done without a schema change.

- **The approved address is frozen when the row is queued.** It is the
  address the administrator had on screen when they ticked the box. The
  worker sends to that and does not re-resolve, so an edit to the agency's
  or customer's record in between cannot silently redirect an approved
  document. Rows queued before the column existed fall back to resolving,
  which is the behaviour they were queued under.
- **The certificate version is frozen by the key** — it carries the
  certificate id, and a correction is a different id and therefore a
  different intent.
- **Eligibility is re-checked at send time**, which is a different question
  from *where* to send: an agency removed from the job or deactivated, a
  deactivated customer, or an address that has since changed all stop the
  send. A revocation is **failed with a named reason** rather than quietly
  cancelled, so the job appears on the needs-attention queue for a person.
  Reasons: `agency_no_longer_on_job`, `agency_deactivated`,
  `customer_deactivated`, `approved_address_changed`.

**Failure handling, each distinguished:**

| Situation | Outcome |
|---|---|
| Storage briefly unreachable | attempt refunded, row stays `pending` — the message is pointless without its attachment |
| Attachment over 15 MB | `cancelled`, `attachment_too_large` — not retryable, it will be the same size next time |
| Version superseded while queued | `cancelled`, `superseded_by_correction` |
| Document row missing | `cancelled`, `certificate_document_missing` |
| Eligibility revoked | **`failed`**, named reason, flagged for review |
| Provider refused / timed out | ordinary bounded retry |

**Provider idempotency is stable across retries** — the key is
`certificate-release-<reference>-cert-<certificateId>-<recipient>`, which
does not change between attempts, so a retry after a timeout is recognised
by Resend as the same message. The tenant invitation remains the one
deliberate exception, because it mints a new link each attempt.

**Nothing is marked accepted before the provider accepts.** `document.sentTo`
is appended only on a `sent` result, and records the recipient, the address
actually used, the version and that the PDF was attached.

No billing information is in the message and the recipient policy is
unchanged: agency and customer only.

## 20.c The journey — **done**

Upload → private preview → explicit review/release → agency download →
optional email, coherent on desktop and tablet.

- **The version is on the send panel**, and the outbox state is shown per
  recipient: queued (with attempt count), accepted by the provider, or not
  sent with the reason in words rather than an error code.
- **A changed address is called out** next to the recipient — "approved for
  X, which is no longer the address on file" — rather than silently
  ignored.
- **Recovery:** a failed or stood-down recipient gets a *Queue again to the
  address above* control. It reuses the same row and the same provider key,
  so the provider still sees one message, and re-approves whatever address
  is on file now — which is the one displayed immediately above the button.
- **What actually went out** is listed on each certificate from
  `document.sentTo`: the address used and when, per version.
- Previous issued versions stay listed and downloadable, marked superseded.
- Acceptance is always worded as *accepted by the email provider*, never as
  delivery.
- **Opening the PDF still only enables the release form.** It is a prompt to
  read, and the wording says releasing is the reviewer's assertion — nothing
  infers that opening a file proves its contents.

## 20.d Verification

Gates: `npm test` **0** (**1711 tests**, up from 1661) · `typecheck`
**0** · `lint` **0** · `build` **0**.

**Isolated fixtures**, a separate Next instance on port 3200 with Google,
Upstash and Resend intercepted in-process and a local document store:

| Check | Result |
|---|---|
| Engineer upload of a 7,000-byte PDF | stored; on-disk **sha256 matches the uploaded bytes exactly** |
| Download by admin | bytes returned match the same sha |
| Before release: engineer / admin | **200** |
| Before release: owning agency / rival | **404** / **404** |
| Release with number and both dates | issued, version 1 |
| After release: owning agency | **200**, bytes match the same sha |
| After release: rival agency | **404**; rival on the job page **404** |
| Agency job page | number, both dates, working download |

**The adapter against SDK-compatible mocks** (`blob.test.ts`, 16 tests) —
explicitly *not* live-service verification. `put` always carries
`access: "private"`, under the `certificates/` prefix, with
`addRandomSuffix: false` and `allowOverwrite: false`; `get` reassembles a
chunked stream into exactly the stored bytes, bypasses the cache, and
treats 304 and null as failures rather than as an empty body; `del` removes
one pathname; every SDK error is returned rather than thrown. Static checks
assert the string `public` appears nowhere, that delete cannot take a list,
and that the module does not import the list API — so no sweep is possible.

**The store contract against a real directory** (`store.test.ts`, 9 tests):
bytes round-trip, keys are opaque and unique, a key from anywhere else
cannot reach the filesystem, a delete removes exactly one object and leaves
an unrelated file untouched, and the three configuration states report
correctly.

**The worker against a mocked database and storage** (`outbox.test.ts`, 12
new tests): the exact PDF bytes are attached; the frozen address is used;
a changed address **fails with `approved_address_changed` and does not
send**; a deactivated agency and an agency removed from the job likewise;
storage being unavailable refunds the attempt and stays queued **without
sending a bare message**; a superseded version is stood down; the provider
key is byte-identical across a retry; two concurrent workers send once.

### Blocker: the email path could not be run end-to-end here

Migration **0005 is written and not applied**. This task forbade
existing-database changes, and the worker's queue read selects
`recipient_address`, so the outbox cannot run against the development
database until it is applied.

What that leaves unverified in a browser: queue → drain → attachment
arriving at the (stubbed) provider. That path is covered behaviourally by
the twelve worker tests above against a mocked database, which exercise the
same code.

**To close it:** `npm run db:migrate` (one additive nullable column,
`drizzle/0005_outbound_recipient_address.sql`), then re-run the fixture
journey. Deploy order is migrate-then-deploy, as always.

## 20.e Status, and what is still not activated

| Piece | State |
|---|---|
| Blob adapter | **Implemented**, private-only, mock-tested. **Never run against a live store.** |
| Blob credentials | **Absent.** No store provisioned, nothing purchased |
| Local driver | Implemented and verified; refuses to run in production |
| Failed-upload cleanup | Implemented and tested; no sweep, by design |
| Attachments | Implemented; verified against the stubbed provider only |
| Migration 0005 | Written, **not applied** anywhere |

**Activation, in full:** create a Blob store on the Vercel project and
attach it, so `BLOB_READ_WRITE_TOKEN` is injected; apply migration 0005;
deploy. No code change is needed for either.

**Still unresolved and deliberately not decided:** what an engineer should
record against *"CO Alarm(s) tested and satisfactory"* when no alarm is
fitted. The unapproved *Not applicable* option is gone; the question is
BSCJ's.

Nothing in §13.6 is closed. No invoices, renewals or remedial workflows
were touched.

## 20.f Closeout — two defects found and fixed

The closeout review of §20 found two real faults. Both were in code written
in that phase; neither had reached a commit.

### A re-approval reused the provider's idempotency key

`requeueCertificateEmail` rewrote the existing row and swapped the address
in place, keeping the same `idempotency_key`. That key **is** the provider's
idempotency key, so Resend would have recognised the "new" message as the
one it had already accepted and sent nothing — the corrected address would
never have heard, and the screen would have reported success.

Worse, rewriting the row erased what had been attempted to the old address:
an email that may well have arrived.

**Fixed as two separate concepts, which is what they always were:**

- **A retry** is the worker trying the same intent again. Same row, same
  payload, same key — which is precisely what makes retrying after an
  ambiguous outcome safe.
- **A re-approval** is a person deciding to send to the address as it now
  stands. It inserts a **new row** with the next approval number, which
  produces a **new key**, and **leaves the earlier row exactly as it was**.

The key gained an approval component — `certificate-release:<certId>:<recipient>:<n>` —
and the worker now derives the provider suffix from the row's own key via
`approvalFromKey` rather than rebuilding it from the certificate and
recipient. **That second half mattered**: without it the row key changed and
the provider key did not, so the corrected message would still have been
deduplicated away. It was caught by the end-to-end test below, not by the
first fix.

The requeue also refuses while a send is still pending (adding a second
intent beside one in flight is how a recipient gets two emails) and refuses
once a version has been accepted for that recipient.

### A failed upload deleted the object on an error, not on a known outcome

The cleanup deleted the stored blob whenever the insert threw. A timeout, a
dropped connection or an aborted request can all leave a row **committed**
while the client sees an error — and deleting then destroys the bytes a
committed record points at, turning a recoverable blip into a certificate
with nothing behind it.

**Fixed.** The row is now looked for by its unique `blob_key` before
anything is removed:

| Outcome | Action |
|---|---|
| Row found | It committed. Nothing is deleted; the upload is reported as the success it was |
| Row definitely absent | The object is removed — nothing will ever reference it |
| The check itself failed | **The object is kept**, `document.upload_uncertain` is audited, and the engineer is told to reload the job before uploading again |

An orphan costs a fraction of a penny; a wrong delete cannot be undone.

### A third fault, found in the browser

The retry control was a `<form>` inside the queue `<form>`. Browsers drop a
nested form, so the retry button silently became a submit for the queue
form and did nothing. The queue form is now a **sibling** of the recipient
list, with the checkboxes joined to it by the `form` attribute. Asserted by
`document.querySelectorAll("form form").length === 0` on the live page.

### Migration 0005 applied to development

Confirmed before running: exactly one DDL statement,
`ALTER TABLE "outbound_email" ADD COLUMN IF NOT EXISTS "recipient_address" text`,
and exactly one migration outstanding. Applied with `npm run db:migrate` to
the development Neon database only. Verified after: the column exists as
`text`, nullable; job, user and email counts unchanged. **Production was not
touched and no other migration was applied.**

### The journey, end to end on isolated fixtures

Google, Upstash and Resend intercepted in-process; local document store.

| Step | Result |
|---|---|
| Engineer uploads a 7,000-byte PDF | stored; object sha `bc8ba77a…` |
| Admin reviews and releases | `BSCJ-CERT-CLOSE`, version 1 |
| Recipients shown with real addresses, both selected | queued, 2 rows, no address in either key |
| Drain | 2 accepted; **attachment sha `bc8ba77a…`, 7,000 bytes — identical to the stored object** on both messages |
| Agency address changed, earlier row failed | screen shows "Approved for …, which is no longer the address on file" |
| *Queue again to the address above* | **new row, approval 2, new key**; the approval-1 row untouched with its old address and error |
| Drain | 1 accepted, to `corrected.agency@…`, same PDF, **provider key `…-agent-2`** |
| All three provider keys | distinct |

`scripts/browser-fixtures.mjs` now records each attachment's filename, size
and SHA-256 — without which "the exact PDF arrived" could not be checked at
all. Digest only: a certificate is too large to keep in a state file read by
hand.

Unit coverage added alongside: the ambiguous-outcome sequence end to end
against the worker (timeout → retry with an identical key → address changes
→ old intent refuses → new approval sends), and focused tests for each
cleanup outcome.

Development database returned to **1 app_user, 0 jobs, 0 documents, 0
certificates, 0 queued emails**. The 35 `audit_event` rows are preserved —
the log is append-only and was never a fixture.

### Unchanged blockers

- **No Blob store provisioned**; the adapter remains verified only against
  SDK-compatible mocks. Activation is still: attach a store so
  `BLOB_READ_WRITE_TOKEN` is injected, then deploy.
- **Migration 0005 is applied to development only.** Production needs it
  before this code is deployed — migrate, then deploy.
- **The CO-alarm question is still open** and deliberately undecided.
- Nothing in §13.6 is closed.
