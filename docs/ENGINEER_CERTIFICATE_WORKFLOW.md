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

### PDF layout acceptance — 22 September 2026

The check left outstanding by the previous handover. Three certificates
produced **through the real submission path**, on a disposable database, with
deliberately long landlord and property details and the **maximum six
appliance rows**, every row carrying all 21 columns. Each PDF was pulled out
of the document store and read.

| Run | Width | Result |
| --- | --- | --- |
| `TEST-NOT-VALID-LONG-0001-SUFFIX` | desktop, 1024px | 1 page, A4 landscape. Nothing clipped or overlapping. |
| `TEST-NOT-VALID-LONG-0002-PHONE` | phone, 375px | Same, and materially identical to the desktop one. |
| `TEST-NOT-VALID-OVERFLOW-0003` | desktop | 3,161 characters of defects and 1,694 of comments. Still 1 page, still nothing clipped. |

**What was checked and held.** A 30-character certificate number, a
66-character company name, a 64-character landlord company, four-line
addresses in all three blocks, twelve numbered defect entries, and eight
comment paragraphs — all render complete. All six appliance rows and all 21
columns present in every run, including the `No` / `No` row that has to read
as *not satisfactory*. The "Equipotential Bonding" outcome prints as ✗ when
set to not satisfactory rather than silently as a tick.

**Phone and desktop agree.** The capture host draws the sheet at a fixed
1650px whatever the viewport: measured 1650×1302 at both 320px and 375px, and
1650×1305 at desktop — a 0.23% difference. The resulting PDFs differ by under
1% in scale, which is rasterisation rounding, not a layout difference. The
phone-specific CSS does not reach the capture host, which was the risk worth
testing.

**Under extreme text it degrades by scaling, not by clipping.** The overflow
run's content renders at about 73% of normal linear scale — the sheet grows
taller and fit-to-page shrinks it onto one page. Smaller, still legible, and
nothing is lost. That is the right failure mode and it is the generator's own
pre-existing behaviour.

**One characteristic worth knowing, not introduced by this workflow and not a
defect:**

- **The PDF has no text layer.** It is a rasterised image, because the
  generator draws through html2canvas and embeds a JPEG. So a released
  certificate is not searchable or selectable. That is how the original tool
  has always produced them.

**The signature boxes were blank at that acceptance, and are not any more.**
`.sig-box` was an empty `<div>`; the generator had never captured a signature,
so a released certificate carried two printed names above two empty boxes.
Signature capture was added on 23 September 2026 — see below.

**Not verified here** — the **Vercel Blob** driver. Every document above went
into the local store. The screens are identical on Blob; the driver underneath
them has not been exercised from this workflow.

---

# Signatures — 23 September 2026

The certificate's two signature boxes are now filled where the work happens,
on the engineer's device, instead of being left empty for a wet signature
after printing.

## The contract this had to fit, established before anything was built

The sheet's signature row has exactly three columns and nothing else:

| On the certificate | Field | What it is |
| --- | --- | --- |
| **Issued by: Signed** | `.sig-box` (was an empty `<div>`) | The engineer who carried out the inspection. |
| Print Name | `issuedPrintName` | Already captured, already prints. |
| **Received by: Signed** | `.sig-box` (was an empty `<div>`) | Whoever was at the property and took a copy. |
| Print Name | `receivedPrintName` | Already captured, already prints. |
| **Date** | `sigDate` | Already captured. Required for submission. |

**There is no declaration text anywhere on the sheet**, and none has been
added. The labels say *Signed* and nothing more. Nothing in the code says what
a signature means, because the certificate does not say it either, and writing
that wording would be inventing a legal fact BSCJ has not supplied.

**Nothing here claims a drawn signature establishes legal validity.** What it
establishes is narrower and true: a specific person, authenticated on this job,
deliberately drew a mark against a known state of this record, and the record
has not changed since.

**Release validation is untouched.** `checkRelease()` still asks an
administrator for the certificate number, the inspection date and the next due
date, re-typed from the PDF. It has no opinion about signatures and did not
acquire one.

## The rules

### A signature is drawn, never derived

The only writer is `signCertificateDraft`, and it takes an image. There is no
path from a typed name to a mark, no carry-over from a previous certificate,
and the pad opens blank every time for every box. The server decodes the PNG,
checks its magic bytes and dimensions, and **re-encodes from the decoded
bytes**, so what is stored is exactly what was validated.

### A signature is bound to the job, the engineer and the revision

Signing is its own request. It names the revision it is signing, a mismatch is
a `409`, and the hash of what it covers is taken from the **stored** fields —
never from anything the browser sends. Access is re-derived from the job row
on every call, like every other write in this workflow.

### Editing an attested field removes the mark, and says so

This is the rule, stated once. A mark is kept only while the fields it was put
against are unchanged. It is enforced on the server **inside the ordinary
save**: the stored marks are checked against the fields being written, the
ones that no longer match are dropped, and the response names them. The
browser mirrors that — the box empties and a notice says which signature went
and why. Nothing is silently retained, and nothing silently disappears.

The two boxes attest to slightly different things, deliberately:

| Mark | Covers | Does not cover |
| --- | --- | --- |
| Issued by | Every field that prints on the certificate | `receivedPrintName` — who took the copy is not part of what the engineer certifies |
| Received by | Every field that prints, including their own name | — |

That difference is what makes the doorstep order work: the engineer signs,
then types the tenant's name, and the engineer's mark survives. The tenant
signs last, and nothing after it should change. Neither attests to
`landlordSelect2`, which is the standalone landlord picker and is stripped
from the PDF.

### The engineer's mark is required; the other one is not

