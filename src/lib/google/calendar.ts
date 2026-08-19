import "server-only";

import { createHash, createSign } from "node:crypto";

/**
 * Minimal Google Calendar client.
 *
 * Uses a service account: a JWT is signed locally and exchanged for an access
 * token, then the REST API is called with fetch. That avoids pulling the
 * googleapis package (several megabytes) in for the two calls we actually
 * need — free/busy lookup and event creation.
 *
 * Server-only. Credentials never reach the browser.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Least privilege: read free/busy, and write events. Nothing else. */
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export class CalendarNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`Google Calendar is not configured. Missing: ${missing.join(", ")}`);
    this.name = "CalendarNotConfiguredError";
  }
}

export class CalendarApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CalendarApiError";
  }
}

/** Thrown when the deterministic event id already exists — a duplicate click. */
export class DuplicateBookingError extends Error {
  constructor() {
    super("This booking has already been created.");
    this.name = "DuplicateBookingError";
  }
}

type Credentials = {
  clientEmail: string;
  privateKey: string;
  calendarId: string;
};

function readCredentials(): Credentials {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  // Vercel stores newlines escaped, so restore them before signing.
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  const missing: string[] = [];
  if (!clientEmail) missing.push("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  if (!privateKey) missing.push("GOOGLE_PRIVATE_KEY");
  if (!calendarId) missing.push("GOOGLE_CALENDAR_ID");
  if (missing.length) throw new CalendarNotConfiguredError(missing);

  return {
    clientEmail: clientEmail!,
    privateKey: privateKey!,
    calendarId: calendarId!,
  };
}

export function isCalendarConfigured(): boolean {
  try {
    readCredentials();
    return true;
  } catch {
    return false;
  }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(credentials: Credentials): Promise<string> {
  // Re-use the token until a minute before it expires.
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.value;
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    iss: credentials.clientEmail,
    scope: SCOPES,
    aud: TOKEN_ENDPOINT,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };

  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify(claims),
  )}`;

  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(credentials.privateKey);

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64Url(signature)}`,
    }),
  });

  if (!response.ok) {
    // Deliberately does not echo the response body — it can contain key detail.
    throw new CalendarApiError(
      "Could not authenticate with Google Calendar.",
      response.status,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.value;
}

export type BusyPeriod = { start: Date; end: Date };

/**
 * Busy periods on the engineer's calendar. Only start and end times are
 * returned by this endpoint — event titles and details are never exposed.
 */
export async function fetchBusyPeriods(
  timeMin: Date,
  timeMax: Date,
): Promise<BusyPeriod[]> {
  const credentials = readCredentials();
  const token = await getAccessToken(credentials);

  const response = await fetch(`${CALENDAR_API}/freeBusy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: "Europe/London",
      items: [{ id: credentials.calendarId }],
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new CalendarApiError(
      "Could not read availability from Google Calendar.",
      response.status,
    );
  }

  const data = (await response.json()) as {
    calendars?: Record<string, { busy?: { start: string; end: string }[] }>;
  };

  const calendar = data.calendars?.[credentials.calendarId];
  return (calendar?.busy ?? []).map((period) => ({
    start: new Date(period.start),
    end: new Date(period.end),
  }));
}

/**
 * Deterministic event id derived from the slot and the idempotency key, so a
 * repeated submission collides with the existing event instead of creating a
 * second one. Google requires characters in [a-v0-9]; hex satisfies that.
 */
export function buildEventId(slotStartIso: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`${slotStartIso}|${idempotencyKey}`)
    .digest("hex");
  return `bscj${digest}`.slice(0, 60);
}

export type CalendarEventInput = {
  eventId: string;
  summary: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
};

export async function createEvent(input: CalendarEventInput): Promise<{
  id: string;
  htmlLink?: string;
}> {
  const credentials = readCredentials();
  const token = await getAccessToken(credentials);

  const response = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(credentials.calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: input.eventId,
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: { dateTime: input.start.toISOString(), timeZone: "Europe/London" },
        end: { dateTime: input.end.toISOString(), timeZone: "Europe/London" },
        // No attendees: a service account cannot send invitations without
        // domain-wide delegation, and the site must not imply an email was sent.
        reminders: {
          useDefault: false,
          overrides: [{ method: "popup", minutes: 60 }],
        },
      }),
    },
  );

  if (response.status === 409) throw new DuplicateBookingError();

  if (!response.ok) {
    throw new CalendarApiError(
      "Could not create the appointment in Google Calendar.",
      response.status,
    );
  }

  const data = (await response.json()) as { id: string; htmlLink?: string };
  return { id: data.id, htmlLink: data.htmlLink };
}
