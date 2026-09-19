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
  // A plain field rather than a constructor parameter property: Node's
  // type-stripping cannot parse the latter, and this module is unit tested.
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CalendarApiError";
    this.status = status;
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

  // Backdated slightly: Google rejects an assertion whose iat is in the future,
  // and a serverless host's clock can sit a second or two ahead. The lifetime
  // stays within the one hour Google allows.
  const CLOCK_SKEW_SECONDS = 30;
  const issuedAt = Math.floor(Date.now() / 1000) - CLOCK_SKEW_SECONDS;
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

  return parseFreeBusyResponse(await response.json(), credentials.calendarId);
}

export type FreeBusyResponse = {
  calendars?: Record<
    string,
    {
      busy?: { start: string; end: string }[];
      errors?: { domain?: string; reason?: string }[];
    }
  >;
};

/**
 * Turns a free/busy response into busy periods, failing closed.
 *
 * This must never return an empty array when the truth is unknown. Google
 * answers HTTP 200 even when it could not read the calendar — access revoked,
 * wrong calendar id — and puts the reason in an `errors` array with `busy`
 * absent. Reading that as "no busy periods" would make the site offer every
 * slot on a diary it cannot see, and the pre-write re-check in /api/book uses
 * this same function, so the safety net would fail with it. An unreadable
 * calendar is an error, not a free one.
 *
 * Exported for testing.
 */
