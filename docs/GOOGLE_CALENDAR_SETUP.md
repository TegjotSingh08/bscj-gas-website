# Google Calendar Setup

The booking system on `/book` is fully built, but it cannot talk to Google
Calendar until you create a **service account** and share the engineer's
calendar with it. Only you can do this — it needs your Google login.

Until it is done, `/book` shows the fallback screen (alternative booking page,
phone, WhatsApp), so the site still works. Nothing is broken in the meantime.

**Time needed: about 20 minutes. It is all clicking, no code.**

> **Never paste any of these values into a chat, a file in this repo, or an
> email.** They go into Google's own screens and into Vercel's settings page.

---

## What we are setting up, in plain terms

A "service account" is a robot Google account that belongs to the website. You
share the engineer's calendar with that robot, the same way you would share it
with a colleague. The website then reads free/busy times and writes confirmed
appointments — without any customer ever signing in to Google.

The website is only ever granted two permissions:

- read **free/busy** times (start and end times only — never event titles)
- **create events**

---

## Step 1 — Create a Google Cloud project

1. Go to **https://console.cloud.google.com**
2. Sign in with the Google account that owns the engineer's calendar.
3. At the top of the page, click the project dropdown, then **New Project**.
4. Name it `bscj-booking` and click **Create**.
5. Wait for it to finish, then make sure `bscj-booking` is selected in that
   dropdown before continuing.

## Step 2 — Turn on the Calendar API

1. In the search bar at the top, type **Google Calendar API** and open it.
2. Click **Enable**.

## Step 3 — Create the service account

1. In the left menu go to **APIs & Services → Credentials**.
2. Click **Create credentials → Service account**.
3. Service account name: `bscj-website-booking`
4. Click **Create and continue**.
5. When it asks to grant a role, click **Continue** — no role is needed.
6. Click **Done**.

You now have a service account. Its address looks like:

```
bscj-website-booking@bscj-booking.iam.gserviceaccount.com
```

**Copy that address — you need it twice below.**

## Step 4 — Create the key file

1. On the **Credentials** page, click your new service account.
2. Open the **Keys** tab.
3. Click **Add key → Create new key**.
4. Choose **JSON**, then **Create**.

A `.json` file downloads to your Mac. **This file is a password.** Keep it out
of the project folder — put it somewhere like your Documents folder, and delete
it once you have finished Step 6.

Open it in TextEdit and you will see two values we need:

- `"client_email"` — the service account address from Step 3
- `"private_key"` — a long block starting `-----BEGIN PRIVATE KEY-----`

## Step 5 — Share the engineer's calendar with the service account

This is the step people forget. Without it, Google will refuse every request.

1. Go to **https://calendar.google.com**
2. In the left sidebar, hover over the engineer's calendar, click the three
   dots, then **Settings and sharing**.
3. Scroll to **Share with specific people or groups**.
4. Click **Add people and groups**.
5. Paste the service account address from Step 3.
6. Set the permission to **Make changes to events**.
7. Click **Send**.

Then, on the same settings page, scroll to **Integrate calendar** and copy the
**Calendar ID**. For a primary calendar this is usually just the email address
of the calendar's owner.

## Step 6 — Put the values on your Mac for local testing

In the project folder, create a file called `.env.local`. It is already
git-ignored, so it will never be committed.

```
GOOGLE_SERVICE_ACCOUNT_EMAIL=bscj-website-booking@bscj-booking.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvg...\n-----END PRIVATE KEY-----\n"
GOOGLE_CALENDAR_ID=the-calendar-id-from-step-5
```

Notes that matter:

- The private key **must be wrapped in double quotes**.
- Copy it exactly as it appears in the JSON file, including the `\n` sequences.
  Do not press Enter to make real line breaks.
- No spaces around the `=` signs.

Then restart the dev server:

```bash
npm run dev
```

Once that file exists, delete the downloaded `.json` key file from your
Downloads or Documents folder.

## Step 7 — Check it works locally

Open **http://localhost:3000/book**.

- **You see a calendar with dates in orange** — it is working.
- **You still see "We're having trouble loading live availability"** — the
  credentials are not being read. See Troubleshooting below.

Now make a real test booking and check it appears in the engineer's Google
Calendar. **Delete the test booking afterwards** so it does not block a slot.

## Step 8 — Add the same values to Vercel

When you deploy:

1. Open your project on **https://vercel.com**
2. Go to **Settings → Environment Variables**
3. Add all three, ticking **Production**, **Preview** and **Development**:

| Name | Where it comes from |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` in the JSON key file |
| `GOOGLE_PRIVATE_KEY` | `private_key` in the JSON key file |
| `GOOGLE_CALENDAR_ID` | Calendar ID from Step 5 |

4. **Redeploy** — environment variables only take effect on a new deployment.

---

## Environment variables reference

| Variable | Required | Example shape |
| --- | --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Yes | `name@project.iam.gserviceaccount.com` |
| `GOOGLE_PRIVATE_KEY` | Yes | `"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"` |
| `GOOGLE_CALENDAR_ID` | Yes | `engineer@bscj-solutions.com` |

All three are **server-side only**. None has a `NEXT_PUBLIC_` prefix, so none
can ever reach the browser.

---

## Troubleshooting

**"We're having trouble loading live availability"**

Check in this order:

1. Is `.env.local` in the project root, next to `package.json`?
2. Did you restart `npm run dev` after creating it?
3. Is the private key wrapped in double quotes, on one line, with `\n` intact?
4. Did you complete Step 5? Sharing the calendar is the most commonly missed
   step. The service account must have **Make changes to events**.
5. Is the Calendar ID correct? Copy it again from **Integrate calendar**.

**Bookings work but do not appear in the calendar**

You are probably looking at a different calendar from the one in
`GOOGLE_CALENDAR_ID`.

**Everything worked, then stopped**

Check the key has not been deleted in Google Cloud, and that the calendar is
still shared with the service account.

---

## How to revoke or change access

**To revoke immediately:** open the engineer's calendar settings, find the
service account under "Share with specific people", and remove it. The website
loses access at once and falls back to the phone/WhatsApp screen.

**To rotate the key:** create a new JSON key (Step 4), update
`GOOGLE_PRIVATE_KEY` locally and in Vercel, redeploy, then delete the old key
in Google Cloud under **Credentials → your service account → Keys**.

**If a key is ever exposed:** delete it in Google Cloud straight away, then
create a new one. Deleting the key stops it working everywhere immediately.

---

## What the website does with this access

- Reads **free/busy** times only. Event titles, guests and descriptions from
  the engineer's calendar are never requested and never sent to the browser.
- Creates events titled `CP12 — [property address]`, with the customer's
  contact details, appliance count and calculated price in the description.
- Sets no attendees, so **Google does not email the customer**. The website
  never claims that it does. If you want automatic customer emails later, that
  needs domain-wide delegation or a separate email service — see
  `docs/PHASE_2.md`.
