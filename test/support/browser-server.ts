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
export const BROWSER_PORT = Number(process.env.BSCJ_BROWSER_PORT ?? 3210);
export const BASE_URL = `http://127.0.0.1:${BROWSER_PORT}`;

/**
 * Where the server is run from.
 *
 * **Why this is not simply the repository.** Two things share a checkout's
 * `.next`: a developer's own dev server and this one. The last attempt at a
 * certificate release failed on exactly that — another server held the
 * directory. `BSCJ_BROWSER_CWD` points this harness at a separate checkout of
 * the same revision (a `git worktree`), which also means no `.env.local`,
 * `.env.pilot` or any other ignored file is even present for Next to read.
 *
 * Unset, it is the repository, which is what an ordinary local run wants.
 */
export const SERVER_CWD = process.env.BSCJ_BROWSER_CWD ?? process.cwd();

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

  /*
    Anything inherited that names a database is removed rather than merely
    overridden. `DATABASE_URL_UNPOOLED` is read by drizzle-kit and is only a
    comment in `.env.example`, so the coverage test below would not catch it,
    and an ambient one would be a live connection string inside a harness
    whose whole claim is that it cannot reach one.
  */
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key.startsWith("DATABASE_URL") || key.startsWith("POSTGRES_")) {
      delete inherited[key];
    }
  }

  return {
    ...inherited,

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
      **Development, and it has to be a development *build* to mean anything.**

      The local document store refuses under `NODE_ENV=production` —
      correctly, because a serverless filesystem is ephemeral — and Blob, the
      only alternative, is a real external service. So the document half of
      the application can only be exercised outside production.

      An earlier version of this file claimed that setting the variable here
      was enough under `next start`, "because a variable already in the
      environment is what the process reads". **That is wrong**, and the
      recorded blocker was the consequence. The Next CLI does honour an
      already-set `NODE_ENV`, but by then it is too late: a production build
      has already folded `process.env.NODE_ENV === "production"` away at
      compile time. In `.next/server` the compiled check reads

          "local" == driver ? { ready: false, requirement: "…development-only…" }

      with the comparison gone. The store refuses on a production build
      whatever the environment says.

      Hence `next dev` below. It is the same application, the same pages, the
      same server actions and the same database — compiled for development,
      which is what the store's own rule requires and is therefore honest
      rather than a way around it. Nothing is overridden and no safeguard is
      relaxed.
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
 * **`next dev`, and deliberately so.** The document store the certificate
 * journey needs refuses on a production build — not because of the runtime
 * environment but because the build folds the check away, which is evidenced
 * in `isolatedEnvironment` above. A development build is the only
 * configuration in which the local store is permitted to run, so it is the
 * one used, rather than overriding a safeguard to keep a production build.
 *
 * What that costs is stated plainly: this is not the compiled output a
 * deployment serves. It is the same source, the same routes, the same server
 * actions, the same guards and the same database. The production build is
 * exercised separately by `npm run build`.
 *
 * Whatever Next would read from a `.env` file, it does not: an already-present
 * environment variable wins, and `isolatedEnvironment` sets **every** key the
 * application reads. There is no key left for a file to supply, the separate
 * checkout has no such file anyway, and the fixture-only sign-in is the check
 * that this held.
 */
export async function startServer(): Promise<void> {
  if (server) return;

  server = spawn(
    "npx",
    ["next", "dev", "-p", String(BROWSER_PORT), "-H", "127.0.0.1"],
    {
      cwd: SERVER_CWD,
      env: isolatedEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const logs: string[] = [];
  server.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  server.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  const deadline = Date.now() + 180_000;
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
