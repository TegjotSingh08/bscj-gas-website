# Email Setup (Booking Confirmations)

When a customer books a CP12, the site sends them a branded confirmation email
with the date, time, property, price and a booking reference.

This is built and tested, but it cannot send anything until you create a Resend
account and add two DNS records. **About 20 minutes**, most of it waiting for
DNS to update.

Until it is done the site still works: bookings complete normally and the
customer sees their details on screen with a note that the email could not be
sent. Nothing breaks.

> ⚠️ **The most important thing on this page:** your domain uses Google
> Workspace for email. Nothing here removes or replaces that. You are **adding**
> records, never editing or deleting your existing `MX` records.

> **Never paste the API key into a chat, a file in this repo, or an email.**

---

## Step 1 — Create a Resend account

1. Go to **https://resend.com** and sign up. The free tier covers 3,000 emails
   a month, which is far more than this site will send.
2. Use `admin@bscj-solutions.com` so the account belongs to the business.

## Step 2 — Add your domain

1. In Resend, go to **Domains → Add Domain**.
2. Enter: `bscj-solutions.com`
3. Region: choose **Ireland (eu-west-1)** so mail is sent from within the EU.
4. Click **Add**.

Resend will show you a list of DNS records to create. Keep that page open.

## Step 3 — Add the DNS records, without touching Google Workspace

Log in wherever your domain's DNS is managed (whoever you bought
`bscj-solutions.com` from).

Resend will typically ask for **three** records:

| Type | Purpose | Notes |
| --- | --- | --- |
| `MX` on a **subdomain** like `send.bscj-solutions.com` | bounce handling | See the warning below |
| `TXT` on `send.bscj-solutions.com` | SPF | Safe to add |
| `TXT` on `resend._domainkey` | DKIM | Safe to add |

### ⚠️ About the MX record

Resend's `MX` record is for a **subdomain** (`send.bscj-solutions.com`), not for
your root domain. Your Google Workspace `MX` records are on the **root**
(`bscj-solutions.com`). They do different jobs and do not conflict.

**Rules:**

- ✅ Add Resend's records **exactly as shown**, on the host it specifies.
- ❌ **Never** delete, edit or replace any existing `MX` record on the root
  domain. Those are what deliver mail to your inbox.
- ❌ If your DNS provider offers to "replace existing records", say no.

If at any point a screen suggests removing your Google records, **stop and ask
me before continuing**.

### About SPF

You may already have an SPF record on the root domain, looking something like
`v=spf1 include:_spf.google.com ~all`.

- If Resend's SPF record is on the **subdomain** (`send.bscj-solutions.com`),
  add it as-is. It does not affect your Google SPF.
- **You may only ever have one SPF record per hostname.** If you find yourself
  about to add a second `TXT` starting `v=spf1` to the *same* host, stop — the
  two must be merged into one instead. Ask me and I will tell you exactly what
  the merged line should be.

### About DMARC

If you have no DMARC record, nothing here requires one and you can skip it.

If you already have one, adding Resend correctly (with SPF and DKIM verified)
keeps you compliant — the mail will be properly authenticated. Do not tighten a
DMARC policy to `p=reject` in the same week you start sending; watch it first.

## Step 4 — Verify

Back in Resend, click **Verify**. It may take a few minutes and occasionally up
to an hour. The domain shows as **Verified** when it is ready.

**While you wait, send a test to your own address** — Resend lets you send to
your own account email before the domain is verified.

## Step 5 — Create an API key

1. In Resend go to **API Keys → Create API Key**.
2. Name: `bscj-website-bookings`
3. Permission: **Sending access** — not full access.
4. Domain: restrict it to `bscj-solutions.com`.
5. Click **Create** and copy the key. **It is shown once.**

## Step 6 — Choose the sending address

Use a purpose-named sender, not a personal address:

```
BSCJ Gas & Heating <bookings@bscj-solutions.com>
```

You do **not** need to create this as a mailbox in Google Workspace — Resend
sends as it, and replies are routed separately (see below).

**Replies** go to `admin@bscj-solutions.com` by default, which is the booking
inbox already recorded in `business-details.md`. To change that, set
`BOOKING_EMAIL_REPLY_TO`. Make sure whatever address you choose is one you
actually read.

## Step 7 — Add the values on your Mac

Add these to `.env.local` — the same file holding the Google and Upstash
values:

```
RESEND_API_KEY=re_your_key_here
BOOKING_EMAIL_FROM=BSCJ Gas & Heating <bookings@bscj-solutions.com>
```

Optional:

```
BOOKING_EMAIL_REPLY_TO=admin@bscj-solutions.com
```

No quotes needed, no spaces around the `=`.

## Step 8 — Restart and test

```bash
npm run dev
```

Then open **http://localhost:3000/book**, make a booking **using your own email
address**, and check your inbox.

- Email arrives → done.
- No email, but the booking completes with an amber note → see Troubleshooting.

**Delete the test booking from Google Calendar afterwards** so it does not block
a real slot.

## Step 9 — Add to Vercel

1. Vercel → your project → **Settings → Environment Variables**
2. Add `RESEND_API_KEY` and `BOOKING_EMAIL_FROM` (and
   `BOOKING_EMAIL_REPLY_TO` if you set one), ticking **Production**,
   **Preview** and **Development**.
3. **Redeploy** — variables only take effect on a new deployment.

---

## Environment variables reference

| Variable | Required | Example |
| --- | --- | --- |
| `RESEND_API_KEY` | Yes, to send | `re_...` |
| `BOOKING_EMAIL_FROM` | Yes, to send | `BSCJ Gas & Heating <bookings@bscj-solutions.com>` |
| `BOOKING_EMAIL_REPLY_TO` | Optional | `admin@bscj-solutions.com` |

All server-side only. None has a `NEXT_PUBLIC_` prefix, so the key can never
reach the browser.

---

## What happens if email fails

The booking is **never** affected. The calendar event is written first, and the
email is attempted afterwards. If Resend is down, rejects the message, or times
out:

- the appointment stays confirmed in Google Calendar
- the customer sees their full details on screen, with an amber note saying the
  email could not be sent
- the server logs only a failure category (for example `rejected`, `timeout`) —
  never the API key, never the customer's details

A customer double-clicking Confirm gets one calendar event and at most one
email.

---

## Troubleshooting

**No email, and the site shows the amber note**

1. Are both variables in `.env.local`, in the project root?
2. Did you restart `npm run dev`?
3. Is the domain **Verified** in Resend? Until it is, you can only send to your
   own account address.
4. Check the terminal running `npm run dev` for a line beginning
   `[booking-email] send failed` — the reason in brackets tells you the
   category:
   - `unauthorised` — the API key is wrong or lacks sending permission
   - `rejected` — usually the domain is not verified, or the From address does
     not match the verified domain
   - `rate_limited` — you have exceeded the plan's send rate
   - `timeout` / `network` — Resend was unreachable

**Email goes to spam**

Normal for the first few sends from a new domain. It settles as reputation
builds. Check SPF and DKIM both show verified in Resend.

**To revoke access**

Delete the API key in Resend. Sending stops immediately and the site falls back
to the amber note. Create a new key and update `.env.local` and Vercel.
