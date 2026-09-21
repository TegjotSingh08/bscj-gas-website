# Acceptance pack — 22 September 2026

**Nothing in here has been pushed, deployed, migrated or sent.** Every file is
fictional. The addresses use `.example.invalid`, which cannot receive mail.

## Do these in this order

The previous version of this pack listed the tests first and the deployment
last, which asked you to test fixes that were not on the pilot yet. Corrected:

1. **Review the release.** `git log d4d3c82..HEAD` and the diff. Nothing is
   pushed, so this is the last point at which rejecting it costs nothing.
2. **Check the migration pre-condition** — §4.1. Read-only, and it is the one
   check that can stop `0009` part-way.
3. **Confirm the target and migrate** — §4.2 to §4.4.
4. **Push, which deploys** — §4.5.
5. **Then** work through §1 to §3. Every expectation in them describes the
   behaviour *after* this release; run them before the deploy and they will
   describe the old behaviour and look like failures.

§5 is the stop conditions and rollback limits. Read it before step 3.

### The short version, in six steps

Each one links to the section that says how. Nothing here has been done for
you: every step below touches something live, and none of them was performed.

| # | Step | Where |
| --- | --- | --- |
| 1 | **Confirm the revision and the target.** The release is the head of `v2-compliance-platform`; the target is the **pilot** project, not the live one. | this section, and §4.2 |
| 2 | **Run the duplicate-active-cycle precheck.** Read-only. It must return no rows, or `0009` will stop part-way. | §4.1 |
| 3 | **Confirm 10 migrations on disk and 9 applied**, with `0009` the only one not applied and nothing differing from disk. | §4.2 |
| 4 | **Apply `0009` and verify** — 10 of 10, still 24 tables and 22 enum types. | §4.3, §4.4 |
| 5 | **Push the branch.** The pilot builds it, so the push is the deploy. Then confirm the cron job is still `*/15 * * * *`. | §4.5 |
| 6 | **Work the supervised acceptance sequence** — the CSV scenarios, the certificate through **Blob**, and the delivery evidence only a real provider can give. | §1, §2, §6 |

**Do not re-run `admin:create`. Do not regenerate `CRON_SECRET`. Do not change
the cron interval.**

---

---

## 0. How this was verified — four separate kinds of evidence

Kept apart deliberately. Conflating them is how a pilot is declared ready and
then does not work.

### Automated, against a real database

`npm run test:integration` — **156 tests** against a real **PostgreSQL 18.4**
started by the test run from `node_modules`, with the real migration chain
`0000`–`0009` applied and real constraints, transactions and independent
connections. `npm test` — **2251** unit tests. Both were run on this release
and both pass.

**Neither touches the development or pilot database.** The harness deletes any
inherited `DATABASE_URL` from its process and refuses any connection string
that is not the throwaway server it started itself.

### Browser, signed in, on that same throwaway database

The real application, driven by clicking. Verified this way:

| | |
| --- | --- |
| Admin saves an agency import profile | persists across a reload |
| Agency uploads a CSV | preview shows held rows, the contactless-landlord consequence, and the identity question |
| Identity answered "same person" | property attaches to the **existing** landlord; two same-name landlords stay unmerged |
| Repeat upload of the same file | 0 to add, already-matching reported |
| Missing-contact policy | "hold the row" holds them; "record without contact" records them with no invented address |
| Renewals due | filters in the query, pages correctly, one row per property **and service** |
| A boiler-service job against a CP12 renewal | correctly **not** shown as covering it |
| Rival agency's portfolio | zero properties; none of the other agency's data |
| Failed message | reason shown, retry pressed, still queued **after a refresh** |
| Mistyped spreadsheet | validation error naming what to fix |
| Renewals at 375px | no horizontal overflow |

Added on this release, signed in as each role against the same throwaway
database, with the real Next server running from a **separate checkout** so
nothing held another process's build directory:

| | |
| --- | --- |
| Engineer screen, upload | the specimen PDF uploaded through the real form; "Uploaded. It is not released until an administrator has reviewed it." |
| The stored file | served back at `/api/documents/<id>` with **200** from the local store |
| Review gate | the release button stays disabled until the PDF has actually been opened |
| Admin release | released through the form with the PDF's own number and dates |
| The renewal | moved to **19 September 2027**, written from the certificate, visible as *due later* on Renewals due |
| Recovery, after the position was removed | Reconciliation listed the certificate, the job's **Update the renewal from this certificate** cleared it, and the list was empty on reload |
| Agency user asking for an admin page | staff sign-in page, with a line saying they are signed in as an agency user and a link to their portal — **it was an infinite redirect loop before this release** |
| Engineer signing in at the staff form | lands on their own day — **they could not sign in at all before this release** |