`describeMissingSignatures` refuses a submission without **Issued by**. The
engineer is the person holding the device; it is one tap; and an *Issued by:
Signed* box left empty on a released certificate is the gap this work exists
to close. The check runs on the server, from the stored image and the stored
fields — the generator's own check exists only so the engineer is told before
a PDF is drawn on a phone.

**Received by is optional and its absence is recorded as absence.** A property
can be empty, a tenant can be out, a landlord can ask for it by email.
Requiring a mark there would not produce one; it would produce engineers
drawing it themselves. When nobody signs, the box prints empty exactly as it
always has and nothing is written on the certificate about why — see *Still to
decide*.

### Submitted documents stay immutable

Signing after a submission behaves exactly as editing after one does: the
draft is no longer the thing that was sent, so the job stops saying "submitted
and waiting", and the PDF already with the office is untouched. A correction
goes through the office's existing versioning and supersession, unchanged. The
Sign and Clear controls are hidden once a record has been submitted.

### Standalone use is unchanged

The controls carry `conn-only`. Without `?job=<uuid>` the boxes are empty
`<div>`s with no image and no buttons, exactly as before, and the standalone
footer's description of where data lives is still true.

## What is new in the code

| Piece | Where |
| --- | --- |
| The rules — what an image may be, what a mark covers, what removes it | `src/lib/documents/certificate-signatures.ts` |
| Signing and clearing, and pruning during a save | `signCertificateDraft`, `saveCertificateDraft` |
| One route | `PUT /api/engineer/jobs/[id]/certificate/signature` |
| The column | `certificate_draft.signatures`, migration `0012` |
| The pad, the boxes and the notices | `vendor/cp12-generator/index.html` |

`signatures` is a column rather than a member of `fields` because a signature
is not a field: it is an image, it is far larger than the 4,000-character
per-field cap, and it has to carry the hash of what it covers. Keeping it out
means the generator's element-id contract is untouched.

## Mobile

- The pad is a full-width canvas, 150px tall at phone width, with `touch-action:
  none` so drawing does not scroll the page.
- It captures at three times the box, which is the resolution the PDF is drawn
  at, and crops to the ink so the mark fills the certificate's box instead of
  sitting inside empty pad.
- **Use this signature** stays disabled until the pen has travelled 40px, so an
  accidental tap is not a signature. **Clear and start again** empties it.
- Sign and Clear are 44px tall. The capture host never sees them —
  `makePrintClone` removes `.sig-actions` outright.

## Verified

**Unit** — `src/lib/documents/certificate-signatures.test.ts` (30 tests): what
may be stored (a name is refused; a data URL that only claims to be a PNG is
refused; SVG and JPEG are refused; oversized and photograph-sized are refused;
a valid PNG round-trips canonically), what a mark covers (stable under
trimming and key order; changed by a reading or an outcome; the `issued` /
`received` difference; unaffected by a field that never prints), what removes
one, what survives a read of the column, and what the signature row must have
before submission.

`certificate-draft-fields.test.ts` also now asserts the generator is a working
document: no HTML comment left open, three real `<script>` elements, the pad
outside `#sheet`, and `.sig-actions` stripped from the PDF clone. That test
exists because an unclosed comment added during this work swallowed the
generator's entire script into a comment node — the page still rendered, every
field was still in the markup, and nothing ran.

**Integration, against real PostgreSQL** — the signature suites in
`engineer-certificate.test.ts` and the route on the wire in
`access-boundaries.test.ts`: store and reload, the two boxes separate, a typed
name producing no mark, a non-image refused with nothing stored, signing
before saving refused, signing an unvisited job refused, clear, redraw,
clearing one box not touching the other, stale revision refused with the
current draft attached, an edit clearing and naming what it cleared, an
autosave of the same record keeping the mark, the tenant's name keeping the
engineer's mark and removing the tenant's, no mark crossing to another job,
another engineer refused, a reassigned job losing access, signing issuing
nothing, an unsigned record refused, an unsigned *Received by* not blocking,
and a submitted document left untouched by later signing.

**Browser, signed in, throwaway database, phone width (375px), system Chrome** —
engineer login → assigned job → connected generator → a record with long
landlord and property details, twelve defect entries, eight comment
paragraphs and all six appliance rows → **submit refused because it was not
signed** → pad opened → *Use this signature* disabled on an empty pad, enabled
after drawing, disabled again after *Clear and start again* → engineer signed →
tenant's name typed, engineer's mark still there → tenant signed → **full page
reload**: both marks restored from the server, `localStorage` empty → a reading
changed: both marks cleared with the notice naming them → re-signed → submitted
→ Sign controls hidden → administrator opened the stored PDF through the
existing review screen and received the identical 3,271,178 bytes.

The submitted PDF was extracted from the document store and read. One page,
A4 landscape (841.89 × 595.28pt), all six appliance rows, the *Equipotential
Bonding* outcome printing as ✗, and **both signatures in the correct boxes**,
crisp at full resolution. The long text degrades by scaling rather than
clipping, as it did at the 22 September acceptance.

**Not verified here** — the **Vercel Blob** driver, still. Every document above
went into the local store.

## Still to decide — one question for BSCJ

**When nobody is there to sign, should the certificate say so?** Today the
*Received by* box prints empty, which is what the paper form has always done
and what an unsigned box has always meant. The alternative is printing
something like *Not obtained — nobody present* in the box.

Implemented as: optional, absent, nothing written. That is the honest default
and it changes no wording on the certificate. Making it say something is a
change to the face of a compliance document, so it needs BSCJ's decision
rather than a developer's — and if the answer is yes, the wording has to come
from BSCJ too.

Everything else here is implemented and needs no decision.
