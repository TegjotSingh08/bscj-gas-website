/**
 * The real Next server, against the disposable database, with nothing real
 * behind it.
 *
 * **Why a whole server.** Calling a service function and describing the result
 * as browser verification is exactly the substitution this exists to stop.
 * These tests click the controls an administrator or an agent clicks, so the
 * page, the form, the server action, the session and the database are all the
 * shipping ones.
 *
 * ---
 *
 * **Next must not be able to load a real environment file.** Its own
 * precedence is the guarantee used: a variable already present in the process
 * wins over anything in `.env`, `.env.local` or `.env.production`. So every key
 * the application reads — the whole list in `.env.example` — is set explicitly
 * here before the server starts, to a fictional or deliberately-absent value.
 * There is no key `.env.local` could supply that this does not already occupy.
 *
 * `.env.pilot` is never a Next convention and is not read by anything here.
 *
 * **And it is checked rather than assumed.** After the server is up, the
 * harness signs in as a fixture administrator whose account exists **only in
 * the throwaway database**. If the server had reached any other database, that
 * sign-in would fail — so the first successful login is itself the proof of
 * isolation, rather than a comment claiming it.
 *
 * ---
 *
 * **No authentication bypass.** The fixture accounts carry real password hashes
 * produced by the application's own `hashPassword`, and the tests sign in
 * through the ordinary login form. Nothing here weakens a check, skips a
 * session, or adds a route that production would also have.
 *
 * **Nothing external is reachable.** Google, Redis, Resend and Blob are given
 * values that are either absent or unusable, so the features that depend on
 * them degrade exactly as they would on a deployment that has not configured
 * them — which is a state the application already knows how to be in.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DISPOSABLE_URL } from "./disposable-postgres";

/** A port of its own, so a developer's own `next dev` is never disturbed. */
export const BROWSER_PORT = 3210;
export const BASE_URL = `http://127.0.0.1:${BROWSER_PORT}`;

let server: ChildProcess | null = null;
let documentDir: string | null = null;

/**
 * Every key the application reads, fixed before Next starts.
 *
 * The list is the whole of `.env.example` plus the harness's own two. Anything
 * added to the application later and left out here would be the one key an
 * environment file could still supply, so `configuredKeys` is asserted against
 * `.env.example` in the browser test.
 */
export function isolatedEnvironment(): NodeJS.ProcessEnv {
  documentDir ??= mkdtempSync(path.join(tmpdir(), "bscj-browser-docs-"));

  return {
    ...process.env,

    // The throwaway database, and the flag that lets the app use its driver.
    DATABASE_URL: DISPOSABLE_URL,
    BSCJ_DISPOSABLE_DB: "1",

    /*
      Fictional, and long enough to be accepted. Sessions and import envelopes
      are signed with it; it reaches nothing outside this process.
    */
    AUTH_SECRET: "browser-acceptance-fixture-secret-not-a-real-one",
    SCHEDULING_TOKEN_SECRET: "browser-acceptance-scheduling-secret-not-real",

    // This server, so any link it builds points at itself.
    BSCJ_APP_ORIGIN: BASE_URL,

    /*
      **Deliberately absent.** Each of these makes its feature report itself as
      not configured, which is a state the application already handles and
      which cannot reach anybody: no calendar is read or written, no hold is
      taken, no message is sent, and nothing is uploaded to a real store.
    */
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "",
    GOOGLE_PRIVATE_KEY: "",
    GOOGLE_CALENDAR_ID: "",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
    RESEND_API_KEY: "",
    BOOKING_EMAIL_FROM: "",
    BOOKING_EMAIL_REPLY_TO: "",
    BOOKING_NOTIFICATION_EMAIL: "",
    CRON_SECRET: "",
    BLOB_READ_WRITE_TOKEN: "",

    // A temporary directory, emptied on stop. Never a real store.
    BSCJ_DOCUMENT_STORE: "local",
    BSCJ_DOCUMENT_DIR: documentDir,

    // The agency page stays off, as it is by default everywhere.
    BSCJ_AGENCY_PAGE: "",

    /*
      **Not production, so the local document store will run.**

      That store refuses under `NODE_ENV=production` — correctly, because a
      serverless filesystem is ephemeral — and Blob is the only alternative and
      is a real external service. Without this the release control is disabled
      and the whole document half of the application cannot be exercised.

      `next start` would normally set production itself; setting it here wins,
      because a variable already in the environment is what the process reads.
      Nothing else about the build changes: it is still the compiled output.
    */
    NODE_ENV: "development",
  };
}

/** The keys this harness fixes. Compared against `.env.example` in a test. */
export function configuredKeys(): string[] {
  return Object.keys(isolatedEnvironment()).filter(
    (key) => !(key in process.env) || key === "DATABASE_URL",
  );
}

/**
 * Starts the server and waits for it to answer.
 *
 * `next start` serves the compiled build — the same output a deployment runs —
 * with `NODE_ENV` set to development so the local document store is permitted.
 * See `isolatedEnvironment` for why that is the right trade here.
 *
 * Whatever Next would read from a `.env` file, it does not: an already-present
 * environment variable wins, and `isolatedEnvironment` sets **every** key the
 * application reads. There is no key left for a file to supply, and the
 * fixture-only sign-in is the check that this held.
 */
export async function startServer(): Promise<void> {
  if (server) return;

  server = spawn(
    "npx",
    ["next", "start", "-p", String(BROWSER_PORT), "-H", "127.0.0.1"],
    {
      cwd: process.cwd(),
      env: isolatedEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const logs: string[] = [];
  server.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  server.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/admin/login`, {
        redirect: "manual",
      });
      // Dev compiles the route on first request, so this also warms it.
      if (response.status < 500) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`The server did not start.\n${logs.join("")}`);
}

/** Stops the server and removes its document directory. */
export async function stopServer(): Promise<void> {
  if (server) {
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!server.killed) server.kill("SIGKILL");
    server = null;
  }
  if (documentDir) {
    rmSync(documentDir, { recursive: true, force: true });
    documentDir = null;
  }
}
