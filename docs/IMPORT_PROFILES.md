# Agency import profiles

How one importer serves every agency, and what BSCJ has to decide per agency.

**Findings from the first real-world case (Express Properties) are recorded at
the end. Nothing in the code is named after any agency, and no agency-specific
mapping has been finalised** — their actual export has been requested and none
of its headings, contact roles or date meanings are confirmed.

---

## The problem

An agency exports from its own system. The template's fifteen headings are not
what comes out. What does come out, judging by the one screenshot seen so far,
is:

- addresses combined into one cell;
- **two** person-name columns whose roles are not stated;
- phone numbers with no indication of whose;
- dates whose meaning is not stated.

Retyping that into the template, per property, is the manual effort this
removes. Guessing at it is worse than the retyping.

## The shape of the answer

A **profile**: a row of configuration, per agency, recording what BSCJ learned
from looking at the export once. BSCJ writes it from
`/admin/organisations/<id>`; the agency then uploads and the profile is applied.

**One importer, no per-agency code.** Adding an agency is data. A routine
adjustment — a renamed heading, a new column — is an edit on that screen, never
a release. Nothing in `src/` mentions any agency.

Stored in `business_setting` under `portfolio-import-profile:<organisationId>`.
The organisation is *in the key*, so there is no shared row on which a query
could forget a `WHERE`. No new table and no migration: a profile has no
relations, nothing references it, and losing one costs a review rather than any
business record.

## What a profile decides

Four things a heading cannot tell us, each defaulting to the cautious reading:

| Setting | Why it cannot be inferred |
| --- | --- |
| `columns` | Which heading carries which field. |
| `occupierRole` | A second name column may be the tenant, a caretaker or the managing contact. **Default `unknown`, which creates no tenancy** — a tenancy asserts somebody lives there and is who a scheduling link is sent to. The name is kept as an access note instead: visible to the engineer, asserting nothing, contacting nobody. |
| `addressMode` | Whether to trust the combined cell, the separate columns, or whichever exists. |
| `dateOrder` | `uk` (day first) or `iso_only`, which refuses anything else — for an export known to mix conventions. |
| `landlordMatch` | What to do when landlord contact details are missing: hold the row (default), or attach to an existing landlord when **exactly one** of that name exists for this agency. Never creates a landlord, never invents contact details. |

### The one asymmetry, and why

`DEFAULT_PROFILE.occupierRole` is **`tenant`**; `NEW_PROFILE.occupierRole` is
**`unknown`**.

An agency with no profile is using the downloadable template, whose column is
literally headed `tenant_name` and documented as the tenant — the meaning is
not in doubt, and treating it as unconfirmed would silently stop recording
tenancies the importer has always recorded. The doubt arises when BSCJ maps
*another system's* column onto it, which is exactly when a person is looking at
a spreadsheet. So the cautious default lives on the form, not on unconfigured
agencies.

## What is preserved

- **Validation** — rows still go through the same parsers the manual form uses.
  A profile changes which cell feeds which field, never what a valid field is.
- **Agency isolation** — the organisation comes from the session; a file cannot
  name whose profile to load.
- **Duplicate and conflict protection** — unchanged, including the per-address
  unique index and the observed-state fingerprint.
- **Preview before confirmation** — unchanged, and now shows the profile in
  full so the agent can see how their file was read.
- **Importing still sends nothing, creates no job and charges nobody** — held
  by a structural test over the whole import directory.

## A changed profile invalidates an outstanding preview

A preview is a promise about what confirming will write, computed under BSCJ's
reading at that moment. If that reading is corrected in between, confirming the
old preview would write records the agent reviewed under a reading nobody holds
any more.

So `profileDigest` travels **inside the signed envelope** and is compared at
confirmation. A change is a refusal, not a merge, and the agent is told to
upload again. Existing records are never rewritten — a profile applies to
future imports only.

The digest deliberately excludes `notes` and `updatedAt`: a typo fixed in an
internal note changes nothing about the import, and tearing up a live review
over it would be gratuitous.

## Combined addresses

`address-split.ts` turns one cell into the four parts, and **refuses far more
readily than it guesses**. `house_or_name` plus `postcode` is the key the
duplicate check compares on and the unique index enforces, so:

- a flat number lost in the street line silently **merges** two flats;
- a flat number invented from a house number silently **splits** one property.

"Flat 2, 14 Example Street" keeps both identifiers — `Flat 2, 14` — because
"Flat 2" alone is not unique within a postcode and "14" alone is the whole
building. A unit word with no building number (`Flat 2, Example Street`) is
**refused** and shown to a person, because either reading could be wrong.

---

## Findings so far, and what is still open

**From the screenshot only. Nothing below is confirmed.**

1. Combined addresses are common enough to be a first-class mapping, not an
   afterthought. Built and tested.
2. Two person-name columns is the norm, and the second one's role is the single
   most dangerous thing to assume — it decides who receives a scheduling link.
   Hence `occupierRole` defaulting to "no tenancy".
3. An export's own reference column (`Ref`) has no home in our model and is
   simply reported as unused rather than silently dropped.
4. **Landlord contact details may be absent entirely.** This is the open
   blocker — see below.

### Open question for BSCJ

`customer.email` and `customer.phone` are `NOT NULL`, and `property.customer_id`
is `NOT NULL`. So **a property cannot be recorded at all without a landlord
carrying both an email and a phone number.** If an agency's export has no
landlord email, no property from it can be imported, and the only alternatives
are inventing contact details — which we will not do — or holding every row.

Today the importer holds such rows and says precisely why, and
`landlordMatch: match_existing_by_name` recovers the case where the landlord is
already on file. Neither helps a first import of an export that carries no
landlord contact.

Closing it properly needs **migration 0008** relaxing those columns to
nullable, plus requiring the detail at the operation that needs it — issuing an
invoice, releasing a certificate, requesting a remedial — rather than at import.
That preserves payer identity and recipient selection: the landlord record is
still the payer and still the recipient; it simply may not be contactable yet,
and the operations that need to contact them refuse until it is.

**That is a schema change and a business decision, so it has not been made.**