Two things about that run, stated rather than glossed: the server was
`next dev` (see §6 — a production build refuses the local document store, and
that is the store's rule working, not a workaround), and the PDF was attached
to the real file input programmatically because the browser tool cannot open a
native file dialog. Everything after the attachment — the submit, the review
gate, the release, the recovery — was a real click on the real control.

### Owner-observed, live — **preserved from earlier, still the only live evidence**

On the pilot, 21 September 2026: a tenant **invitation received at 02:30**, the
tenant **booked at 02:39**, the **confirmation received at 02:45**, and the
appointment **visible in the dedicated pilot Google Calendar**. Agency
invitation and password setup also completed. These are the owner's
observations, not mine, and nothing since has re-verified them.

### Not verified by anybody

See §6. In particular **automatic email retries have never run against a real
provider**, and **no real mail client has rendered these templates**.

---

## 1. Fictional CSVs, with the exact settings and expected results

> **Run these after deploying** (step 5 above). They describe the behaviour this
> release introduces.

In `docs/acceptance/csv/`. Upload each at **Portfolio → Import** in the agency
portal. The profile is set by BSCJ at
**Admin → Agencies → *(agency)* → Import settings**.

### Each scenario needs its own starting state

**This is the correction that matters most in this section.** An import is not
idempotent in the way a reader might assume: once file 01 has been confirmed,
its three properties are on file, so uploading it again reports *three rows
already match* rather than *three to be added*. The earlier version of this pack
described every scenario as a fresh three-row import, which is only true the
first time.

So each scenario below is written for a **fresh agency**, and the fastest way to
get one is to make one:

1. **Admin → Agencies → New agency.** Call it after the scenario — *Fixture A
   (01)*, *Fixture B (02a)* and so on. Fictional throughout; nobody is invited
   and no message is sent by creating one.
2. Set that agency's import settings as the scenario says.
3. Invite yourself as its agent, or use an existing pilot agent account moved to
   it, and upload the file.

Where a scenario is run more than once under different settings — file 02 is run
three times — **use a different agency each time**. Re-running against the same
one is a legitimate thing to do, but the expected results are then the
*cumulative* ones, and they are given at the end of §1.2 rather than repeated
per policy.

Nothing here requires deleting records to reset. Making a new fictional agency
is cheaper than unpicking one, and it leaves the evidence of each run intact.

### 1.1 `01-template-ordinary.csv` — the baseline

*Settings: defaults. Nothing to change.*

| Expect | |
| --- | --- |
| Preview | 3 to be added, 0 needing a decision, 0 unreadable |
| Row 2 | tenancy recorded for Tom Tenant |
| Row 3 | **no** tenancy — the column is blank, which means "this file does not say", not "empty" |
| Row 4 | no certificate date; recorded as *not known*, never as compliant |
| Dates | `31/10/2026` reads as **31 October 2026** |
| Confirm | 3 created |
| Press Confirm twice | the second says it was already submitted; still 3 properties |
| Upload the same file again | 3 rows already match; nothing to write |

### 1.2 `02-missing-landlord-contact.csv` — the policy that changed

*Run it three times, changing one setting each time.*

*Run each of (a), (b) and (c) against **its own fresh agency**. Cumulative
expectations for re-running against one agency are at the end.*

**(a) "Hold the row — do not import it"** (the default)

| Expect | |
| --- | --- |
| Preview | 1 to be added, **2 held** under their own heading — *no landlord email address* |
| The held rows | name `landlord_email` and say the setting can be changed |
| Confirm | 1 created. The two held rows wrote nothing at all |

**This is the defect that was fixed.** Before last night the setting was
labelled "hold the row" and never consulted: all three rows were created, two of
them with a landlord nobody could contact.

**(b) "Record the landlord without contact details"**

| Expect | |
| --- | --- |
| Preview | 3 to be added, and a panel saying **2 properties will be recorded with no landlord email address** |
| That panel | explains that the property and its date are recorded normally, and that sending a certificate or issuing an invoice to that landlord will ask for an address first |
| Confirm | 3 created. Landlords carry `null` email — **no address is invented** |
| Row 3 | keeps its phone number and still has no email |

**(c) "Record without contact, and ask about matching names"** — see 1.3.

**If you re-run these against one agency instead**, the expectations are
cumulative and differ:

| Run | Under | Expect |
| --- | --- | --- |
| 1st | hold the row | 1 added, 2 held |
| 2nd | record without contact | **2 added** — the property from run 1 already matches, and only the two previously-held rows are new |
| 3rd | either | **0 added**, 3 already match |

Both readings are correct behaviour. The three-fresh-rows reading is only the
first one.

### 1.3 `03-same-name-distinct-landlords.csv` — identity

*Settings: **Record without contact, and ask about matching names**.*

**Starting state, on a fresh fictional agency.** Add three landlords by hand at
**Portfolio → Landlords → New** before uploading — one called **Ada Fixture**,
and **two** both called **J Smith** — so both branches have something to find.
Give them any fictional email; the file's rows carry none, which is the point.

| Expect | |
| --- | --- |
| The `J Smith` row | **held** — more than one of that name and no email to tell them apart |
| Its message | says to add an email. It does **not** tell you to merge the two records — they may be two people |
| The `Ada Fixture` row | asks **"which landlord is this?"**, with two options and neither preselected |
| Leave it unanswered and confirm | nothing is created; the row is reported as held, with a reason |
| Answer **same person** | the property attaches to the landlord already on file |
| Answer **different person** | a **second** landlord of that name is recorded, with no contact |
| Answer, then come back and answer differently | allowed — a changed answer is a new import, not a blocked repeat |

### 1.4 `04-duplicates-and-dates.csv` — repeats and date conventions

*Settings: defaults, then change **Dates** to "Only YYYY-MM-DD" for the last row.*

| Expect | |
| --- | --- |
| Rows 2 and 3 | same address — row 3 reported as repeated, **not** imported |
| Rows 4 and 5 | `03/04/2027` and `2027-04-03` read as **the same day**, 3 April 2027 |
| With "Only YYYY-MM-DD" | the three day-first rows are refused rather than guessed at; the ISO row still imports |
| If row 2's property is already on file with a different expiry | reported as a difference, **unticked**; confirming without ticking changes nothing |

### 1.5 `05-combined-addresses.csv` — an agency's own export

*Settings: map `Address` → full address, `Owner` → landlord name,
`Owner Email` → landlord email, `Expiry` → certificate expiry; **Addresses** =
"Always the combined column".*

| Expect | |
| --- | --- |
| `Flat 2, 14 Combined Street` | property number reads **`Flat 2, 14`** — both identifiers kept |
| `14 Combined Street` | reads **`14`**, and is a **different** property from the flat |
| `Flat 2, Combined Street` | **refused** — a unit with no building number could be either, and guessing merges or splits real properties |
| `Ref` column | reported as unrecognised and ignored, not silently dropped |
| The preview | shows the profile in force, so the agent can see how their file was read |

---

## 2. The test certificate

`docs/acceptance/TEST-NOT-VALID-certificate.pdf` — one page, a red diagonal
**TEST – NOT VALID** watermark, fictional throughout, and it says on its face
that it certifies nothing. It passes the uploader's checks (2,731 bytes, real
PDF structure) so the upload and review screens can be exercised.

