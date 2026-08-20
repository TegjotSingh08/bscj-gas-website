# Redis Setup (Appointment Holds)

When a customer picks an appointment time, we reserve it for them for 30
minutes while they fill in the rest of the form. That reservation has to be
shared across every Vercel server instance, so it lives in a small Redis
database rather than in the website's memory.

**This is free to set up and takes about 10 minutes.** All clicking, no code.

Until it is done the site still works — see "What happens without it" at the
bottom — but two customers can reach the confirm step on the same slot, and
one of them gets turned away at the last moment.

> **Never paste these values into a chat, a file in this repo, or an email.**
> They go into Upstash's own screens and into Vercel's settings page.

---

## Why Upstash

It is billed per request rather than per hour, has a free tier that comfortably
covers a booking site of this size, and it speaks HTTP rather than requiring a
persistent connection — which is what makes it work properly on Vercel, where
each request may run on a different short-lived server.

The code depends on a small internal interface, not on Upstash specifically, so
a different Redis provider could be swapped in later without touching the
booking logic.

---

## Step 1 — Create the database

1. Go to **https://console.upstash.com** and sign in. You can sign in with the
   Google account you already use — it does not need to be the engineer's
   calendar account.
2. Click **Create Database**.
3. Name it `bscj-booking-holds`.
4. **Primary Region: choose one in Europe** — `eu-west-1` (Ireland) or
   `eu-west-2` (London). This matters: a database in the US adds delay to every
   availability check.
5. Leave the other options at their defaults and click **Create**.

## Step 2 — Copy the two values

On the database page, scroll to **REST API** and find:

- `UPSTASH_REDIS_REST_URL` — looks like `https://eu1-xxx-12345.upstash.io`
- `UPSTASH_REDIS_REST_TOKEN` — a long string

There is a copy button next to each. **The token is a password.**

Make sure you are copying the **REST API** values, not the `redis://`
connection string further up the page — that one will not work here.

## Step 3 — Add them on your Mac

Open `.env.local` in the project folder — the same file that already holds the
Google values — and add these two lines at the end:

```
UPSTASH_REDIS_REST_URL=https://eu1-xxx-12345.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token-here
```

No quotes needed, and no spaces around the `=`.

Then restart the dev server:

```bash
npm run dev
```

## Step 4 — Check it works

Open **http://localhost:3000/book**, pick a date, then pick a time.

You should see a green bar reading:

> This appointment is reserved for you for 30 minutes. — with a countdown
> ticking down from `29:59`

If you get through to the details step but see **no green bar**, Redis is not
being read. Check the two lines in `.env.local` and that you restarted the
server.

## Step 5 — Add them to Vercel

1. Open the project on **https://vercel.com**
2. **Settings → Environment Variables**
3. Add both, ticking **Production**, **Preview** and **Development**:

| Name | Where it comes from |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | Upstash database page, REST API section |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash database page, REST API section |

4. **Redeploy** — environment variables only take effect on a new deployment.

---

## Environment variables reference

| Variable | Required | Example shape |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` | For holds | `https://eu1-name-12345.upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | For holds | long opaque string |

Both are **server-side only**. Neither has a `NEXT_PUBLIC_` prefix, so neither
can reach the browser.

---

## What is actually stored

Almost nothing, and no personal data at all.

| Key | Value | Lives for |
| --- | --- | --- |
| `booking-hold:<appointment time>` | a random id | 30 minutes |
| `booking-done:<attempt id>` | a calendar event id | 1 hour |
| `rate:<...>` | a request count | 1–10 minutes |

No names, no addresses, no phone numbers, no email addresses. Everything
expires on its own — there is nothing to clean up and nothing to delete under
data protection rules.

---

## What happens without it

The site does **not** break. Holds are skipped, and booking falls back to the
rule that applied before this feature: whoever confirms first gets the slot,
decided by Google Calendar. The second person is told the appointment has just
been taken.

The same applies if Upstash has an outage. The system never treats a failure to
reach Redis as evidence that a slot is free, and the Google Calendar check
before writing any appointment is never skipped.

Rate limiting also falls back to counting per server instance, which is weaker
than counting globally but still limits abuse.

---

## Troubleshooting

**No green reservation bar appears**

1. Are both lines in `.env.local`, in the project root next to `package.json`?
2. Did you restart `npm run dev` afterwards?
3. Did you copy the **REST API** values rather than the `redis://` string?

**Everything is slow**

Check the database region is in Europe. A US region adds noticeable delay to
every availability check.

**To revoke access**

In the Upstash console, open the database, go to **REST API**, and reset the
token. Update the value locally and in Vercel, then redeploy. The old token
stops working immediately.
