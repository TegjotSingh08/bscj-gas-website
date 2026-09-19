# CP12 generator — integration baseline

A **sanitised copy** of BSCJ's existing gas safety record generator, brought
under version control so the prefill bridge has something stable to target.

**This is a baseline, not the integration.** No bridge exists yet. Opened on
its own, this behaves exactly as the original does, minus the seed data
described below.

## Provenance

Copied on 19 September 2026 from
`~/Gas Cert Generator/GAS CERTS/Generator/`, which is **not in version
control and exists on one machine** — the blocker recorded in
`docs/V2_CURRENT_STATE.md`. The original was treated as read-only: nothing
there was edited, moved or deleted, and it remains the tool BSCJ actually
uses until the bridge lands.

| File | Origin | State |
|---|---|---|
| `index.html` | `Generator/index.html`, 1,048 lines | Copied, then sanitised — see below |
| `lib/html2canvas.min.js` | `Generator/lib/`, 1.4.1 MIT | Byte-identical, `e87e5507…` |
| `lib/jspdf.umd.min.js` | `Generator/lib/` | Byte-identical, `98ccf17a…` |

Those three are the whole application. `index.html` references nothing else —
verified by reading every `src` and `href` in it — so nothing else was copied.

## What was deliberately left behind

- **`GAS CERTS/TEMPLATES/` (five PDFs).** Unused: the generator renders the
  sheet with html2canvas and jsPDF and never opens a template file. Four of
  the five are also pre-branded for two named letting agencies, so they are
  third-party artefacts as well as dead ones.
- **`GAS CERTS/Certificates/`.** Six months of issued certificates for real
  properties. Customer records; never copied.
- **`GAS CERTS/.tools/`** (an OCR helper and its cache) and
  **`.claude/settings.local.json`**. Neither is part of the generator.
- **Saved drafts.** There are none in any file — the draft lives in
  `localStorage` under `gascert_draft_v1` on whichever machine typed it.

## What was changed, and why

Three edits, all removals. Each is commented in place at the point of change.

1. **`defaultEngineer()` emptied.** The original seeds the engineer's personal
   name, the company, its trading address, postcode and telephone number, the
   **Gas Safe registration number** and the **ID card number** directly into
   the source. All are real; the last two identify a registered engineer.
   V2 already treats the business identity as configuration in
   `business_setting`, because the legal entity behind BSCJ is expected to
   change, so that is where the bridge will read them from. Nothing is
   invented here and nothing is hardcoded here.
2. **`defaultLandlords()` emptied.** Two real letting agencies, with trading
   addresses and telephone numbers, shipped as seed data. Third-party
   records; not copied. The landlord book itself is untouched and still
   works — it is simply empty until somebody adds to it.
3. **Two agency identifiers removed from `landlordFolderName()`, and three
   form placeholders rewritten.** The function had four shortcuts naming
   those same agencies, two by book id and two by exact company name. The
   generic branches underneath already produce the same folder from the book
   entry's own label, so nothing was lost.

Nothing else was touched: no behaviour, no layout, no PDF code, and no change
to the appliance table or the renewal arithmetic.

## What it still contains

- **The Gas Safe Register mark**, as a 5 KB embedded JPEG. A third-party
  trade mark, not private data, and one a record issued by a registered
  engineer legitimately carries. It is here because removing it would change
  what the certificate looks like. Its use depends on BSCJ's registration
  remaining current, which is a business fact, not a code one.
- **Two vendored libraries**, unmodified and offline. They are vendored
  rather than installed because the original runs from a local file with no
  build step and no network, and that property is worth keeping until the
  port (step B) makes it moot.

## Behaviour worth knowing before building the bridge

- **The draft format is the prefill contract.** `saveDraft()` walks every
  `input`, `select` and `textarea` inside `#sheet` and writes a flat
  `{ elementId: value }` map; `loadDraft()` reads one back. A prefill payload
  in that exact shape needs no new format and almost no new code.
- **The renewal rule already agrees with the application.** The generator
  computes the next inspection as `+1 year − 1 day` from the signature date,
  which is what `src/lib/compliance/renewal.ts` implements. They were written
  independently and match. The bridge must still not *send* a renewal date —
  see the mapping document.
- **Certificate numbering is manual.** `certNo` is a free-text box with no
  series, no sequence and no validation. Nothing here may invent one.
- **Saving uses the File System Access API**, which needs Chrome or Edge and
  a folder the person picks. Without one it falls back to the browser's
  download folder.

## Where the mapping lives

`docs/CP12_PREFILL_MAPPING.md` — the element-by-element contract for the
bridge, what the application can supply today, and what it cannot.
