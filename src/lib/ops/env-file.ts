/**
 * Loading pilot credentials, and refusing to guess.
 *
 * Pure: it parses text and decides. The caller does the file reading, so this
 * is testable without a fixture on disk and cannot be surprised by one.
 *
 * **Pilot mode is sealed.** The point of a separate pilot is that it is
 * separate, so when it is active the pilot file is the *only* source: nothing
 * is inherited from the shell, nothing is read from `.env.local`, and a value
 * the file does not supply is a stop rather than a fallback. A pilot command
 * that half-worked because a development variable was lying around in the
 * environment is the exact failure this prevents.
 *
 * Outside pilot mode nothing changes: development keeps loading `.env.local`
 * with the ambient environment winning, which is what CI and a deploy need.
 */

export class EnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvFileError";
  }
}

/**
 * A dotenv parser that reports what it cannot read.
 *
 * `process.loadEnvFile` is fine for a development file somebody wrote by hand
 * and can see. It is the wrong tool here for two reasons: it writes straight
 * into `process.env`, which is precisely what pilot mode must not do, and it
 * is silent about a line it does not understand — so a mistyped credential
 * becomes a missing variable, and a missing variable becomes a fallback.
 *
 * Handles what a real file contains: comments, blank lines, `export `
 * prefixes, single and double quotes, escapes inside double quotes, and `#`
 * inside a quoted value. A `#` after an unquoted value starts a comment,
 * which is why a connection string with a fragment must be quoted — and why
 * an unquoted value containing shell metacharacters is safe here in a way it
 * is not when sourced by a shell.
 */
export function parseEnvFile(text: string, label = "env file"): Map<string, string> {
  const found = new Map<string, string>();
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;

    const eq = withoutExport.indexOf("=");
    if (eq <= 0) {
      throw new EnvFileError(
        `${label} line ${i + 1} is not NAME=value: ${redactLine(withoutExport)}`,
      );
    }

    const name = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new EnvFileError(`${label} line ${i + 1} has an invalid name "${name}".`);
    }

    const rest = withoutExport.slice(eq + 1).trim();
    found.set(name, readValue(rest, i + 1, label));
  }

  return found;
}

/** Never echo a whole line back; it may be the credential itself. */
function redactLine(line: string): string {
  const eq = line.indexOf("=");
  return eq > 0 ? `${line.slice(0, eq)}=<value>` : "<line>";
}

function readValue(rest: string, lineNumber: number, label: string): string {
  if (!rest) return "";

  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    let out = "";
    for (let i = 1; i < rest.length; i += 1) {
      const char = rest[i];
      if (char === "\\" && quote === '"' && i + 1 < rest.length) {
        const next = rest[i + 1];
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        i += 1;
        continue;
      }
      if (char === quote) {
        const trailing = rest.slice(i + 1).trim();
        if (trailing && !trailing.startsWith("#")) {
          throw new EnvFileError(
            `${label} line ${lineNumber} has text after the closing quote.`,
          );
        }
        return out;
      }
      out += char;
    }
    throw new EnvFileError(`${label} line ${lineNumber} has an unclosed quote.`);
  }

  // Unquoted: a `#` begins a comment, everything before it is the value.
  const hash = rest.indexOf(" #");
  return (hash >= 0 ? rest.slice(0, hash) : rest).trim();
}

export type PilotEnv = {
  mode: "pilot";
  /** Exactly what the pilot file supplied. Nothing inherited. */
  vars: Record<string, string>;
};

/**
 * Builds the environment a pilot command runs under, or refuses.
 *
 * `required` is checked against the **file**, never against the process, so a
 * variable that happens to be exported in the shell cannot satisfy it. That is
 * the difference between "the pilot is configured" and "something is
 * configured".
 */
export function buildPilotEnv(input: {
  text: string;
  path: string;
  required: readonly string[];
}): PilotEnv {
  const parsed = parseEnvFile(input.text, input.path);

  const missing = input.required.filter((name) => {
    const value = parsed.get(name);
    return value === undefined || value.trim() === "";
  });

  if (missing.length > 0) {
    throw new EnvFileError(
      `${input.path} is incomplete. Missing: ${missing.join(", ")}.\n` +
        "  Pilot mode does not fall back to the shell or to .env.local, so\n" +
        "  every value it needs must be in this file.",
    );
  }

  const vars: Record<string, string> = {};
  for (const [name, value] of parsed) vars[name] = value;
  return { mode: "pilot", vars };
}

/**
 * Whether the caller asked for pilot mode. Opt-in by name, never inferred.
 *
 * Takes any environment-shaped bag rather than `NodeJS.ProcessEnv`, which Next
 * augments to require `NODE_ENV` — a shape a caller building a small object
 * cannot satisfy, and one this has no interest in.
 */
export function pilotRequested(env: Record<string, string | undefined>): boolean {
  return env.BSCJ_PILOT === "1";
}

/** Where the pilot file lives. Overridable, defaulted, never guessed at. */
export function pilotEnvPath(env: Record<string, string | undefined>): string {
  return env.BSCJ_PILOT_ENV_FILE?.trim() || ".env.pilot";
}

/**
 * The variables a pilot command must find in the file.
 *
 * Both connection strings, because the preference between them is what makes
 * a half-configured pilot dangerous, and the independently confirmed endpoint,
 * because matching connection strings prove nothing on their own.
 */
export const PILOT_REQUIRED = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "BSCJ_PILOT_ENDPOINT",
] as const;
