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
| `landlordMatch` | What to do when a landlord has **no email address**. Three genuinely different answers — see "The three answers to a missing landlord email" below. None of them ever invents contact details. |

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

### The blocker, and how it was closed

**`customer.email` and `customer.phone` are now nullable** —
`drizzle/0008_landlord_contact_optional.sql`, prepared 21 September 2026 and
**not yet applied to any database**. `property.customer_id` stays `NOT NULL`: a
property still belongs to an identified owner, and this relaxes what is known
*about* the owner rather than whether there is one.

Before it, a property could not be recorded at all without a landlord carrying
both an email and a phone, so an export with no landlord contact imported
nothing. The only alternatives were inventing contact details — which puts a
fiction in front of a landlord and eventually onto an invoice — or holding
every row.

The requirement moved rather than disappeared: it now sits at the operation
that has to **reach** somebody — issuing a certificate, delivering an invoice,
requesting a remedial — which refuses by name when there is no address for the
recipient it chose. Payer identity and recipient selection are preserved: the
landlord is still the payer and still the recipient; they may simply not be
contactable yet. Issuing an invoice does not require a contact — the number,
the PDF and the payer are all valid without one — so the block lands at
delivery, not at issue.

Applying it is an owner step, and it has to happen **before** the current
commit is deployed: `PILOT_RUNBOOK.md` §2E.

## The three answers to a missing landlord email

Before migration `0008` this setting barely mattered: `customer.email` was
`NOT NULL`, so a contactless landlord could not be recorded however anybody had
configured it. Now it can, so the setting decides — and for a while it did not.

**The defect.** `reject_row` is labelled "hold the row for review — nothing is
written", and the policy was consulted **only on the way into the
name-matching branch**. Once the columns became nullable, a contactless row
under `reject_row` fell straight past it and was created. An agency configured
for "do not import it" was importing it, with a landlord nobody could contact.

There are now three options, each of which does what it says:

| Setting | What happens to a row whose landlord has no email |
| --- | --- |
| `reject_row` *(default)* | **Held.** Nothing is written for that property. The preview names `landlord_email` and says the setting can be changed. The rest of the file still imports. |
| `record_without_contact` | The property, its address and its due date are recorded, and the landlord is recorded with whatever is known. **What is deferred is reaching them**: issuing them an invoice, or sending them a certificate, refuses until an address exists. |
| `match_existing_by_name` | As `record_without_contact`, plus a suggestion when exactly one landlord of that name is on file — see below. |

Two things hold across all three. **No option invents an email address or a
phone number.** And the policy applies only where a landlord would actually be
created: a property the agency already holds is reported as `unchanged` or as a
conflict, never held for an address on a re-upload of a file that is already in.

### Compatibility with profiles saved before this

The profile shape did not change, so `version` stays at **2** and every saved
profile is read back exactly as written. What changed is `reject_row`'s
behaviour, and it changed to match its own label — so an agency configured for
it now writes **less** than it did, never more. That is the safe direction, and
BSCJ moves an agency to `record_without_contact` in one click if holding turns
out not to be what they wanted. A stored value this code does not recognise
still falls back to `reject_row`, the option that writes nothing.

## A name is not an identity

`landlordMatch: match_existing_by_name` recovers the case where a contactless
landlord is already on file. What it may conclude from that is deliberately
narrow.

**Exactly one landlord of that name is a suggestion, not a match.** Two people
genuinely share names, and the second may simply not be recorded yet. So the
preview asks, per row, whether this is the same person or a different one with
the same name, and **an unanswered row is not imported**. Attaching a property
to the wrong Ada Fixture puts it — and eventually an invoice — in front of a
stranger, and nothing downstream would notice.

The mechanics are the existing ones. The suggested landlord's id travels
**inside the signed envelope**, so the browser can accept or decline a
suggestion the preview made and can never name a different landlord; the
agent's answer is read as an allow-list of two values, with anything else
meaning "unanswered"; and `createProperty` re-checks that the landlord belongs
to this agency before attaching anything. The answer is part of the plan
digest, so coming back and answering later is a new import rather than a
blocked repeat.

More than one landlord of the name still **holds the row**, and says to add an
email to it. It does **not** suggest merging the two records: they may be two
people, and merging them on the evidence of a repeated name destroys a record.

## What the preview promises is what the commit writes

A preview is a promise. Two places where it was making one it could not keep
have been closed, both about landlord *details* on a property already held:

- **Neither side has an email.** The preview offered "Landlord details" as
  applicable; the commit had nothing to identify the landlord by and skipped
  it. The agent ticked a box and nothing happened. It is now reported and
  marked not applicable, with the reason said plainly.
- **The file names a different landlord.** The preview correctly refused to
  re-parent the property — and the commit, looking the incoming email up across
  the agency, updated *that other landlord's* name, company and phone anyway.
  A landlord's own record is now only ever updated when the file carries the
  same, non-empty email as the landlord the property already belongs to, and
  the update goes to that owner by id.

Both are the same rule stated twice: an email identifies a person, a name does
not, and neither does "this property happens to be attached to them".
