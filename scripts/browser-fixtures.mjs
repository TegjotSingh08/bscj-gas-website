/**
 * Isolated stand-ins for every external service, installed before Next starts.
 *
 * Preloaded with `node --import`, so it is **not part of the application**: no
 * import of it exists in `src`, nothing references it from a route, and it
 * cannot reach a production bundle. It replaces `globalThis.fetch` for three
 * hosts and passes everything else straight through, which means the code under
 * test is the real code — the real Google client, the real Upstash client, the
 * real hold and lock logic — talking to a fake network.
 *
 * Faked here:
 *
 * - **Google Calendar**, including the OAuth token exchange, free/busy, the
 *   events list, and event create / read / replace / delete. No credential is
 *   ever used and no real calendar is contacted.
 * - **Upstash Redis**, over its REST protocol, backed by a Map with real TTL
 *   semantics — so holds, the daily lock, rate limits and SCAN all behave as
 *   they do in production.
 * - **Resend**, which accepts and discards. No email leaves this machine.
 *
 * Postgres is deliberately *not* faked: it is a local development database
 * with no business rows, and a hand-written stand-in for an ORM would prove
 * something about the stand-in rather than about the application.
 *
 * State is kept in one JSON file rather than in memory, because `next dev`
 * runs the server in a child process and a test asserting on the calendar has
 * to be able to read the same state the request handler wrote. The path comes
 * from `BSCJ_FIXTURE_STATE`.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/*
  Opt-in, explicitly, and never in production.

  This file replaces `globalThis.fetch` for the whole process, which is exactly
  what you want under `--import` in a test run and exactly what you never want
  anywhere else. Being un-importable from `src` is not on its own enough: a
  stray `NODE_OPTIONS` inherited by the wrong process would have installed it
  silently. It now refuses unless it is asked for by name.
*/
if (process.env.NODE_ENV === "production") {
  throw new Error(
    "scripts/browser-fixtures.mjs must never be loaded in production.",
  );
}

if (process.env.BSCJ_TEST_FIXTURES !== "1") {
  console.warn(
    "[fixtures] not installed: set BSCJ_TEST_FIXTURES=1 to stub external services.",
  );
} else {

const realFetch = globalThis.fetch;

const STATE_PATH =
  process.env.BSCJ_FIXTURE_STATE ??
  path.join(os.tmpdir(), "bscj-fixture-state.json");

mkdirSync(path.dirname(STATE_PATH), { recursive: true });

function readState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return {
      events: new Map(Object.entries(raw.events ?? {})),
      store: new Map(Object.entries(raw.store ?? {})),
      log: raw.log ?? [],
    };
  } catch {
    return { events: new Map(), store: new Map(), log: [] };
  }
}

