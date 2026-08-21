# Address Validation

How the booking form checks a property address, why it is built this way, and
what has to change when a paid address provider is eventually added.

**Cost: £0.** Neither service used here charges anything or needs an account.

---

## The two layers

They do different jobs and must not be confused with each other.

| | Postcodes.io | Nominatim (OpenStreetMap) |
| --- | --- | --- |
| Role | **Hard validation** | **Soft confidence check** |
| Question answered | Is this a live UK postcode, and where is it? | Does this street plausibly exist at that postcode? |
| Can it block a booking? | **Yes** | **Never** |
| Authoritative? | For postcodes, yes | No |
| Credential needed | None | None |
| Usage limits | None published | Strict — see below |

### Why Postcodes.io is the hard layer

It is built on Royal Mail's Postcode Address File open data via ONS, is free
and open source, requires no key, and answers a narrow question precisely. A
postcode either exists or it does not. That makes it safe to block on.

It returns the **canonical** postcode, which is what gets stored — so
`wv60ar`, `WV6  0AR` and `wv6 0ar` all become `WV6 0AR`.

### Why Nominatim is only a confidence check

OpenStreetMap is community-mapped. It does **not** reliably contain:

- individual house numbers
- new builds
- flats and subdivided properties
- private roads
- recently renamed streets

So "no match" means **"we could not confirm it"**, never "this address is
wrong". A booking is never blocked because OpenStreetMap has not heard of a
property. The customer confirms manually instead.

**This is not a Royal Mail lookup and the site never claims it is.** The
wording shown to customers says the check uses OpenStreetMap data and is "a
helpful check, not an official Royal Mail lookup".

---

## The customer journey

```
Postcode
  → validated against Postcodes.io
  → canonical postcode and town shown back
  → service area checked on the outward code
  → house number/name and street revealed
  → one address check after the address is complete
  → verified, or confirm manually
  → booking continues
```

Address fields do not even appear until the postcode is valid and inside the
service area. There is no point collecting a street for a property nobody is
going to visit.

---

## Service area

Decided on the **outward code** of a validated postcode, never on a town name
someone typed. `SERVICE_AREA_OUTCODES` in `src/lib/address/service-area.ts`.

⚠️ **This list needs owner confirmation.** `business-details.md` names four
towns but no postcodes. The configured list is the standard outward-code
coverage of Wolverhampton, Bilston, Wednesfield and Willenhall:

`WV1 WV2 WV3 WV4 WV5 WV6 WV10 WV11 WV12 WV13 WV14`

Deliberately excluded, despite sharing the WV prefix:

- `WV7`, `WV8`, `WV9` — Albrighton, Codsall, Coven (South Staffordshire)
- `WV15`, `WV16` — Bridgnorth (Shropshire)

Verified live: `WV8 1HW` returns "South Staffordshire" and `WV16 4AA` returns
"Shropshire", so the exclusions are correct.

**Valid postcode** and **inside our area** are kept strictly separate. A
Birmingham postcode is perfectly real; it simply routes to the phone rather
than to instant booking, and the customer is never told their postcode is
wrong.

---

## Nominatim public usage policy

