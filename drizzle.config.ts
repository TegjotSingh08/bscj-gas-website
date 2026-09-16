import type { Config } from "drizzle-kit";

/**
 * Migrations are generated as plain SQL and committed, never applied by the
 * application at runtime and never pushed straight from a schema diff. On a
 * live system the file is the thing that gets reviewed before it touches
 * production data, so it has to exist and be readable.
 */
export default {
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
} satisfies Config;