export function parseFreeBusyResponse(
  data: FreeBusyResponse,
  calendarId: string,
): BusyPeriod[] {
  const calendars = data.calendars;
  if (!calendars) {
    throw new CalendarApiError("Google Calendar returned no availability.", 502);
  }

  let entry = calendars[calendarId];
  if (!entry) {
    // Google may normalise the key it echoes back. Exactly one calendar is
    // ever requested, so a single returned entry is unambiguous.
    const keys = Object.keys(calendars);
    if (keys.length === 1) entry = calendars[keys[0]];
  }

  if (!entry) {
    throw new CalendarApiError(
      "Google Calendar returned no availability for the configured calendar.",
      502,
    );
  }

  // Reason codes are not echoed back: they can name the calendar.
  if (entry.errors?.length) {
    throw new CalendarApiError(
      "Google Calendar could not read the configured calendar.",
      403,
    );
  }

  if (!Array.isArray(entry.busy)) {
    throw new CalendarApiError(
      "Google Calendar returned an unreadable availability response.",
      502,
    );
  }

  return entry.busy.map((period) => {
    const start = new Date(period.start);
    const end = new Date(period.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      // An unparseable period would silently behave as free time.
      throw new CalendarApiError(
        "Google Calendar returned an unreadable busy period.",
        502,
      );
    }
    return { start, end };
  });
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

/**
 * Marks an event as a customer booking taken through this website.
 *
 * The daily cap counts customers, not diary entries, and free/busy cannot tell
 * them apart — it returns start and end times and nothing else, by design. So
 * the count comes from the events API, and an event is ours when it carries
 * this private extended property.
 *
 * Ids are accepted as a second signal because every event this site has ever
 * written was given a deterministic id beginning with `bscj` (see
 * `buildEventId`), including the bookings already sitting in the live calendar
 * from before this property existed. Either signal is enough.
 *
 * "Private" here is Google's term for "visible only to this calendar" — it is
 * not customer data. It carries no name, address or reference.
 */
export const BOOKING_MARKER_KEY = "bscjBooking";
export const BOOKING_MARKER_VALUE = "1";

/** The id prefix every booking this site writes has always carried. */
const BOOKING_ID_PREFIX = "bscj";

/** A confirmed customer booking, reduced to what the daily cap needs. */
export type BookingEvent = { id: string; start: Date };

type CalendarEventItem = {
  id?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
};

/** Whether a calendar entry is one of our customer bookings. */
export function isBookingEvent(item: CalendarEventItem): boolean {
  if (item.status === "cancelled") return false;
  if (item.extendedProperties?.private?.[BOOKING_MARKER_KEY] === BOOKING_MARKER_VALUE) {
    return true;
  }
  return typeof item.id === "string" && item.id.startsWith(BOOKING_ID_PREFIX);
}

/**
 * Turns an events response into customer bookings, failing closed.
 *
 * An unreadable response must never be read as "no bookings yet": that is the
 * direction that lets the daily cap be exceeded. Anything unexpected raises
 * rather than returning an empty list. All-day entries are skipped — a booking
 * always has a dateTime, so one without is not ours.
 *
 * Exported for testing.
 */
export function parseBookingEvents(data: { items?: unknown }): BookingEvent[] {
  const items = data.items;
  if (items === undefined) return [];
  if (!Array.isArray(items)) {
    throw new CalendarApiError("Google Calendar returned an unreadable event list.", 502);
  }

  const bookings: BookingEvent[] = [];
  for (const raw of items as CalendarEventItem[]) {
    if (!isBookingEvent(raw)) continue;

    const dateTime = raw.start?.dateTime;
    if (!dateTime) continue;

    const start = new Date(dateTime);
    if (Number.isNaN(start.getTime())) {
      throw new CalendarApiError("Google Calendar returned an unreadable booking time.", 502);
    }
    bookings.push({ id: raw.id ?? "", start });
  }
  return bookings;
}

/**
 * Customer bookings in a window, for the daily cap.
 *
 * Separate from `fetchBusyPeriods` on purpose, because they answer different
 * questions. Free/busy answers "is this time occupied", and must include the
 * school run and everything else on the diary. This answers "how many
 * customers has BSCJ taken that day", and must include only bookings.
 *
 * Recurrences are expanded and cancellations excluded by the request itself.
 * Paging is followed rather than truncated: a short read would undercount, and
 * undercounting is what lets an eleventh booking through.
 */
export async function fetchBookingEvents(
  timeMin: Date,
  timeMax: Date,
): Promise<BookingEvent[]> {
  const credentials = readCredentials();
  const token = await getAccessToken(credentials);

  const bookings: BookingEvent[] = [];
  let pageToken: string | undefined;
  // Bounded so a malformed paging response cannot spin forever.
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      showDeleted: "false",
      maxResults: "2500",
      fields: "items(id,status,start,extendedProperties),nextPageToken",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(credentials.calendarId)}/events?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      },
    );

    if (!response.ok) {
      throw new CalendarApiError(
        "Could not read existing bookings from Google Calendar.",
        response.status,
      );
    }

    const data = (await response.json()) as {
      items?: unknown;
      nextPageToken?: string;
    };
    bookings.push(...parseBookingEvents(data));

    if (!data.nextPageToken) return bookings;
    pageToken = data.nextPageToken;
  }
  return bookings;
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
        // Marks this as a customer booking, so the daily cap can count
        // customers without mistaking the engineer's own diary for them.
        extendedProperties: {
          private: { [BOOKING_MARKER_KEY]: BOOKING_MARKER_VALUE },
        },
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

// ---------------------------------------------------------------------------
// Reading back, replacing and removing — what reconciliation needs
// ---------------------------------------------------------------------------

/**
 * An event as Google currently holds it, reduced to what a decision needs.
 *
 * `status` is carried deliberately. Google keeps a cancelled event under its
 * id, so "the id exists" and "the appointment exists" are different facts, and
 * code that conflates them marks a job synced against an event nobody will
 * ever attend.
 */
export type CalendarEventSnapshot = {
  id: string;
  /** "confirmed", "tentative" or "cancelled". */
  status: string;
  start: Date | null;
  end: Date | null;
  /** Whether it carries our booking marker, or our id prefix. */
  isBooking: boolean;
};

