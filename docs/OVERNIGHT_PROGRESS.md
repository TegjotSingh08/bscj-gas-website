# Overnight progress — 21/22 September 2026

**Live checkpoint.** Updated after each milestone so an interrupted session can
resume without re-discovering anything. Read this, then `git log`, then carry on
from "Third pass" below, which is the most recent state.

---

## Session start

| | |
| --- | --- |
| Starting HEAD | `d4d3c82`, clean, synced with `origin/v2-compliance-platform` |
| Current HEAD | see "Commits" below |
| Working tree | see "Commits" below |

---

## The limitation that shaped the previous pass — now closed

**Superseded 22 September.** The earlier passes recorded that no disposable
database could be established, and every integration claim was made against a
fake at the database boundary. A real one now exists.

`embedded-postgres` runs a genuine **PostgreSQL 18.4** from `node_modules` on
loopback port 55433, project-local, with a temporary data directory deleted on
stop. The real migration chain `0000`–`0009` is applied by Drizzle's own
migrator. Two connections are genuinely two backends (distinct
`pg_backend_pid()`), so a race between them means something.

It fails closed: no env file is read, inherited `DATABASE_URL*` is deleted from
the process before any connection opens, and `assertDisposable` is a whitelist
of exact values — loopback, that port, that database name, that fictional user,
and a marker the harness itself set. Development and pilot databases are
untouched.

**The verification ladder now reads:**

| Level | What it means | Used for |
| --- | --- | --- |
| **unit** | A pure function, called directly. | Rules, dates, address splitting, renewal arithmetic. |
| **postgres** | Production service code against the **real disposable PostgreSQL**, with real constraints, transactions and independent connections. | The renewals query, the certificate race, the connected journey. |
| **service** | Production code with external adapters captured; the database is real. | Email, calendar and storage effects. |
| **browser** | A real page rendered and driven. | Public pages and email previews. |
| **live** | Against real services. | **Nothing.** Owner-observed results are recorded as theirs. |

`npm test` is the fast unit suite; `npm run test:integration` is the PostgreSQL
one.

---

**Note.** A service-level pass is not live-delivery or live-database
verification and is never described as one.



---

## Execution checklist

| # | Priority | Existing implementation | Actual gap | Acceptance | State |
| --- | --- | --- | --- | --- | --- |
| 1a | Import policy truth | `import/profile.ts`, `plan.ts`, `rows.ts` | `landlordMatch: reject_row` is labelled "Hold the row for review — nothing is written" but is **never consulted**; since 0008 made contact nullable, such rows are silently created. | The chosen policy is the behaviour. | **done** |
| 1b | Policy explanation | `PROFILE_CHOICES`, `ImportWizard` | "Never creates a landlord" is false for a policy that records a contactless one; nothing says what is still owed later. | Each option states what is recorded and what later refuses. | **done** |
| 1c | Profile compatibility | `parseProfile`, `profileDigest` | A third policy value must not misread saved v2 profiles. | Saved profiles keep working; digest still invalidates stale previews. | **done** |
| 1d | End-to-end exercise | `previewImportAction` / `confirmImportAction` | Never run as one path outside the deployed app. | A harness drives the real actions over fictional CSVs. | **done** |
| 2 | Work journey | jobs, scheduling, documents, invoices | Not exercised as one path; defects unknown. | Service-level pass with defects fixed. | **done** |
| 3 | Certificate → renewal | `releaseCertificate`, `setCompliancePosition` | `releaseCertificate` **never writes `compliance_cycle`**; `setCompliancePosition` hardcodes `cp12` and supersedes every product. | Release updates the right service's position, preserving history. | **done** |
| 3b | Due-work view | admin list patterns | No overdue/due-soon/unknown view. | Admin can see and act without developer help. | **done** |
| 4 | Failure visibility | outbox, `admin/reconcile` | States exist; surfacing and recovery need checking. | Operator-visible states and a safe recovery action. | **done** |
| 5 | Polish + acceptance pack | site components, email theme | — | Morning pack exists and is honest. | **done** |
| 6 | Agency page | public site | Absent. | Local-only, no unsupported claims. | **done** |

