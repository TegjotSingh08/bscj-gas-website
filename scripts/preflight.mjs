/**
 * What is configured, what is missing, and what is merely unverified.
 *
 * **Read-only and offline.** It reports on the *presence and shape* of
 * configuration in the current environment. It opens no connection, sends no
 * message and writes nothing, so it is safe to run against production at any
 * time — and so a green line here means "configured", never "working". The
 * difference is the whole point of the third column.
 *
 * **No value is ever printed.** Not truncated, not masked, not a first
 * character. A preflight that leaks half a token into a terminal buffer or a
 * screen share is worse than no preflight, and there is no operational
 * question answered by seeing part of a secret.
 *
 *   npm run preflight
 */
import { readFileSync, existsSync } from "node:fs";

/* Load .env.local the way the app does, so a local run reflects local reality. */
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

const { appOriginStatus } = await import("../src/lib/config/origin.ts");
const { storageStatus } = await import("../src/lib/storage/documents.ts");
const { isCronConfigured } = await import("../src/lib/ops/cron-auth.ts");

const set = (name) => Boolean(process.env[name] && process.env[name].trim());
const all = (...names) => names.every(set);

/**
 * `verified` is deliberately false almost everywhere.
 *
 * Only facts this script can establish **without touching anything** may be
 * called verified. Whether a Resend key is accepted, whether the service
 * account can read the calendar, whether the Blob token still works — each
 * needs a live call, which belongs in the pilot runbook, not here.
 */
const checks = [
  {
    group: "Core",
    items: [
      ["Database", "DATABASE_URL", set("DATABASE_URL"), false,
       "Neon connection string. Nothing works without it."],
      ["Session signing", "AUTH_SECRET", set("AUTH_SECRET"), false,
       "Signs sessions, account credentials and import envelopes. All three fail closed without it."],
      ["App origin", "BSCJ_APP_ORIGIN", appOriginStatus().ready, true,
       appOriginStatus().ready
         ? `Links will be addressed to ${appOriginStatus().origin} (${appOriginStatus().deployment}).`
         : appOriginStatus().requirement],
    ],
  },
  {
    group: "Scheduling and availability",
    items: [
      ["Google Calendar", "GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY / GOOGLE_CALENDAR_ID",
       all("GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_PRIVATE_KEY", "GOOGLE_CALENDAR_ID"), false,
       "Use a DEDICATED pilot calendar, not the live diary."],
      ["Redis (holds, limits)", "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN",
       all("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"), false,
       "Without it, holds and rate limits fall back to a weaker per-instance counter."],
      ["Tenant link pepper", "SCHEDULING_TOKEN_SECRET", set("SCHEDULING_TOKEN_SECRET"), false,
       "Optional by design: tenant tokens are already 32 random bytes. Defence in depth."],
    ],
  },
  {
    group: "Communication",
    items: [
      ["Resend", "RESEND_API_KEY / BOOKING_EMAIL_FROM",
       all("RESEND_API_KEY", "BOOKING_EMAIL_FROM"), false,
       "Nothing in the outbox can send without both."],
      ["Internal alerts", "BOOKING_NOTIFICATION_EMAIL", set("BOOKING_NOTIFICATION_EMAIL"), false,
       "Unset means booking alerts are silently not sent."],
      ["Reply-to", "BOOKING_EMAIL_REPLY_TO", set("BOOKING_EMAIL_REPLY_TO"), false,
       "Optional. Falls back to the published booking address."],
    ],
  },
  {
    group: "Documents",
    items: [
      ["Document store", "BLOB_READ_WRITE_TOKEN or BSCJ_DOCUMENT_STORE",
       storageStatus().ready, true,
       storageStatus().ready
         ? `Driver: ${storageStatus().driver}.`
         : storageStatus().requirement],
    ],
  },
  {
    group: "Scheduled processing",
    items: [
      ["Outbox scheduler", "CRON_SECRET", isCronConfigured(), false,
       "Without a scheduler NOTHING queued is ever sent: no invitation, no reset, no certificate, no invoice."],
    ],
  },
];

/**
 * Which database this shell would talk to, safe to print.
 *
 * Host and database name only. Shown because "preflight passed" is otherwise
 * ambiguous about *whose* configuration passed.
 */