function parseEventTime(value?: { dateTime?: string; date?: string }): Date | null {
  const raw = value?.dateTime;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * One event by id, or null when Google has never heard of it.
 *
 * A 404 is a real answer — "there is nothing here" — so it comes back as null
 * rather than as an error. Every other failure raises, because "we could not
 * ask" must never be read as "it is not there".
 */
export async function fetchEvent(
  eventId: string,
): Promise<CalendarEventSnapshot | null> {
  const credentials = readCredentials();
  const token = await getAccessToken(credentials);

  const response = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(credentials.calendarId)}/events/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );

  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) {
    throw new CalendarApiError(
      "Could not read the appointment from Google Calendar.",
      response.status,
    );
  }

  const item = (await response.json()) as CalendarEventItem & {
    end?: { dateTime?: string; date?: string };
  };

  return {
    id: item.id ?? eventId,
    status: item.status ?? "confirmed",
    start: parseEventTime(item.start),
    end: parseEventTime(item.end),
    // `isBookingEvent` refuses a cancelled entry, which is right for counting
    // and wrong here: this asks whose event it is, not whether it is live.
    isBooking: isBookingEvent({ ...item, status: "confirmed" }),
  };
}

/**
 * Whether an existing event is the appointment we meant to create.
 *
 * Identity, window and liveness, all three. An id collision on a *different*
 * appointment is the case this is really for: the id is derived from the job
 * and the slot, so a job that moves away from a time and later moves back
 * produces the same id twice, and the event sitting there may be the cancelled
 * remains of the first visit rather than the second.
 */
export function eventMatchesAppointment(
  snapshot: CalendarEventSnapshot,
  expected: { start: Date; end: Date },
): boolean {
  if (snapshot.status === "cancelled") return false;
  if (!snapshot.isBooking) return false;
  if (!snapshot.start || !snapshot.end) return false;
  return (
    snapshot.start.getTime() === expected.start.getTime() &&
    snapshot.end.getTime() === expected.end.getTime()
  );
}

/**
 * Writes an event at a known id, whatever is there now.
 *
 * The recovery half of `createEvent`. A 409 from an insert means the id is
 * taken — by an identical event, by a cancelled one, or by the remains of an
 * appointment that has since moved — and the only way to end up with one
 * correct live event under that id is to overwrite it. `status: "confirmed"`
 * is explicit because reviving a cancelled entry is precisely what this is
 * for.
 *
 * Returns "absent" when Google has forgotten the id entirely, so the caller
 * can insert instead rather than treating a 404 as a failure.
 */
export async function replaceEvent(
  input: CalendarEventInput,
): Promise<"replaced" | "absent"> {
  const credentials = readCredentials();
  const token = await getAccessToken(credentials);

  const response = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(credentials.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: input.eventId,
        status: "confirmed",
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: { dateTime: input.start.toISOString(), timeZone: "Europe/London" },
        end: { dateTime: input.end.toISOString(), timeZone: "Europe/London" },
        extendedProperties: {
          private: { [BOOKING_MARKER_KEY]: BOOKING_MARKER_VALUE },
        },
        reminders: {
          useDefault: false,
          overrides: [{ method: "popup", minutes: 60 }],
        },
      }),
    },
  );

  if (response.status === 404 || response.status === 410) return "absent";
  if (!response.ok) {
    throw new CalendarApiError(
      "Could not update the appointment in Google Calendar.",
      response.status,
    );
  }
  return "replaced";
}

/**
 * Removes an event.
 *
 * "Already gone" is success, not failure — the caller's goal is that the event
 * is not there, and a cleanup that has to be retried must be able to finish
 * even when a previous attempt half-succeeded before dying. Anything else
 * raises, so the outstanding work stays on the queue.
 */
export async function deleteEvent(
  eventId: string,
): Promise<"deleted" | "absent"> {
  const credentials = readCredentials();
  const token = await getAccessToken(credentials);

  const response = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(credentials.calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (response.status === 404 || response.status === 410) return "absent";
  // Google answers 204 on success and 410 when it was already cancelled.
  if (!response.ok) {
    throw new CalendarApiError(
      "Could not remove the appointment from Google Calendar.",
      response.status,
    );
  }
  return "deleted";
}
