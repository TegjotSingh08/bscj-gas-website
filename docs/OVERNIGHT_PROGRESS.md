# Overnight progress — 21/22 September 2026

**Live checkpoint.** Updated after each milestone so an interrupted session can
resume without re-discovering anything. Read this, then `git log`, then carry on
from "Next action".

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

--- | --- | --- |
| **unit** | A pure function, called directly. | Rules, dates, address splitting, renewal arithmetic. |
| **service** | Real production service and server-action code, with recording fakes at the **database and external-adapter boundary only**. Permissions, envelope signing, idempotency, recipient selection and ordering are genuinely exercised. | Most of tonight's work. |
| **browser** | A real page rendered and driven in a browser. | Public pages and email previews only — everything behind sign-in needs a database. |
| **live** | Against real services. | **Nothing tonight.** Owner-observed results are recorded as such and are not mine. |

A service-level pass is **not** live-delivery or live-database verification and
is never described as one.

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
| **22 Sep** | `npm run test:integration` | **70 pass, 0 fail** against real PostgreSQL 18.4 |
| 22 Sep | `npm test` | 2228 pass, 0 fail |
| 22 Sep | `npm run typecheck` | clean |
| 22 Sep | `npm run lint` | 1 pre-existing warning |

---

## Running processes

**None left running.** A production server was run briefly on port 3210 to
inspect public pages (another chat holds the dev server on 3100 and was not
disturbed) and has been stopped. It used no external service.

---

## Next action after interruption

**Second pass, 22 September — in progress.**

Done: disposable PostgreSQL (objective 1), renewals query (finding 2),
certificate correction race and durable recovery (finding 3).

Next: **finding 4** — email retry guarantees. `retryFailedNotification`
currently promises the provider will not send twice, and `retry.test.ts`
asserts that promise. Verify Resend's actual idempotency guarantee (24-hour
retention, matching payload), trace each message kind for attempt-derived keys
and regenerated credentials, then fix behaviour and wording together.

Then finding 5 (connected journey against PostgreSQL) and finding 6 (acceptance
pack corrections).

If resuming, the most valuable remaining work, in order:

1. **Run the acceptance pack against the pilot** — `docs/acceptance/README.md`.
   That is the owner's, and it is what turns tonight's service-level passes into
   live evidence.
2. **A disposable database**, so the journey can be exercised for real. PGlite
   as a devDependency plus a second drizzle driver behind a flag is the smallest
   route, and it is a deliberate decision rather than something to do unattended.
3. **Admin-initiated job requests**, if BSCJ should be able to raise work
   without waiting for the agency to click. Deliberately not built — it needs a
   product decision about who may act for whom.

*(Superseded note — Priority 3 is done.)* `releaseCertificate` in
`src/lib/documents/certificates.ts` writes a `certificates` row but never
touches `compliance_cycle`, so a released certificate does not move the
property's due date. `setCompliancePosition` in `src/lib/portfolio/mutations.ts`
also hardcodes `productId: "cp12"` and supersedes every product's active cycle.

Priority 2 is folded into the same work: the journey is exercised at service
level as each slice lands, since no disposable database exists.

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

- Actual Outlook (and any real mail client) rendering.
- Automatic outbox retries against a real provider failure.
- The deployed CSV identity/review/commit journey, by the owner.
- Live calendar, Blob and Redis behaviour.
