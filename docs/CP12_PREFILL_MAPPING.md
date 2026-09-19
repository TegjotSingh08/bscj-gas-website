# CP12 prefill bridge — the element mapping

**Nothing here is implemented.** This is the contract the bridge will be
built against, written down first so the decisions are reviewable before any
code depends on them. The baseline it targets is `vendor/cp12-generator/`;
the tool BSCJ actually uses is still the untracked original.

## The contract

`saveDraft()` in the generator walks every `input`, `select` and `textarea`
inside `#sheet` and writes a flat map:

```
{ "<elementId>": "<string>" | <boolean>, … }
```

`loadDraft()` reads one back. **That is the prefill format.** There is no new
schema to design and no parser to write — a payload in this shape is already
something the generator knows how to consume.

The live sheet holds **157 controls**: 31 static fields and 126 appliance
cells (6 rows × 21 columns). The bridge fills **at most 13 of the 31**, and
never an appliance cell.

## What the bridge sends

### The property

| Element | Source | Notes |
|---|---|---|
| `jobAddress` | `property.houseOrName`, `street`, `town` | Joined with newlines — it is a `textarea` |
| `jobPostcode` | `property.postcode` | |
| `jobName` | `tenancy.name`, else `customer.name` | Who is at the property, not who pays |
| `jobTel` | `tenancy.phone`, else `customer.phone` | |

`property.accessNotes` is deliberately **not** sent. It is operational
guidance for getting in — a key-safe location, a dog, a tenant who works
nights — and it has no place on a document handed to a landlord and kept for
two years.

### The landlord or agency

| Element | Source | Notes |
|---|---|---|
| `landlordName` | `customer.name` | The commissioning customer |
| `landlordCompany` | `customer.company`, else `agentOrganisation.name` | |
| `landlordTel` | `customer.phone` | |
| `landlordAddress` | — | **Not available.** See gaps below |
| `landlordPostcode` | `agentOrganisation.billingPostcode`, for agency work only | Null for private work |

### The engineer and the business

| Element | Source | Notes |
|---|---|---|
| `instEngineer` | `app_user.name` of the assigned engineer | See the note below |
| `instCompany` | `business.identity.displayName` | |
| `instAddress` | `business.identity.addressLines` | Joined with newlines |
| `instPostcode` | `business.identity.postcode` | |
| `instTel` | `business.identity.phone` | |
| `instGasSafeReg` | `business.identity.gasSafeNumber` | The business registration |
| `instIdCard` | — | **Not available.** See gaps below |

**On naming the engineer.** `CLAUDE.md` forbids publishing the engineer's
personal name *anywhere customer-facing*. A gas safety record is not a
marketing surface: it is a statutory document that must identify the person
who carried out the inspection, and it already does so today. The rule is
about the website, and sending the name here does not weaken it. The name is
still never rendered on a public page.

**Every one of these is configuration, not code.** `business.identity` is
empty until BSCJ fills it — see the gaps below — and the bridge must send
whatever is there, including nothing. It must never fall back to a value
baked into the source, which is exactly what the baseline removed.

## What the bridge must not send, and why

### The inspection date

`sigDate` is **not sent.** The engineer selects or confirms it, on the day,
in front of the appliance. A date the system asserts on their behalf is a
date nobody checked, on a document that says an inspection happened then.

The generator already works against this: **"New Certificate" pre-fills
`sigDate` with today.** That is a convenience in a tool one person opens on
the day of the visit and a hazard in a bridge that can be opened a week
early. The bridge must leave the field to the engineer, and the port (step B)
should make confirming it an explicit act rather than a default.

### The renewal date

`nextInspection` is **not sent.** The generator derives it from `sigDate` as
`+1 year − 1 day` — which is exactly what `src/lib/compliance/renewal.ts`
implements, independently arrived at and matching. Sending it would activate
a renewal calculation from a date the engineer has not yet confirmed, and
would put two implementations in the same payload. It stays derived, in one
place, after the date is real.

### The certificate number

`certNo` is **not sent.** It is a free-text box with no series, no sequence
and no validation, and BSCJ has not settled a numbering scheme for
certificates. The invoice series is a Postgres sequence and deliberately
separate; nothing may borrow it, and nothing here may invent one.

### Readings, findings, signatures and the verdict

None of these is sent, ever:

- **All 126 appliance cells** — location, type, make, model, flue type,
  operating pressure, high and low combustion ratio / CO / CO₂, ventilation,
  flue condition, flue performance, and the rest.