---

## Commits

| HEAD | Subject |
| --- | --- |
| `d4d3c82` | *(session start)* |
| `5725d2e` | Make the import's hold policy actually hold |
| `f3aee35` | Let a released certificate move the renewal it proves |
| `338d268` | Show BSCJ what the queue is actually doing |
| `4b15579` | Offer agencies the service we actually run, and leave a morning pack |
| `9c3ae3e` | Leave the record straight for the morning |
| `ccbaca2` | Give the tests a real Postgres to be wrong against |
| `16fc473` | Type the disposable handle by what it is, not by the pool overload |
| `ff1b3e7` | Count renewals once, and only against the service they are for |
| `e2c4841` | Stop a superseded certificate displacing its own correction |
| `bf11241` | Promise only what the email provider actually guarantees |
| `c41e4da` | Drive the connected workflow through the application, against PostgreSQL |
| `c19b27d` | Make the acceptance pack's claims and its order true |
| `582d6ea` | Report a renewal repair only where one is actually possible |
| `f95887a` | Say only what the stored evidence supports about a retry |
| `b86bc35` | Drive the signed-in application in a browser, on a throwaway database |
| `7e9560e` | Separate the four kinds of evidence in the acceptance pack |
| `5bf454b` | Find a repair that history is standing in front of |
| `0adbc05` | Verify the boundaries by being the person they refuse |

Working tree: clean.

---

## Tests run

| When | Command | Result |
| --- | --- | --- |
| start | `git status` / `git rev-list` | HEAD `d4d3c82`, clean, 0 ahead 0 behind |
| P1 | `npm test` | 2165 pass, 0 fail (was 2125) |
| P1 | `npx tsc --noEmit` | clean |
| P1 | `walkthrough.test.ts` | 33 scenarios through the real server actions, all pass |
| P3 | `npm test` | 2213 pass, 0 fail |
| P3 | `npx tsc --noEmit` | clean |
| P3 | `npm run build` | clean; `/admin/due` present |
| P4 | `npm test` | 2243 pass, 0 fail |
| P4 | `npm run typecheck` | clean |
| P4 | `npm run build` | clean |
| P5 | browser, desktop + 375px | `/letting-agents` and `/book` render; no console errors; no overflow |
| P5 | browser | `previews/index.html` light and dark; test PDF renders with its watermark |
| P5 | `checkPdf` on the test PDF | accepted, 2,731 bytes |
| final | `npm test` | **2243 pass, 0 fail**, 453 suites |
| final | `npm run typecheck` | clean |
| final | `npm run lint` | 1 pre-existing warning (`invitationRow`, unrelated) |
| final | `npm run build` | clean |
| final | diff scan | no secrets, no real addresses, migrations additive and paired |
| **22 Sep, correction pass** | `npm run test:integration` | **122 pass, 0 fail** against real PostgreSQL 18.4 |
| 22 Sep, correction pass | `npm test` | 2242 pass, 0 fail |
| 22 Sep, correction pass | browser, signed in | admin + agency journeys on the throwaway database |
| *(earlier)* | `npm run test:integration` | 101 pass, 30 suites, 0 fail |
| 22 Sep, final | `npm test` | 2231 pass, 448 suites, 0 fail |
| 22 Sep, final | `npm run typecheck` | clean |
| 22 Sep, final | `npm run lint` | 1 pre-existing warning (`invitationRow`) |
| 22 Sep, final | `npm run build` | clean |
| 22 Sep | real server, port 3211/3212 | `/letting-agents` 404 without the flag, 200 with it |
| 22 Sep | `npm test` | 2228 pass, 0 fail |
| 22 Sep | `npm run typecheck` | clean |
| 22 Sep | `npm run lint` | 1 pre-existing warning |