**Do not send it to anybody.**

### What to check with it

1. Upload it against a pilot job. It appears as *awaiting review* — uploading is
   not releasing, and nothing is claimed about it.
2. Release it, entering the certificate number and the two dates **from the
   PDF** (`TEST-NOT-VALID-0001`, inspection 20 September 2026, next due
   19 September 2027).
3. **The new behaviour:** the property's renewal now shows **19 September 2027**.
   Before last night, releasing wrote the certificate and the due date never
   moved.
4. Open **Admin → Renewals due**. The property should have left "no date on
   file".
5. Release a *correction* over it with a different due date. The renewal follows
   the correction; the previous certificate is kept and marked superseded.
6. On a **boiler-service-only** job, releasing a document records **no** CP12
   renewal — there is no certificate for a service, and claiming one would be
   inventing a gas safety check nobody carried out.

---

## 3. Screens to look at

| Screen | What is new |
| --- | --- |
| **Admin → Renewals due** (`/admin/due`) | New. Overdue, due in a range **you choose and it shows back to you**, and properties with no date at all. A property with a job already open says so with its reference, so nobody chases work already in hand. |
| **Admin → Reconciliation** (`/admin/reconcile`) | The message queue is now row-by-row instead of three counts: what it is, which job, how many attempts, what the last reason was in plain words, and a **Try sending it again** button on messages that have genuinely given up. |
| **Admin → Reconciliation**, the renewals section | It now says when it has **not** finished looking. The search over released certificates is bounded so a page render cannot become a full scan; if it stops at that bound it says how many it examined and offers **Continue from here** rather than printing an empty list. A failed read says the records are *unknown*, and "Nothing outstanding." is withheld until every source has actually answered. |
| **Admin → Agencies → Import settings** | The landlord-contact setting now has **three** options, each stating what is recorded and what still refuses afterwards. |
| **Portfolio → Import** preview (agency) | Held rows are separated from unreadable rows; contactless landlords are counted and explained; same-name landlords are asked about. |
| **Admin → job → issued certificate** | New **Update the renewal from this certificate** button. Safe to press at any time. |
| `/letting-agents` | New public page, **off by default**. It answers 404 unless `BSCJ_AGENCY_PAGE=1` is set on the deployment. Read it and decide whether to publish. |