- `defects`, `labelsIssued`, `comments`
- `coFitted`, `coTested`, `chkEmergency`, `chkTightness`, `chkPipework`,
  `chkBonding` — the six pass/fail checks
- `issuedPrintName`, `receivedPrintName` — the signature block

**A live hazard worth naming.** The generator ticks all six checks
*satisfactory* on a new certificate, and pre-ticks them in the markup. That
is a pass assertion nobody has made yet. The bridge does not touch them, so
it does not make this worse — but it does put the sheet in front of an
engineer more often, and **BSCJ should decide whether those defaults should
start unticked** before the bridge ships. This is a question for BSCJ, not a
change to make unilaterally: it alters what a half-completed record claims.

## Gaps — what BSCJ or a later phase must supply

| Gap | Effect | Where it belongs |
|---|---|---|
| `business.identity` is **empty** | Six installer fields arrive blank; the engineer types them once and saves them as defaults, exactly as today | `business_setting`, from BSCJ |
| The engineer's **Gas Safe ID card number** is stored nowhere | `instIdCard` cannot be prefilled | A column on `app_user`, or per-engineer settings — a schema change, out of scope here |
| No **customer address** is stored | `landlordAddress` cannot be prefilled; `landlordPostcode` only for agency work | `customers` holds name, company, email and phone only. A schema change |
| No **certificate numbering** decision | `certNo` stays manual | A business decision, then a sequence |
| The **original is untracked** | The tool BSCJ uses and the baseline can drift apart | Put `~/Gas Cert Generator/` under version control |

Until the first three are closed the bridge saves the engineer the property,
the landlord and the phone numbers — the retyping that is most error-prone —
and leaves the rest as it is today. That is worth having on its own.

## Getting the payload across

Two requirements shape this: **no customer data in a URL**, and
**authorisation decided on the server against the job**.

### Proposed mechanism

1. **The engineer opens their own job** at `/engineer/jobs/<id>` and presses
   *Prepare certificate*.
2. **The browser requests the payload** from
   `GET /api/engineer/jobs/<id>/cp12-prefill`. The job id is an opaque UUID
   in the path — not customer data, and not a reference. Nothing else is in
   the URL: no name, no address, no postcode, no query string.
3. **The server authorises before it reads.** `requireEngineerOrThrow()` for
   the audience, then `canAccessAssignedJob()` against the row, exactly as
   `work-actions.ts` already does. An engineer who is not on the job gets
   the same answer as one asking about a job that does not exist. **A
   booking reference never authorises anything**, per the V2 rule.
4. **The response is a download**, not a rendered page:
   `Content-Type: application/json`,
   `Content-Disposition: attachment; filename="BSCJ-XXXXXX-prefill.json"`,
   `Cache-Control: no-store`. The payload is the flat id map, containing
   only the ≤13 elements above.
5. **The generator gains an import control** — one file picker, *Import job
   details* — that reads the file and applies it through the same path as
   `loadDraft()`, but **through an allow-list of the mapped element ids**.
   An imported file that names `chkTightness`, `sigDate`, `certNo` or an
   appliance cell has those keys ignored, not applied. The allow-list is the
   enforcement; the server sending a correct payload is not enough, because
   a file on disk can be edited.
6. **It is one-way.** The finished PDF is still saved by the engineer as it
   is today. Upload-back is the next slice, not this one.

### Why a download rather than the alternatives

- **A query string** would put an address and a phone number in browser
  history, in a referrer and in any log the request passes through. Refused
  outright.
- **Clipboard paste** needs no endpoint at all and was tempting, but it
  leaves the payload in the system clipboard for whatever reads it next, and
  it cannot be authorised.
- **`postMessage` from an embedded iframe** is the right answer *after* the
  port (step B), when the generator is served from the same origin. Today it
  is a local file, and a file-origin `postMessage` target is not something to
  build a permission boundary on.

### Handling note

The downloaded file **is customer data at rest** in somebody's downloads
folder. It should be short-lived, and the import control should offer to
discard it. That is a handling decision for BSCJ to confirm, alongside the
unapproved seven-day Redis retention already recorded in §13.6.

## Out of scope for the bridge

Uploading the finished PDF, storing it against the job, exposing it to the
agent, the certificate record itself, invoicing, renewals, and the port of
the generator into the application (step B). Also out of scope: cancellation
and remedial workflows.