---

## Running processes

**None left running.** A production server was run briefly on port 3210 to
inspect public pages (another chat holds the dev server on 3100 and was not
disturbed) and has been stopped. It used no external service.

---

## Third pass — 21/22 September 2026

**Complete.** Four priorities, each reproduced before it was fixed.

| | What was wrong | What was done |
| --- | --- | --- |
| 1 | `listOutstandingRenewals` fetched one window of `max(limit * 4, 200)` candidates **before** the rules judged them. Old certificates are overwhelmingly not repairs, so 200 of them hid a genuine failure behind them — on the page whose only job is to show it. | Stable keyset walk over `(issued_at, id)` until the rows asked for are found or candidates run out. The bound stays, but reaching it is `bound` with a cursor and a **Continue from here** link, never an empty list. `decidePosition` is still the only rule. |
| 1b | `/admin/reconcile` turned a failed query into "Nothing outstanding." via `(renewals?.length ?? 0) === 0`. | The rule is one tested function: reassurance requires knowledge. Unknown gets its own alert and withholds the claim. |
| 2 | The access-boundary tests exercised no boundary — `assertCan` with role strings, and a source scan for `requireAdmin()`. | Real server, real sign-ins, real requests as each role. Both old checks kept, renamed for what they are. |
| 2b | **Found by doing that:** `/admin/login` redirected *any* session to `/admin`, which sends non-admins back — an infinite loop. An engineer who typed the right password could not sign in at all. | Each session goes where it is allowed; an agency user is left on the page and told why. Tests follow the whole chain, because every first hop was already correct. |
| 3 | The disposable driver's `batch` was not atomic: `pool.query` returns the connection per statement, so a concurrent request's write landed inside the transaction and died in an unrelated rollback. | A lock around the handle's work; `max: 1` only ever made it the same session. Reproduced first — the bystander's row vanished. |
| 3b | `browser-server.ts` claimed setting `NODE_ENV` made the local store work under `next start`. | It does not: a production build folds the check away at compile time (evidenced in `.next/server`). It runs `next dev`, from a separate checkout, and says so. |

### Verified in a browser this pass, signed in

Upload → review → release → renewal moved to 19 September 2027 → position
removed → Reconciliation listed it → **Update the renewal from this
certificate** cleared it → empty on reload. Plus the agency-user and engineer
redirect behaviour above. The document was served back at
`/api/documents/<id>` with 200 from the local store.

Two limitations, stated: the server was `next dev` (the only configuration the
local store permits), and the PDF was attached to the real file input
programmatically because the browser tool cannot open a native file dialog.
Every other interaction was a click on the real control.

### Gates on this release

| Command | Result |
| --- | --- |
| `npm run test:integration` | **156 pass, 47 suites, 0 fail** |
| `npm test` | **2251 pass, 454 suites, 0 fail** |
| `npx tsc --noEmit` | clean |
| `npm run lint` | see below |
| `npm run build` | see below |

## Correction pass — 22 September 2026

**Narrow.** One defect in the cursor added by the third pass, one over-claim on
the page that uses it, and one over-broad sentence in the report. No feature
work.

