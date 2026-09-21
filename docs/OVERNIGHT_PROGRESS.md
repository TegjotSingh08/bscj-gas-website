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

## The one limitation that shapes everything

**No disposable database could be established.** Checked at session start:
`docker`, `podman`, `psql`, `postgres`, `pg_ctl` and `initdb` are all absent,
Docker is not running, and neither PGlite nor any embedded Postgres is in
`node_modules`. Installing a database engine, or wiring a second driver into
production code to fake one, is explicitly out of scope for an unattended
night.

The development and pilot databases are **not** disposable and are not touched.

So the verification ladder used throughout is:

| Level | What it means | Used for |
| --- | --- | --- |
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
| 2 | Work journey | jobs, scheduling, documents, invoices | Not exercised as one path; defects unknown. | Service-level pass with defects fixed. | not started |
| 3 | Certificate → renewal | `releaseCertificate`, `setCompliancePosition` | `releaseCertificate` **never writes `compliance_cycle`**; `setCompliancePosition` hardcodes `cp12` and supersedes every product. | Release updates the right service's position, preserving history. | **done** |
| 3b | Due-work view | admin list patterns | No overdue/due-soon/unknown view. | Admin can see and act without developer help. | **done** |
| 4 | Failure visibility | outbox, `admin/reconcile` | States exist; surfacing and recovery need checking. | Operator-visible states and a safe recovery action. | not started |
| 5 | Polish + acceptance pack | site components, email theme | — | Morning pack exists and is honest. | not started |
| 6 | Agency page | public site | Absent. | Local-only, no unsupported claims. | not started |

---

## Commits

| HEAD | Subject |
| --- | --- |
| `d4d3c82` | *(session start)* |
| `5725d2e` | Make the import's hold policy actually hold |
| `f3aee35` | Let a released certificate move the renewal it proves |

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

---

## Running processes

None.

---

## Next action after interruption

Begin **Priority 4**: outbox failure visibility and recovery. Start by reading
`src/lib/notifications/outbox.ts` and `src/app/admin/reconcile/page.tsx`, then
check what states the admin job page already shows for a queued message.

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
