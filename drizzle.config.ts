import type { Config } from "drizzle-kit";

/**
 * Migrations are generated as plain SQL and committed, never applied by the
 * application at runtime and never pushed straight from a schema diff. On a
 * live system the file is the thing that gets reviewed before it touches
 * production data, so it has to exist and be readable.
 */

/**
 * Load `.env.local`, the way `next dev` already does.
 *
 * drizzle-kit is a plain CLI: it does not know about Next.js conventions and
 * reads nothing but the ambient environment. Without this, running
 * `npm run db:migrate` in a fresh shell hands drizzle-kit an empty connection
 * string and it reports `[x] url: ''` — which reads like a configuration
 * error rather than what it is, an unloaded file.
 *
 * `process.loadEnvFile` is built into Node (20.12+), so this needs no dotenv
 * dependency. **A variable already set in the real environment wins**, which
 * is the behaviour CI and production need: a deploy passes `DATABASE_URL` in
 * for real and must never be overridden by a file that happens to be lying
 * around.
 *
 * A missing file is not an error. On a deployment there is no `.env.local`,
 * and the environment is already populated.
 */
import { readFileSync } from "node:fs";

import { buildPilotEnv, PILOT_REQUIRED, pilotEnvPath, pilotRequested } from "./src/lib/ops/env-file";
import { assertConfirmedEndpoint, resolveTarget } from "./src/lib/ops/db-target";

/**
 * Which environment this migration run belongs to.
 *
 * The same two modes the other commands use, from the same modules, because
 * a migration and a bootstrap disagreeing about which database they mean is
 * the one failure none of this can recover from.
 *
 * - **Pilot** (`BSCJ_PILOT=1`) — sealed. `.env.pilot` is the only source,
 *   inherited `DATABASE_URL*` are cleared first so nothing can be quietly
 *   supplied by the calling shell, and anything missing or malformed throws
 *   before drizzle-kit opens a connection.
 * - **Development** — unchanged: `.env.local` is loaded, the ambient
 *   environment wins, a missing file is not an error.
 */
if (pilotRequested(process.env)) {
  const path = pilotEnvPath(process.env);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Pilot mode is on (BSCJ_PILOT=1) but ${path} could not be read.`,
    );
  }

  const { vars } = buildPilotEnv({ text, path, required: PILOT_REQUIRED });

  for (const name of Object.keys(process.env)) {
    if (name.startsWith("DATABASE_URL")) delete process.env[name];
  }
  for (const [name, value] of Object.entries(vars)) process.env[name] = value;
} else {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No such file. The environment is expected to be populated already.
  }
}

/**
 * The connection migrations run over.
 *
 * Neon hands out two connection strings for the same database: a **pooled**
 * one through PgBouncer, and a **direct** one. The application runtime wants
 * the pooled one — every request is a short-lived serverless function, where
 * a pool is something to leak rather than reuse. Migrations are the opposite
 * shape: one long-lived session running DDL, which wants the direct endpoint.
 *
 * `resolveTarget` applies that preference and **refuses outright** if the two
 * name different databases, so migrations and the application cannot end up
 * pointed at different places. In pilot mode the target is additionally
 * checked against an endpoint confirmed outside this file, because two copies
 * of the same wrong connection string agree perfectly.
 */
const target = resolveTarget(process.env);

if (pilotRequested(process.env)) {
  assertConfirmedEndpoint(target, process.env.BSCJ_PILOT_ENDPOINT);
}

export default {
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: target.url },
  strict: true,
  verbose: true,
} satisfies Config;