| | What was wrong | What was done |
| --- | --- | --- |
| 1 | The keyset cursor was built with `candidate.issuedAt.toISOString()`. A JavaScript `Date` holds **milliseconds**; `timestamptz` holds **microseconds**. So a row issued at `09:00:00.123456+00` produced the cursor `…123Z` — a position *earlier than the row it came from* — and `issued_at > cursor` matched that row again. Every page began where the last one did, and the traversal repeated for ever. Reproduced independently: the tie test failed `20 !== 6`. | The cursor value is rendered by PostgreSQL with `to_char(… at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` and never passes through a `Date`. The id tie-breaker is unchanged. Nothing stored was rewritten, no precision was given up, and no time was added to anything. |
| 2 | A continuation page could print **"Nothing outstanding."** Exhausting the records *after* a cursor says nothing about the ones before it. | `summariseReconcile` takes `continued`, and a continuation is never "complete". The section renders even when empty, states its scope, says *"No repairs after that point. Earlier ones, if any, are still on the pages before this."*, and carries **Back to the start**. |
| 3 | The report listed real email delivery under "not verified by anybody", which is wrong. | The owner's live observations on `d4d3c82` are recorded as the successes they are. What lacks evidence is named precisely: the Blob driver, the templates **as they now read**, any real mail client, and automatic retries against a provider failure. |

### How the fix was established

Each of the five new regressions fails against the truncating cursor and
passes against the fixed one — verified by putting the truncation back and
running them. Two pre-existing tests now fail against it too, because the
seeded history carries microseconds.

| Regression | What it holds |
| --- | --- |
| the cursor keeps the microseconds the database stores | the cursor reads `…123456Z`, not `…123Z` |
| six sharing one microsecond instant | each returned exactly once, then termination |
| timestamps a microsecond apart | six distinct positions inside one millisecond, in order |
| across the query's own page boundary | 250 repairs sharing an instant, one call, 250 examined, none twice |
| continuing after the examination bound | resumes *after* the 2,000, examines 1, ends |

Rendered and read back from the running application on the throwaway
database: the first page, a continuation (2 of 3, banner and **Back to the
start** present), a continuation past the last repair (0 rows, no "Nothing
outstanding."), and a malformed cursor (fails closed to the *unknown* alert,
no crash).

### Gates on the correction

| Command | Result |
| --- | --- |
| `npm run test:integration` | **161 pass, 48 suites, 0 fail** |
| `npm test` | **2255 pass, 455 suites, 0 fail** |
| `npm run typecheck` | clean |
| `npm run lint` | 1 pre-existing warning (`invitationRow`) |
| `npm run build` | clean, in an isolated checkout |

---

### Still the owner's, and not done here

The six-step checklist at the top of `docs/acceptance/README.md`. Nothing was
pushed, deployed, migrated or sent. **The Blob document driver is the one part
of the certificate path with no evidence at all** — the screens are
browser-verified against the local store; the driver underneath them has never
been called.

---

## Outstanding owner decisions

These block **real agency use** and cannot be invented:

1. **Business identity** — legal entity, address, VAT position. `canIssueInvoices()`
   refuses until supplied; invoicing is exercised only with fictional settings
   inside the test harness.
2. **Invoice footer wording and payment terms.** Same guard.
3. **Agency pricing figures.** The tier mechanism exists; no numbers are in the
   code and none were invented.
4. **CP12 renewal interval as a business policy.** The code applies
   inspection + 12 months − 1 day, recorded as BSCJ's existing generator's
   behaviour. Not re-derived tonight.
5. **Express Properties' actual export headings.** Still unconfirmed, so the
   profile shipped for them is empty and the fictional CSVs are illustrative.
6. **Whether `reject_row` or `record_without_contact` is right per agency.**
   Now a real choice with real consequences — see the acceptance pack.

## Outstanding external verification

**Already owner-observed, live, on `d4d3c82`** — and not to be re-listed as
unverified: agency invitation delivered, password set, tenant invitation
received, booking made, confirmation received, appointment in the dedicated
pilot Google Calendar. Real Resend deliveries and a real Google write.

Still without evidence of their own, all of them about **this** release:

- The Blob document driver. The certificate screens are browser-verified
  against the local store; the driver underneath them has never been called.
- The email templates as they now read — delivery works, the current wording
  has not been sent or received.
- Any real mail client's rendering (Outlook in particular).
- Automatic outbox retries against a real provider failure.
- The deployed CSV identity/review/commit journey, by the owner.
- Redis, and the calendar path on this release.
