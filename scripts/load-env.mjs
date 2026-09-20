/**
 * The one place a command decides which environment it is running in.
 *
 * Shared by `db-status`, `create-admin` and `drizzle.config.ts`, so the three
 * cannot drift into disagreeing about which database they mean — which is the
 * only way a migration and a bootstrap end up in different places.
 *
 * Two modes, and the difference is deliberate:
 *
 * - **Pilot** (`BSCJ_PILOT=1`) — sealed. `.env.pilot` is the only source.
 *   Inherited `DATABASE_URL*` are *deleted* from the process so nothing
 *   downstream can reach them, `.env.local` is not read at all, and anything
 *   missing or malformed stops the command before a connection is opened.
 * - **Development** — unchanged. `.env.local` is loaded, the ambient
 *   environment wins, and a missing file is not an error.
 */
import { readFileSync } from "node:fs";

/** Scrub anything that looks like a connection string out of a message. */
export function scrub(value) {
  return String(value).replace(/postgres(?:ql)?:\/\/\S+/gi, "<redacted>");
}

export async function loadEnvironment() {
  const { pilotRequested, pilotEnvPath, buildPilotEnv, PILOT_REQUIRED } =
    await import("../src/lib/ops/env-file.ts");

  if (!pilotRequested(process.env)) {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      // No such file. The environment is expected to be populated already.
    }
    return { mode: "development" };
  }

  const path = pilotEnvPath(process.env);

  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Pilot mode is on (BSCJ_PILOT=1) but ${path} could not be read.\n` +
        "  Create it with the pilot connection strings and the confirmed\n" +
        "  endpoint, or unset BSCJ_PILOT to work against development.",
    );
  }

  const { vars } = buildPilotEnv({ text, path, required: PILOT_REQUIRED });

  /*
    **Delete before assigning.**

    A pilot command must not be able to read a development credential that
    happened to be exported in the calling shell. Clearing these first means a
    variable the pilot file does not define is genuinely absent rather than
    quietly inherited — so an incomplete pilot file fails loudly instead of
    half-working against the wrong database.
  */
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("DATABASE_URL")) delete process.env[name];
  }

  for (const [name, value] of Object.entries(vars)) process.env[name] = value;

  return { mode: "pilot", path };
}