### Preview and evidence paths

| What | Where |
| --- | --- |
| Tenant emails, light and dark, side by side | `previews/index.html` — regenerate with `npm run previews` |
| Tenant invitation | `previews/tenant-invitation.html` and `.txt` |
| Booking confirmation | `previews/tenant-appointment-confirmation.html` and `.txt` |
| Fictional CSVs | `docs/acceptance/csv/` |
| Test certificate | `docs/acceptance/TEST-NOT-VALID-certificate.pdf` |
| Night's progress log | `docs/OVERNIGHT_PROGRESS.md` |

`previews/` is git-ignored and sends nothing — the renderers are pure functions.

**Browser previews are not proof of Outlook rendering.** The emails were checked
in a browser, light and dark, at phone width. No real mail client has seen them.

---

## 4. Deployment and migration order

**Do this before §1 to §3.** Exactly as before, and for the same reason:
**migrate first, then push.**

Migration **0009** (`0009_one_active_cycle_per_service`) is new and applied
nowhere. It is a partial unique index — additive, enforcing only, no column
added or dropped, no data rewritten.

### 4.1 Check nothing already violates it

Run this against the pilot **before** applying. It must return **no rows**:

```sql
SELECT property_id, product_id, count(*)
FROM compliance_cycle
WHERE status = 'active'
GROUP BY property_id, product_id
HAVING count(*) > 1;
```

If it returns any, decide which position is correct and supersede the others by
hand. Do not delete them, and do not let the migration choose.

### 4.2 Confirm the target, read-only

```bash
BSCJ_PILOT=1 npm --prefix /Users/tegjot/Projects/bscj-gas-website run db:status
```

Expect `Mode: pilot`, the confirmed endpoint **matches**, `Migrations on disk :
10`, `Migrations applied : 9`, with `0009_one_active_cycle_per_service` the only
`NOT APPLIED` tag and no `DIFFERS FROM DISK` anywhere. **If `Target` is not the
pilot, stop.**

### 4.3 Apply

```bash
BSCJ_PILOT=1 npm --prefix /Users/tegjot/Projects/bscj-gas-website run db:migrate
```

Silent on success. Read nothing into the silence.

### 4.4 Verify

```bash
BSCJ_PILOT=1 npm --prefix /Users/tegjot/Projects/bscj-gas-website run db:status
```

Expect `10` / `10`, all applied, still **24 tables and 22 enums** — an index is
neither.

### 4.5 Then push

```bash
git push origin v2-compliance-platform
```

The pilot project builds this branch, so the push is the deploy. Afterwards
confirm *Settings → Cron Jobs* still lists `/api/cron/outbox` at `*/15 * * * *`.

**Do not re-run `admin:create`.** **Do not regenerate `CRON_SECRET`.**

---

## 5. Stop conditions and rollback limits

### Stop immediately if

- `db:status` shows a target that is not the pilot, or `DIFFERS FROM DISK`.
- The pre-check in §4.1 returns rows.
- After deploying, an import preview writes anything before Confirm is pressed.
- A tenant, landlord or agency who is not you receives any message.
- A released certificate moves a renewal **backwards** on a property whose
  position came from a later job.

### Rollback limits

**Code rolls back freely.** An Instant Rollback to the previous deployment
restores it, and the older code works against the migrated schema.

**0009 rolls back freely too** — dropping an index removes a guarantee and
touches no data: `drizzle/down/0009_one_active_cycle_per_service.down.sql`.

**0008 does not.** Restoring `NOT NULL` on `customer.email` and `customer.phone`
fails while any landlord has neither, which is the state the migration exists to
allow. The three honest options, in order:

1. **Leave 0008 applied.** A nullable column the code no longer uses is inert.
   This is almost always right.
2. Have the missing details supplied, then reverse it.
3. Remove those customer records — they are landlords, with properties,
   certificates and history hanging off them.

**Never invent an email address or a phone number to satisfy the constraint, and
never delete a business record to make a rollback succeed.**

---

### Publishing `/letting-agents`, when you decide to

It is **not served** until you say so. An earlier note called it "unpublished"
because it carried `noindex` and was absent from the sitemap; that was wrong and
is worth stating plainly — a route that exists is reachable by anyone who types
it the moment it is deployed, and `noindex` is a request to search engines
rather than an access control.

To publish it: set `BSCJ_AGENCY_PAGE=1` on the deployment and redeploy. To take
it down again: remove the variable. When it is genuinely launched, also remove
the `robots` block in the page's metadata and add the route to
`src/app/sitemap.ts` — until both are done it will not be indexed even while it
is being served, which is the right state for a soft launch.

---

## 6. What is still unverified, and by whom

**Now verified automatically against a real database:** the renewals query at
520 properties, the certificate release and correction path including the
version race, the outstanding-renewal rules, the outbox failure-and-recovery
cycle, and the connected workflow from job request to recorded payment.

**Now verified in a browser, signed in:** everything in §0's browser table,
including the whole certificate path and both access boundaries that were
previously asserted only against a lookup table.

**Still not verified, by me or by anybody:**

- **The pilot's own database.** The suites run against a throwaway server and
  must not touch the pilot. Migration `0009` has been applied only there.
- **The Blob document driver.** Certificate upload, review, release and
  recovery are now **browser-verified** (§0) — but against the **local**
  document store. The pilot uses Vercel Blob, which is a live service and was
  not called. Nothing about the screens changes between the two; what is
  unverified is the driver underneath them, and it is the one thing in the
  certificate path that only the pilot can show.

  The earlier note here said the browser run was blocked because `next start`
  forces production and the local store refuses there. Half of that was wrong
  and worth correcting: the Next CLI does honour an already-set `NODE_ENV`.
  The real reason is that a production **build** folds
  `process.env.NODE_ENV === "production"` away at compile time, so the check
  cannot be influenced at run time at all. The harness therefore runs
  `next dev`, which is the only configuration the store permits — the
  safeguard is honoured rather than worked around.
- **Real email delivery.** The transport is captured in every test; Resend has
  never been called from here.
- **Automatic retries against a real provider failure.** A first-attempt
  success exercises none of the retry path, and a failure must not be
  manufactured against live services to close it. **Not claimed.**
- **Outlook, or any real mail client.** The templates were rendered in a
  browser only. **Not claimed.**
- **Live calendar, Blob and Redis behaviour.**

## 7. Owner decisions that actually block real agency use

1. **Business identity** — legal entity, address, VAT position.
   `canIssueInvoices()` refuses until supplied. No invoice can be issued to a
   real agency without it.
2. **Invoice footer wording and payment terms.** Same guard.
3. **Agency pricing figures.** The tiering mechanism exists and carries no
   numbers. `/letting-agents` deliberately quotes none.
4. **Per-agency landlord-contact policy** — hold the row, or record without
   contact? It is now a real choice with real consequences (§1.2).

   **Not a decision to take for Express Properties yet.** The choice only means
   something once their export is understood: whether their landlord emails are
   genuinely absent, or merely in a column nobody has mapped, is exactly what
   the setup call establishes. Deciding first would be guessing at their data.
   The **mechanism** is verified on the fictional agencies in §1.2; the
   **setting** is the last five minutes of the call where you look at their
   file together.
5. **Express Properties' actual export headings, and what their columns mean.**
   Unconfirmed, so their profile is empty and `05-combined-addresses.csv` is an
   illustration of the shape rather than a model of their file. Nothing in the
   code is named after them and nothing needs to be.
6. **Whether `/letting-agents` should be published.** It is written and reviewed
   for unsupported claims. It is held behind a real switch, not merely a robots
   hint — see below.

## 8. Deliberately not built

Named so nobody assumes they exist:

- **Admin-initiated job requests.** Work is requested by the agency from their
  own portal. `/admin/due` links to the agency and to any open job, and says so
  plainly rather than offering a control that would need an impersonation
  system.
- **Reminders, chasing, or any automatic contact about a renewal.** `/admin/due`
  lists and links. It sends nothing.
- **Any renewal threshold or cadence.** "Due soon" is the range the operator
  typed.