function writeState(state) {
  writeFileSync(
    STATE_PATH,
    JSON.stringify({
      events: Object.fromEntries(state.events),
      store: Object.fromEntries(state.store),
      log: state.log,
    }),
  );
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function eventResource(event) {
  return {
    id: event.id,
    status: event.status,
    summary: event.summary,
    start: { dateTime: event.start, timeZone: "Europe/London" },
    end: { dateTime: event.end, timeZone: "Europe/London" },
    extendedProperties: { private: { bscjBooking: "1" } },
  };
}

function handleCalendar(url, init, state) {
  const { events, log: calendarLog } = state;
  const method = (init?.method ?? "GET").toUpperCase();
  const pathname = url.pathname;

  // freeBusy
  if (pathname.endsWith("/freeBusy")) {
    const body = JSON.parse(init.body);
    const calendarId = body.items[0].id;
    const min = new Date(body.timeMin).getTime();
    const max = new Date(body.timeMax).getTime();

    const busy = [...events.values()]
      .filter((event) => event.status !== "cancelled")
      .filter((event) => {
        const start = new Date(event.start).getTime();
        return start >= min && start <= max;
      })
      .map((event) => ({ start: event.start, end: event.end }));

    return json({ calendars: { [calendarId]: { busy } } });
  }

  const eventsMatch = pathname.match(/\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
  if (!eventsMatch) return json({ error: "unhandled" }, 404);

  const eventId = eventsMatch[2] ? decodeURIComponent(eventsMatch[2]) : null;

  if (!eventId && method === "GET") {
    const min = new Date(url.searchParams.get("timeMin")).getTime();
    const max = new Date(url.searchParams.get("timeMax")).getTime();
    const items = [...events.values()]
      .filter((event) => event.status !== "cancelled")
      .filter((event) => {
        const start = new Date(event.start).getTime();
        return start >= min && start <= max;
      })
      .map(eventResource);
    return json({ items });
  }

  if (!eventId && method === "POST") {
    const body = JSON.parse(init.body);
    if (events.has(body.id)) {
      calendarLog.push({ op: "insert-conflict", id: body.id });
      return json({ error: { code: 409 } }, 409);
    }
    events.set(body.id, {
      id: body.id,
      status: "confirmed",
      summary: body.summary,
      description: body.description,
      start: body.start.dateTime,
      end: body.end.dateTime,
    });
    calendarLog.push({ op: "insert", id: body.id, start: body.start.dateTime });
    return json({ id: body.id, htmlLink: `https://example.invalid/${body.id}` });
  }

  if (eventId && method === "GET") {
    const event = events.get(eventId);
    if (!event) return json({ error: { code: 404 } }, 404);
    return json(eventResource(event));
  }

  if (eventId && method === "PUT") {
    const body = JSON.parse(init.body);
    if (!events.has(eventId)) return json({ error: { code: 404 } }, 404);
    events.set(eventId, {
      id: eventId,
      status: "confirmed",
      summary: body.summary,
      description: body.description,
      start: body.start.dateTime,
      end: body.end.dateTime,
    });
    calendarLog.push({ op: "replace", id: eventId });
    return json(eventResource(events.get(eventId)));
  }

  if (eventId && method === "DELETE") {
    if (!events.has(eventId)) return json({ error: { code: 404 } }, 404);
    events.delete(eventId);
    calendarLog.push({ op: "delete", id: eventId });
    return new Response(null, { status: 204 });
  }

  return json({ error: "unhandled" }, 400);
}

// ---------------------------------------------------------------------------
// Upstash Redis, over its REST protocol
// ---------------------------------------------------------------------------

function live(store, key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry;
}

function redis(parts, store) {
  const command = String(parts[0]).toUpperCase();

  if (command === "SET") {
    const [, key, value, ...rest] = parts;
    const flags = rest.map((part) => String(part).toUpperCase());
    const nx = flags.includes("NX");
    const exAt = flags.indexOf("EX");
    const ttl = exAt === -1 ? null : Number(rest[exAt + 1]);

    if (nx && live(store, key)) return null;
    store.set(key, {
      value: String(value),
      expiresAt: ttl === null ? null : Date.now() + ttl * 1000,
    });
    return "OK";
  }

  if (command === "GET") {
    const entry = live(store, parts[1]);
    return entry ? entry.value : null;
  }

  if (command === "TTL") {
    const entry = live(store, parts[1]);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  if (command === "MGET") {
    return parts.slice(1).map((key) => {
      const entry = live(store, key);
      return entry ? entry.value : null;
    });
  }

  if (command === "SCAN") {
    const matchAt = parts.findIndex((p) => String(p).toUpperCase() === "MATCH");
    const pattern = matchAt === -1 ? "*" : String(parts[matchAt + 1]);
    const regex = new RegExp(
      `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`,
    );
    const keys = [...store.keys()].filter(
      (key) => live(store, key) && regex.test(key),
    );
    return ["0", keys];
  }

  if (command === "EVAL") {
    const script = String(parts[1]);
    const key = String(parts[3]);
    const arg = String(parts[4]);

    // Compare-and-delete.
    if (script.includes("DEL")) {
      const entry = live(store, key);
      if (entry && entry.value === arg) {
        store.delete(key);
        return 1;
      }
      return 0;
    }

    // Increment with a window TTL.
    const entry = live(store, key);
    const next = entry ? Number(entry.value) + 1 : 1;
    store.set(key, {
      value: String(next),
      expiresAt: entry
        ? entry.expiresAt
        : Date.now() + Number(arg) * 1000,
    });
    return next;
  }

  return null;
}

// ---------------------------------------------------------------------------
// The interceptor
// ---------------------------------------------------------------------------

/*
  Matched by the configured host *and* by the real provider's domain. If a
  stray environment file put a live URL in front of this, the request must
  still be intercepted rather than quietly sent to somebody's production store.

  Read per request rather than once at load: this file is preloaded with
  `--import`, so it runs *before* anything that populates the environment, and
  resolving the host eagerly meant Redis calls escaped the interceptor
  entirely in any process that loaded its own env afterwards.
*/
function upstashHost() {
  try {
    return new URL(process.env.UPSTASH_REDIS_REST_URL ?? "").host;
  } catch {
    return null;
  }
}

globalThis.fetch = async function fetchWithFixtures(input, init) {
  const raw = typeof input === "string" ? input : input?.url ?? String(input);
  let url;
  try {
    url = new URL(raw);
  } catch {
    return realFetch(input, init);
  }

  if (url.host === "oauth2.googleapis.com") {
    return json({ access_token: "fixture-token", expires_in: 3600 });
  }

  if (url.host === "www.googleapis.com" && url.pathname.startsWith("/calendar/v3")) {
    const state = readState();
    const response = handleCalendar(url, init, state);
    writeState(state);
    return response;
  }

  const redisHost = upstashHost();
  if (
    (redisHost && url.host === redisHost) ||
    url.host.endsWith(".upstash.io")
  ) {
    const state = readState();
    const parts = JSON.parse(init.body);
    const result = redis(parts, state.store);
    writeState(state);
    return json({ result });
  }

  if (url.host === "api.resend.com") {
    return json({ id: "fixture-email" });
  }

  return realFetch(input, init);
};

console.log("[fixtures] Google Calendar, Upstash and Resend are stubbed in-process.");

} // end of the BSCJ_TEST_FIXTURES guard
