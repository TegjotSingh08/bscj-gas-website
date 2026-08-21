# Address Validation

How the booking form handles a property address, and why it is deliberately
modest about what it can prove.

**Cost: £0.** The one service used charges nothing and needs no account.

---

## What is checked, and what is not

| | Checked | How |
| --- | --- | --- |
| Is this a live UK postcode? | **Yes, hard check** | Postcodes.io |
| Where is it? | **Yes** | Coordinates from Postcodes.io |
| Is it inside our service area? | **Yes** | Distance from the operating centre |
| Does a house exist at that address? | **No** | Nobody free can answer this |

That last row is the important one. There is no free service that can
establish whether a particular house exists within a postcode. The site does
not pretend otherwise, and the customer confirming the assembled address is
the only reliable check on it.

### Why the OpenStreetMap check was removed

An earlier version used Nominatim as a soft confidence signal. Real use showed
it could not do the job: OpenStreetMap tags street *segments* rather than
properties, rarely holds house numbers, and is missing new builds, flats and
private roads entirely. Almost every genuine address graded as "could not
confirm", so the check added a step to the form without adding information.

It was removed along with its cache, its global rate gate, its match grading
and its server-side attestation record.

---

## The flow

```
Postcode
  → validated against Postcodes.io
  → canonical postcode, town and coordinates returned
  → distance from the operating centre decides coverage
  → house number/name and street revealed
  → full address shown back on the review step
  → customer confirms it explicitly
  → booking proceeds
```

The address fields do not appear until the postcode is valid and in area.
There is no point collecting a street for a property nobody will visit.

---

## Service area

A **12 mile radius** measured from a configured operating centre, using the
coordinates Postcodes.io returns for the customer's postcode and a haversine
calculation in `src/lib/address/geo.ts`.

A radius replaced an earlier list of postcode districts because district
boundaries have nothing to do with travel: WV16 shares a prefix with
Wolverhampton and is fifteen miles away, while some DY postcodes are closer
than some WV ones.

### Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `SERVICE_AREA_LAT` | rounded neighbourhood point | Server-side only |
| `SERVICE_AREA_LNG` | rounded neighbourhood point | Server-side only |
| `SERVICE_AREA_RADIUS_MILES` | `12` | |

The centre is stored as **coordinates only**, rounded to three decimal places
— about a 100 metre grid — and deliberately offset so it does not correspond
to any particular building. No street name appears anywhere in the code, and
none of these values has a `NEXT_PUBLIC_` prefix, so none reaches the browser.

**This is a straight-line radius, not a driving distance and not a travel
time.** The site never advertises a journey time.

### Customer experience

- **Valid and inside the radius** → `✓ WV1 1AA · Wolverhampton — we cover this area`
- **Valid but outside** → "This property is outside our standard online booking
  area. We may still be able to help. Call or WhatsApp us and we'll confirm
  availability." The postcode is never called invalid.
- **Not a real postcode** → "We couldn't find that postcode."
- **Provider unavailable** → distinguished from an invalid postcode, with the
  phone offered.
- **Valid but no coordinates returned** → treated as not covered rather than
  waved through, because distance cannot be established.

---

## Caching

Postcode lookups are cached for 24 hours under `postcode:<postcode>`. ONS
updates postcode data quarterly, so a day is comfortably fresh and keeps
traffic off a free public service.

---

## Contact details

Phone and email rules live in `src/lib/booking/contact.ts` and are used by the
form, the Zod schema and the booking route, so the browser and the server can
never disagree.

**Mobile numbers** are shown with a fixed `+44` prefix so nobody types a
country code. Input is forgiving — spaces, brackets, dashes, a leading zero, a
pasted `+44`, `0044`, or none of these — and every accepted form is stored as
`+447XXXXXXXXX`. Landlines are rejected: the field asks for a mobile because
the engineer needs to reach someone on the day. The optional tenant number
follows the same rules when supplied, and blank remains valid.

**Email** is shape-checked and lowercased only. Nothing queries a mailbox,
probes SMTP or sends anything before booking — the aim is to catch a typo, not
to prove an address receives mail.

---

## Security

- Coverage is decided from provider coordinates, never a town name the browser
  sent.
- `/api/book` re-validates the postcode and re-checks the service area itself.
- The address confirmation is required by the schema as a literal `true`, so a
  truthy value like `"yes"` or `1` will not pass.
- Phone and email are normalised again server-side, so the stored value is
  canonical regardless of what the form did.

---

## Replacing this with a paid address provider later

`PostcodeProvider` in `src/lib/address/types.ts` is the only interface
involved. A commercial provider — one that can genuinely list the properties
at a postcode — would:

1. implement a new provider, or a `PremiseLookupProvider` returning candidates;
2. let the customer pick an address instead of typing house and street;
3. keep manual entry as a fallback, because lookup APIs fail and new builds are
   routinely missing.

`PropertyAddress` already carries everything such a provider returns, so the
calendar event, the confirmation email and the confirmation screen would not
change.