The public Nominatim service runs on donated hardware. Its
[usage policy](https://operations.osmfoundation.org/policies/nominatim/)
is a condition of use, not a suggestion. Every requirement is enforced in
`src/lib/address/nominatim.ts`:

| Requirement | How it is met |
| --- | --- |
| **Max 1 request/second** | A global gate in Redis: `SET nominatim:gate <id> NX EX 1`. Only the caller that takes the key may make a request, so the rate holds across every Vercel instance — not a per-process timer. |
| **No autocomplete** | One request only, after the address is complete. Never per keystroke. |
| **Cache repeated requests** | Identical addresses are answered from Redis for 30 days. |
| **Identify yourself** | `User-Agent: BSCJGasHeating-Booking/1.0 (+https://www.bscj-solutions.com; hello@bscj-solutions.com)` |
| **No bulk geocoding** | The endpoint accepts only a house/name, street and an already-validated in-area postcode. It is not an open proxy. |
| **No automated testing against the service** | The entire test suite uses fakes. No test ever reaches the network. |

**If the gate cannot be taken, no request is made at all.** The customer
confirms manually instead. Losing a convenience is preferable to breaching the
policy of a service given away for free.

The same applies when Redis is unavailable: with no way to coordinate the rate,
the honest response is not to call.

### Attribution

OpenStreetMap data is ODbL licensed and requires attribution. Shown beneath the
address fields, linking to the OpenStreetMap copyright page.

---

## Caching

| Cache | Key | TTL | Why |
| --- | --- | --- | --- |
| Postcode lookups | `postcode:<postcode>` | 24 hours | ONS updates postcode data quarterly, so a day is comfortably fresh and keeps traffic off a free service. |
| Address verification | `addrverify:v2:<hash>` | 30 days | A street does not move. This is the single biggest reduction in traffic to Nominatim. |
| Verification record | `addrattest:<hash>` | 2 hours | Longer than a 30 minute hold plus form filling, short enough not to outlive the booking attempt. |

The verification cache key carries a **match-logic version** (`v2`). Bump it
whenever the rules in `match.ts` change — without it, a logic change stays
invisible for a month on every address already checked. This was learned the
hard way during implementation.

Nothing cached is personal data beyond the property address itself, and
everything expires on its own.

---

## Match quality

Three internal states, in `src/lib/address/match.ts`:

- **verified** — street, exact postcode and house number all agree
- **partial_match** — the street exists in the right postcode district, but the
  exact property could not be confirmed
- **unverified** — no usable match

### Why matching is at district level

The gate is the **outward code** (`WV6`), not the full postcode. Real data
proved this necessary: querying Sweetman Street, WV6 0AR returns segments
tagged `WV6 0AA`, `WV6 0AX` and `WV6 0DN` — all correct for the street, none
equal to the property's postcode. OpenStreetMap tags each street *segment*
with whichever postcode is nearest, not each property.

Requiring exact equality made every genuine address score as unverified, which
would have made the whole layer useless.

Matching is by normalised equality plus a small set of Royal Mail street-type
abbreviations (`St` → `Street`). **No fuzzy distance matching** — approving the
wrong street would send an engineer to the wrong road, which is worse than
asking the customer to confirm.

In practice most real addresses land on **partial_match**, and that is the
honest answer.

---

## Manual confirmation

Anything short of `verified` shows the address back and requires an explicit
tick:

> I confirm this property address is correct.

The wording differs by state — "We found this street, but couldn't confirm the
exact property" reads better than a blanket failure when the street *was*
found — but both require the same confirmation.

---

## Security

The browser is never believed about an address.

- The verification outcome is recorded **server-side** under a hash of the
  address. At booking time the server recomputes that key and reads back its
  own conclusion. A request claiming `"verified"` proves nothing.
- A missing record reads as `unverified`, so it can only ever add friction.
- The postcode is re-validated and the service area re-checked inside
  `/api/book`, not trusted from the form.
- `/api/address/verify` is not an open geocoding proxy: it accepts only a
  house/name, a street and a postcode that has already been confirmed live and
  in-area.

---

## Provider abstraction

```
PostcodeProvider              AddressVerificationProvider
  ├─ PostcodesIoProvider        ├─ NominatimProvider
  └─ FakePostcodeProvider       └─ FakeAddressVerificationProvider
```

No component, route or business rule imports a provider by name except the two
API routes that construct one. Nothing in `types.ts` mentions Postcodes.io,
Nominatim or OpenStreetMap.

### Replacing Nominatim with a paid PAF provider later

1. Write a class implementing `AddressVerificationProvider` (Loqate, Ideal
   Postcodes, getAddress.io all expose enough to do so).
2. Swap the one construction site in `src/app/api/address/verify/route.ts`.
3. Delete the throttle — commercial providers sell capacity, so the global
   one-per-second gate becomes unnecessary.
4. Keep the cache; it saves money rather than politeness.

`PropertyAddress` does not change, so the calendar event, the confirmation
email and the confirmation screen are untouched.

### Adding full premise lookup ("find my address")

A paid provider returns a *list* of properties for a postcode. That is a new
capability rather than a replacement:

- add a `PremiseLookupProvider` returning candidate addresses
- the customer picks one instead of typing house and street
- a picked address arrives already canonical, so it maps to `verified`
- manual entry stays as the fallback — lookup APIs fail, and new builds are
  frequently missing

The `PropertyAddress` shape already carries everything such a provider returns.

---

## Failure behaviour

| Situation | What happens |
| --- | --- |
| Postcode not found | Booking blocked; "We couldn't find that postcode." |
| Postcode malformed | Booking blocked; asked to check it |
| Postcodes.io down | **Not** reported as invalid; "We couldn't verify the postcode right now", with the phone offered |
| Valid but out of area | Not called invalid; routed to phone/WhatsApp |
| Nominatim finds nothing | Manual confirmation. Booking proceeds. |
| Nominatim down or throttled | Manual confirmation. Booking proceeds. |
| Redis unavailable | No Nominatim call at all (rate cannot be coordinated); manual confirmation |
| Postcode edited after checking | Verification invalidated, everything re-checked |
| House or street edited | Verification invalidated, confirmation cleared |