function target(value) {
  if (!value) return "not set";
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}/${parsed.pathname.replace(/^\//, "") || "?"}`;
  } catch {
    return "<unparseable>";
  }
}

let missing = 0;
console.log("\nBSCJ preflight — configuration presence only. No value is printed.");
console.log("A tick means CONFIGURED, not WORKING. Liveness is the runbook's job.");
console.log("");
/*
  **This reads the current shell and `.env.local`, and nothing else.**

  It cannot see a Vercel project's environment variables, so a clean run here
  says nothing whatsoever about whether a deployment is configured. Stating
  the target every run is what stops "preflight passed" being read as "the
  pilot is ready".
*/
console.log("  Reading      : this shell + .env.local (NOT any Vercel project)");
console.log(`  Database     : ${target(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL)}`);
console.log(`  Links        : ${appOriginStatus().origin ?? "unresolved"} (${appOriginStatus().deployment})`);
console.log("");

for (const { group, items } of checks) {
  console.log(`  ${group}`);
  for (const [label, vars, ok, verified, note] of items) {
    if (!ok) missing += 1;
    const mark = ok ? (verified ? "[ok]  " : "[set] ") : "[MISS]";
    console.log(`    ${mark} ${label}`);
    console.log(`           ${vars}`);
    if (note) console.log(`           ${note}`);
  }
  console.log("");
}

/*
  The declared schedule, and the plan it requires.

  Stated as a requirement rather than a warning, because this script cannot
  see which plan the project is on. A sub-daily expression is not a
  degradation on Hobby — Vercel rejects it at deploy time — so knowing which
  side of that line the expression falls on is the useful fact.
*/
const cron = JSON.parse(readFileSync("vercel.json", "utf8")).crons?.[0];
if (cron) {
  console.log("  Cron schedule declared in vercel.json");
  console.log(`    ${cron.path}  ${cron.schedule}`);

  const [minute, hour] = cron.schedule.split(/\s+/);
  const subDaily =
    minute.includes("*") || minute.includes("/") || minute.includes(",") ||
    hour.includes("*") || hour.includes("/") || hour.includes(",");

  if (subDaily) {
    console.log("    [PLAN] Runs more than once a day, so it requires Vercel PRO or");
    console.log("           above. On Hobby the DEPLOYMENT FAILS — Vercel rejects a");
    console.log("           sub-daily expression rather than running it less often.");
  } else {
    console.log("    [PLAN] Once a day or less, so it runs on any plan. On Hobby the");
    console.log("           invocation lands anywhere within the stated hour.");
  }
  console.log("           Native cron invokes the PRODUCTION deployment of the");
  console.log("           project it is declared in, over GET, with CRON_SECRET as");
  console.log("           an Authorization: Bearer header.");

  /*
    The interaction that is easy to miss: the drain queries the database on
    every run, and Neon's Free plan suspends a compute after five minutes idle
    and cannot be told not to. So any interval under five minutes keeps the
    compute awake continuously, and continuous is more than the Free plan's
    monthly allowance covers.
  */
  const minuteField = cron.schedule.split(/\s+/)[0];
  const everyN = /^\*\/(\d+)$/.exec(minuteField);
  const minutes = minuteField === "*" ? 1 : everyN ? Number(everyN[1]) : null;

  if (minutes !== null && minutes < 10) {
    console.log("");
    console.log(`    [NEON] Draining every ${minutes} min queries the database at least`);
    console.log("           that often. Neon FREE suspends after 5 min idle and cannot");
    console.log("           be configured otherwise, so this keeps the compute awake");
    console.log("           ~continuously: roughly 180 CU-hours/month against a 100");
    console.log("           CU-hour allowance, exhausting it in about 16 days — after");
    console.log("           which the database is suspended until the next billing");
    console.log("           period. Use */15 or slower on Free, or a paid Neon plan.");
  }
  if (!isCronConfigured()) {
    console.log("");
    console.log("    [NOTE] CRON_SECRET is absent, so scheduled runs return 401 and");
    console.log("           never reach the database. Delivery and retries are NOT");
    console.log("           active: queued email only moves on a manual admin drain.");
  }
  console.log("");
}

console.log(missing === 0
  ? "Everything above is configured. None of it is verified live.\n"
  : `${missing} item(s) missing. See docs/PILOT_RUNBOOK.md.\n`);
