# The connected engineer certificate workflow

**22 September 2026.** How an engineer writes a gas safety record from the job,
what it reuses, and what it deliberately does not change.

---

## What changed

**Before.** Four steps and a file:

1. Download this job's details (a `.json` of the customer's name, address and
   phone number, into the device's Downloads folder).
2. Open the generator.
3. Import the file.
4. Generate the PDF, find it, come back to the job and upload it.

On a phone in somebody's hallway that is four things to remember, and every
certificate left a document full of a customer's details on the device.

**Now.** One button on the job:

1. **Create gas safety record** — or **Continue draft** if one is part-written.
2. The generator opens with the property, the customer and the engineer's own
   details already filled in.
3. The engineer enters the readings, the outcomes, the date and the number.
4. **Save draft** at any point. The draft is on the server, so it survives a
   refresh, a sign-out and changing device.
5. **Submit for review** draws the PDF and sends it straight to the office.
6. The job shows **Submitted and waiting for the office to review it**.

**What did not change: submitting is not issuing.** The record arrives as a
document awaiting review. An administrator opens it, reads it, and releases it
through the same screen as before. Only release writes a certificate, moves a
renewal date or lets anybody be emailed.

---

## What it reuses

Nothing here is a second generator, a second certificate lifecycle or a second
way of storing a document.

| Reused | Where | How |
| --- | --- | --- |
| The generator | `vendor/cp12-generator/index.html` | The same file, served from the same route. `?job=<uuid>` puts it in connected mode; without it, unchanged. |
| The hosting route | `/engineer/certificate/[[...file]]` | Untouched. The `<base href>` it already carried is why a query string needs no routing change. |
| The prefill payload | `src/lib/jobs/cp12-prefill.ts` | The same 13 fields and the same allow-list as the download. |
| The PDF drawing | `renderCertificatePdf()` | Factored out of `downloadPdf()` unchanged — same clone, same scale, same page geometry — so the download and the submission cannot drift. |
| Storing and recording | `uploadCertificate()` | Submission **calls it**. Private store, PDF checks from the bytes, store-before-record ordering, the uncertain-insert reconciliation, the audit line. |
| Review and release | `releaseCertificate()`, the admin job screen | Untouched. Recipients, outbox, versioning, supersession and renewal positioning all unchanged. |
| Access rules | `canAccessAssignedJob`, `requireEngineerOrThrow` | Every read and every write, not just the page. |

---

## What is new

### One table: `certificate_draft`

One row per job, holding the generator's own flat `{ elementId: value }` map.

- **Server-held**, so the work survives a refresh, a sign-out and a change of
  device, and so a customer's details are not left in `localStorage`
  afterwards. **Connected mode writes nothing to the browser at all** — no
  draft, no landlord book, no engineer defaults.
- **`revision`** is what stops a stale tab winning. Every save states the
  revision it was based on; a save based on an older one is refused with the
  current draft attached, so neither device loses work.
- **`submission_key`** is claimed with a conditional `UPDATE` before a byte is
  stored, so two simultaneous taps cannot become two records. A repeat of the
  same key returns the document the first attempt produced.

### Three routes

| Route | What it does |
| --- | --- |
| `GET /api/engineer/jobs/[id]/certificate/session` | Prefill and stored draft together, so the sheet is never briefly wrong. |
| `PUT .../certificate/draft` | Saves, with the revision check. `409` carries the current draft. |
| `POST .../certificate/submission` | The PDF, into `uploadCertificate`. |

All three: engineer audience guard, then access re-derived from the job row.
`PUT` and `POST` also check same-origin explicitly. An engineer who is not on
the job gets exactly the answer they would get for a job that does not exist.

---

## Rules it keeps

- **Only administrative detail is prefilled.** No reading, no outcome, no
  signature, no certificate number and no date — those are the engineer's, and
  nothing invents one. `landlordAddress`, `landlordPostcode` and `instIdCard`
  stay blank because the application does not hold them, and the generator
  says so.
- **Reopening never overwrites work.** Prefill is applied to a blank sheet and
  the stored draft is laid over it, so the engineer's own entry always wins.
  Where a job detail has changed since the draft was started, the difference is
  **shown** rather than applied silently or hidden.
- **"Saved" is never shown before the server has accepted it.** The states are
  Loading / Unsaved changes / Saving… / Saved / Could not save / Saved
  somewhere else. Anything typed while a save is in flight keeps the draft
  marked unsaved.
- **No offline support is claimed, because there is none.** Losing signal shows
  *Could not save*, the work stays on screen, and **Save draft** retries.
- **The customer's details are on the device's screen**, and the wording says
  so. What changed is that no file is downloaded and nothing is left in the
  browser's storage afterwards.
- **A job is not finished by filing its paperwork.** *Work is done* is still a
  separate, deliberate act.

---

## Mobile

- The toolbar is sticky at phone width, with **Save draft** and **Submit for
  review** full-width and 44px tall.
- The three header blocks stack; side by side they were 110px wide, which turns
  an address into three letters.
- Inputs are 16px, or iOS zooms the page on focus.
- The sheet is a landscape A4 form and stays one — it scrolls sideways inside
  its own frame rather than being crushed into 375px.
- **The PDF is not a phone layout.** The capture host is explicitly excluded
  from every phone rule, so a certificate drawn on a phone is the same document
  as one drawn on a laptop. Verified by generating one at 375px and reading it.

---

## Verified

**Automated, against real PostgreSQL** — `test/integration/engineer-certificate.test.ts`
(30 tests) and the certificate routes in `access-boundaries.test.ts`:
prefill and job binding, draft save/reload, isolation between jobs and
engineers, unauthorised reads and submissions, access lost on reassignment,
stale-revision refusal, required-field validation on the **server**, duplicate
submission, retry after a failure, submission reaching awaiting review without
release/email/compliance movement, admin release through the existing path, and
the manual upload fallback.

**Unit** — `src/lib/documents/certificate-draft-fields.test.ts` reads the
generator's own markup and asserts the server's field list, appliance shape and
outcome ids match it, so the contract cannot drift silently.

**Browser, signed in, throwaway database, phone width** — engineer login →
assigned job → prefilled generator → save → full reload → resumed → completed →
submitted → administrator opened the stored PDF → released it. The generated
PDF was extracted from the store and read: correct landscape A4, nothing
clipped, all 21 appliance columns and all six outcomes present.

**Not verified here** — the **Vercel Blob** driver. Every document above went
into the local store. The screens are identical on Blob; the driver underneath
them has not been exercised from this workflow.
