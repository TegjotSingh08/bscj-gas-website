# Morning acceptance pack — 22 September 2026

Everything needed to check last night's work, in the order worth doing it.

**Nothing in here has been pushed, deployed, migrated or sent.** Every file is
fictional. The addresses use `.example.invalid`, which cannot receive mail.

---

## 0. The one thing to know first

**No disposable database could be established on this machine** — no Docker, no
Postgres, no embedded engine — and the development and pilot databases are not
disposable. So the verification behind this pack is:

| Level | What it means |
| --- | --- |
| **unit** | A pure function, called directly. |
| **service** | The real production service and server-action code, with the **database and external adapters faked at their boundary**. Permissions, envelope signing, idempotency, recipient selection, ordering and error handling are genuinely exercised. |
| **browser** | A real page rendered and driven. Public pages and email previews only — everything behind sign-in needs a database. |
| **live** | Nothing. |

A service-level pass is **not** proof against Postgres. The unique indexes, the
foreign keys and the real transaction semantics are not exercised anywhere in
this pack, and §6 lists what that leaves for you to check on the pilot.

---

## 1. Fictional CSVs, with the exact settings and expected results

In `docs/acceptance/csv/`. Upload each at **Portfolio → Import** in the agency
portal. The profile is set by BSCJ at
**Admin → Agencies → *(agency)* → Import settings**.

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

### 1.3 `03-same-name-distinct-landlords.csv` — identity

*Settings: **Record without contact, and ask about matching names**.*

Needs one landlord already on file called **Ada Fixture** and **two** called
**J Smith** to exercise both branches. If your portfolio has neither, add them
first, or read this as the description of intended behaviour.

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
| **Admin → Agencies → Import settings** | The landlord-contact setting now has **three** options, each stating what is recorded and what still refuses afterwards. |
| **Portfolio → Import** preview (agency) | Held rows are separated from unreadable rows; contactless landlords are counted and explained; same-name landlords are asked about. |
| **Admin → job → issued certificate** | New **Update the renewal from this certificate** button. Safe to press at any time. |
| `/letting-agents` | New public page, **not published** — `noindex`, not in the sitemap, not linked from the site. Read it and decide. |

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

Exactly as before, and for the same reason: **migrate first, then push.**

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

## 6. What is still unverified, and by whom

Mine to say, and none of it is closed:

- **Anything against a real Postgres.** No disposable database existed. The new
  unique index, the foreign keys and the real transaction semantics have not run.
- **The deployed CSV identity/review/commit journey**, end to end, by you.
- **Automatic outbox retries** against a real provider failure. A first-attempt
  success exercises none of the retry path, and a failure must not be
  manufactured against live services to close it.
- **Actual Outlook and any other real mail client.**
- **Live calendar, Blob and Redis behaviour.**
- **The engineer, document and invoice journeys end to end in the browser** —
  they need a database and a signed-in engineer.

---

## 7. Owner decisions that actually block real agency use

1. **Business identity** — legal entity, address, VAT position.
   `canIssueInvoices()` refuses until supplied. No invoice can be issued to a
   real agency without it.
2. **Invoice footer wording and payment terms.** Same guard.
3. **Agency pricing figures.** The tiering mechanism exists and carries no
   numbers. `/letting-agents` deliberately quotes none.
4. **Per-agency landlord-contact policy** — hold the row, or record without
   contact? It is now a real choice with real consequences (§1.2). Express
   Properties needs one before their first upload.
5. **Express Properties' actual export headings.** Still unconfirmed, so their
   profile is empty and `05-combined-addresses.csv` is illustrative.
6. **Whether `/letting-agents` should be published.** It is written, reviewed
   for unsupported claims, and held back behind `noindex`.

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
