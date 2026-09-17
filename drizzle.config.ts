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
try {
  process.loadEnvFile(".env.local");
} catch {
  // No such file. The environment is expected to be populated already.
}

/**
 * The connection migrations run over.
 *
 * Neon hands out two connection strings for the same database: a **pooled**
 * one, through PgBouncer, and a **direct** one. The application runtime wants
 * the pooled one — every request is a short-lived serverless function, where a
 * connection pool is something to leak rather than something to reuse.
 *
 * Migrations are the opposite shape: one long-lived session running DDL. The
 * pooled endpoint works for this and is what has been used so far, but a
 * transaction pooler does not hold session state, so anything that depends on
 * it — an advisory lock, a session `SET` — can behave differently there.
 *
 * So the direct URL is used when one is configured and the pooled one
 * otherwise. Setting `DATABASE_URL_UNPOOLED` is optional; nothing breaks
 * without it, and Neon's own Vercel integration already emits a variable of
 * that name.
 */
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "";

if (!url) {
  /*
    Fail with something a person can act on. drizzle-kit's own message for an
    empty string names the parameter but not the reason, and the reason is
    almost always that the file was not loaded.
  */
  throw new Error(
    "DATABASE_URL is not set. Add it to .env.local, or export it before running drizzle-kit.",
  );
}

export default {
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
} satisfies Config;
