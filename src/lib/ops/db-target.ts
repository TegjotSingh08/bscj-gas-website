/**
 * Which database a command is about to touch, and whether that is agreed.
 *
 * Pure: it takes strings and returns a decision. No file, no network, no
 * `server-only` — the migration and bootstrap scripts import it directly, so
 * it has to be loadable outside the Next runtime.
 *
 * The failure this exists to prevent is quiet and expensive: a migration or an
 * administrator landing in the wrong database. The command succeeds either
 * way; only the target differs, and nothing afterwards says so.
 */

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

export type Target = {
  /** The connection string to use. Never printed. */
  url: string;
  /** Which variable supplied it. */
  source: "DATABASE_URL_UNPOOLED" | "DATABASE_URL";
  /** `host/database` — safe to display, carries no credential. */
  identity: string;
  /** Endpoint and database with the pooler suffix removed, for comparison. */
  key: string;
  /** Hostname with the pooler suffix removed. Compared in full, never by label. */
  host: string;
  /** The database name on that host. */
  database: string;
};

/**
 * Validates a Postgres connection string.
 *
 * Rejects rather than coerces. A value that is not a URL, is not Postgres, or
 * names no database is a configuration mistake, and continuing on one means
 * discovering it as a driver error halfway through a migration.
 */
export function parseConnection(value: string, label: string): {
  hostname: string;
  database: string;
} {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new TargetError(`${label} is empty.`);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TargetError(`${label} is not a URL.`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new TargetError(
      `${label} is not a Postgres connection string (found "${url.protocol.replace(":", "")}").`,
    );
  }
  if (!url.hostname) throw new TargetError(`${label} has no host.`);

  const database = url.pathname.replace(/^\//, "");
  if (!database) throw new TargetError(`${label} names no database.`);

  return { hostname: url.hostname, database };
}

/** `host/database`. Safe to print: no user, no password, no query string. */
export function identify(value: string, label = "connection string"): string {
  const { hostname, database } = parseConnection(value, label);
  return `${hostname}/${database}`;
}

/**
 * The comparison key: the same database however you reach it.
 *
 * Neon serves one database on two hostnames — `ep-x-pooler.…` through the
 * transaction pooler and `ep-x.…` directly — and a correct setup uses both.
 * Only that one recognised suffix is normalised, and **only on the first
 * label**, so a database or a domain that merely contains the word is left
 * alone. A blanket `replace("-pooler", "")` would quietly equate hosts that
 * are not the same machine.
 */
export function endpointKey(value: string, label = "connection string"): string {
  const { hostname, database } = parseConnection(value, label);
  return `${normaliseHost(hostname)}/${database}`;
}

/**
 * Strips the pooler suffix from the endpoint label, and only from there.
 *
 * Shared by `endpointKey` and the confirmed-endpoint check so the two cannot
 * disagree about what counts as the same host — they did, briefly: one
 * anchored the suffix to the end of the *string* rather than the end of the
 * *label*, so `ep-x-pooler.region.example` was left untouched and a correct
 * confirmation was rejected.
 */
function normaliseHost(hostname: string): string {
  const labels = hostname.split(".");
  labels[0] = labels[0].replace(/-pooler$/, "");
  return labels.join(".");
}

/**
 * Picks the connection a command will use, or refuses.
 *
 * `DATABASE_URL_UNPOOLED` is preferred when present, matching drizzle-kit:
 * migrations are one long session running DDL, which wants the direct
 * endpoint, while the application wants the pooler.
 *
 * **A disagreement is a stop, not a warning.** If the two name different
 * databases, one of them is wrong and there is no way to tell which — so
 * migrations would go one place and the application would read another.
 * Warning and continuing means the operator has to notice a line of output
 * mid-run; refusing means they cannot miss it.
 */
export function resolveTarget(
  /** Any environment-shaped bag, so `process.env` passes without a cast. */
  env: Record<string, string | undefined>,
): Target {
  const pooled = env.DATABASE_URL?.trim() || undefined;
  const unpooled = env.DATABASE_URL_UNPOOLED?.trim() || undefined;

  if (!pooled && !unpooled) {
    throw new TargetError(
      "Neither DATABASE_URL nor DATABASE_URL_UNPOOLED is set.",
    );
  }

  if (pooled) parseConnection(pooled, "DATABASE_URL");
  if (unpooled) parseConnection(unpooled, "DATABASE_URL_UNPOOLED");

  if (pooled && unpooled && endpointKey(pooled) !== endpointKey(unpooled)) {
    throw new TargetError(
      "DATABASE_URL and DATABASE_URL_UNPOOLED name different databases.\n" +
        `  DATABASE_URL          -> ${identify(pooled)}\n` +
        `  DATABASE_URL_UNPOOLED -> ${identify(unpooled)}\n` +
        "  Migrations would go to one and the application would read the other.\n" +
        "  Set both to the same database, or set only one.",
    );
  }

  const url = unpooled ?? pooled!;
  const { hostname, database } = parseConnection(url, "connection string");
  return {
    url,
    source: unpooled ? "DATABASE_URL_UNPOOLED" : "DATABASE_URL",
    identity: identify(url),
    key: endpointKey(url),
    host: normaliseHost(hostname),
    database,
  };
}

/**
 * Checks the target against an endpoint the operator confirmed separately.
 *
 * **Matching connection strings prove nothing about which database this is.**
 * Two copies of the same wrong string agree perfectly. So before anything is
 * written, the target is compared against `BSCJ_PILOT_ENDPOINT` — a value the
 * operator reads off the Neon console, not out of the same file that supplied
 * the connection. It is a second, independent statement of intent, and its
 * whole purpose is to disagree when the connection string is wrong.
 *
 * Accepts either the bare host or `host/database`, because both are things a
 * person might reasonably paste.
 */
export function assertConfirmedEndpoint(
  target: Target,
  confirmed: string | undefined,
): void {
  const expected = (confirmed ?? "").trim();
  if (!expected) {
    throw new TargetError(
      "BSCJ_PILOT_ENDPOINT is not set.\n" +
        "  Before writing to a pilot database, confirm its endpoint in the Neon\n" +
        "  console and record it, so the connection string is checked against\n" +
        "  something that did not come from the same file.",
    );
  }

  const stripped = expected
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  const slash = stripped.indexOf("/");
  const wantedHostRaw = slash >= 0 ? stripped.slice(0, slash) : stripped;
  const wantedDatabase = slash >= 0 ? stripped.slice(slash + 1) : "";

  if (!wantedHostRaw) {
    throw new TargetError(
      `BSCJ_PILOT_ENDPOINT names no host: "${expected}".`,
    );
  }

  /*
    **The whole hostname, not the first label.**

    An earlier version fell back to comparing only the leading label, so
    `ep-pilot-abc.example.invalid` was accepted as confirmation of
    `ep-pilot-abc.eu-west-2.aws.neon.tech`. That is exactly backwards: the
    endpoint id is the part most likely to be copied correctly from the
    console, and the domain is the part that says which *provider and region*
    the database is in. Matching on the easy half and ignoring the rest turned
    a safety check into a formality.

    Only the recognised pooled/direct suffix is normalised, on the endpoint
    label, so `ep-x-pooler.…` and `ep-x.…` still agree — that is one database
    reached two ways, which a correct setup relies on.
  */
  const wantedHost = normaliseHost(wantedHostRaw);

  if (wantedHost !== target.host) {
    throw new TargetError(mismatch(target, expected));
  }

  /*
    **A database name in the confirmation is a claim, so it is checked.**

    One Neon endpoint serves many databases, and `…/neondb` against
    `…/otherdb` is a different database on the same host — the same class of
    mistake as a different host, and previously accepted because only the host
    was compared.

    A bare host stays supported and documented: it confirms the endpoint and
    says nothing about the database, which is a weaker but honest statement.
    Supplying the database makes it stronger.
  */
  if (wantedDatabase && wantedDatabase !== target.database) {
    throw new TargetError(mismatch(target, expected));
  }
}

/** One message for both halves, so neither says more than the other. */
function mismatch(target: Target, expected: string): string {
  return (
    "The database does not match the confirmed pilot endpoint.\n" +
    `  connection points at : ${target.identity}\n` +
    `  BSCJ_PILOT_ENDPOINT  : ${expected}\n` +
    "  One of them is wrong. Nothing has been written."
  );
}
