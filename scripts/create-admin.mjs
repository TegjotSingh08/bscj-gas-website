/**
 * Creates or updates a BSCJ user.
 *
 * A command, not a route. There is deliberately no "register" page and no
 * bootstrap endpoint: an internal tool for a handful of people should not have
 * a public way in, however well guarded, and a first-run setup screen is a
 * race with whoever finds the site first.
 *
 * Usage:
 *   node --experimental-strip-types --import ./scripts/test-resolver.mjs \
 *     scripts/create-admin.mjs "name@example.com" "Full Name" [role] [organisationId]
 *
 * `role` defaults to `admin` and may be `admin` or `engineer`. Agency users
 * are created by an administrator inside the application, where the
 * organisation they belong to is already known — creating one here would mean
 * pasting a UUID, which is how a user ends up in the wrong agency's portfolio.
 *
 * The password is read from the terminal, never from an argument — arguments
 * end up in shell history and in the process list.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit, env } from "node:process";

const [email, name, role = "admin"] = argv.slice(2);

if (!email || !name) {
  console.error(
    'Usage: create-admin.mjs "<email>" "<name>" [admin|engineer]',
  );
  exit(1);
}

if (role !== "admin" && role !== "engineer") {
  console.error(
    `Role must be "admin" or "engineer". Agency users are created in the app.`,
  );
  exit(1);
}

const { loadEnvironment, scrub } = await import("./load-env.mjs");
const { resolveTarget, assertConfirmedEndpoint, TargetError } = await import(
  "../src/lib/ops/db-target.ts"
);

let mode;
try {
  ({ mode } = await loadEnvironment());
} catch (error) {
  console.error(scrub(error.message));
  exit(1);
}

/*
  The target is settled before a connection is opened, by the same code the
  status and migration commands use — so the three cannot disagree about which
  database they mean, which is the only way a migration and a bootstrap end up
  in different places.
*/
let target;
try {
  target = resolveTarget(env);
  /*
    **In pilot mode this command writes to a database it must be certain of,
    so a matching pair of URLs is not enough.**

    Two copies of the same wrong connection string agree perfectly. The
    confirmed endpoint is a second, independent statement — read off the Neon
    console rather than out of the file that supplied the connection — and its
    entire purpose is to disagree when the connection string is wrong.

    Development is left exactly as it was: one local database, `.env.local`,
    no extra ceremony. Requiring it there would be friction with nothing to
    protect.
  */
  if (mode === "pilot") {
    assertConfirmedEndpoint(target, env.BSCJ_PILOT_ENDPOINT);
  }
} catch (error) {
  if (error instanceof TargetError) {
    console.error(`\n${error.message}\n`);
    exit(1);
  }
  console.error(scrub(error?.message ?? error));
  exit(1);
}

const { hashPassword, passwordProblem } = await import(
  "../src/lib/auth/password.ts"
);
const { neon } = await import("@neondatabase/serverless");

const sql = neon(target.url);
const normalised = email.trim().toLowerCase();

console.log(`Mode      : ${mode}`);
console.log(`Target    : ${target.identity}  (via ${target.source})`);
if (mode === "pilot") {
  console.log(`Confirmed : ${env.BSCJ_PILOT_ENDPOINT}`);
}
console.log(`Account   : ${normalised}  (${role})`);

/*
  **An interactive terminal is required before any credential prompt.**

  Not merely "stdin has not closed": a password read from a pipe cannot be
  hidden, and a scripted invocation of a command that creates and resets
  credentials is almost always a mistake. Both streams are checked, because
  hiding the echo needs a real tty on the output side too.
*/
if (!stdin.isTTY || !stdout.isTTY) {
  console.error(
    "\nThis command needs an interactive terminal: it prompts for a password\n" +
      "and hides what you type. Run it directly in a terminal, not through a\n" +
      "pipe, a heredoc or a CI job. Nothing was changed.",
  );
  exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });

/**
 * Asks a question, or stops.
 *
 * A closed or exhausted stdin — a piped invocation, a CI job, a stray
 * heredoc — throws rather than returning an answer. Left unhandled that is an
 * unhandled rejection and a stack trace; worse, a future edit could read it as
 * an empty answer and carry on. This command creates and resets credentials,
 * so anything other than a deliberate keystroke has to mean stop.
 */
async function ask(question) {
  try {
    return await rl.question(question);
  } catch {
    rl.close();
    console.error(
      "\nStopped: this command needs an interactive terminal. Nothing was changed.",
    );
    exit(1);
  }
}

/**
 * Reads a secret without echoing it.
 *
 * The previous version echoed, on the argument that masking while the value
 * sits in the scrollback is theatre. That was half right: the scrollback is a
 * real problem, but so is the shoulder, the screen share and the recording,
 * and masking costs nothing. Now it is neither in the scrollback nor on the
 * screen.
 *
 * Raw mode reads a key at a time so nothing is written back. It is restored in
 * a `finally`, including on Ctrl-C, because leaving a terminal in raw mode is
 * a worse bug than the one being fixed.
 */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    stdout.write(question);

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    const done = (error, result) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(result);
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        switch (char) {
          case "\r":
          case "\n":
          case "\u0004": // Ctrl-D
            return done(null, value);
          case "\u0003": // Ctrl-C
            return done(new Error("interrupted"));
          case "\u007f": // Backspace
          case "\b":
            value = value.slice(0, -1);
            break;
          default:
            // Ignore other control characters rather than storing them.
            if (char >= " ") value += char;
        }
      }
    };

    stdin.on("data", onData);
  });
}

/** A hidden prompt that stops cleanly rather than throwing. */
async function askSecret(question) {
  try {
    return await askHidden(question);
  } catch {
    try {
      rl.close();
    } catch {
      // Already closed.
    }
    console.error("\nStopped. Nothing was changed.");
    exit(1);
  }
}

/*
  **Does this account already exist?**

  `ON CONFLICT DO UPDATE` below means a second run against an existing address
  is not a no-op: it resets that person's password, reactivates a suspended
  account, bumps `session_version` so every session they hold stops working,
  and revokes any invitation or reset link they are holding. All of that is
  correct when it is intended and none of it is recoverable when it is a typo
  in an email address.

  So an existing account requires the address to be typed again. A fresh one
  asks nothing extra, because there is nothing to destroy.
*/
let existing = [];
try {
  existing = await sql`
    SELECT email, role, is_active, password_hash IS NOT NULL AS has_password
    FROM app_user WHERE email = ${normalised}`;
} catch (error) {
  rl.close();
  console.error(
    String(error?.message ?? error).replace(/postgres(?:ql)?:\/\/\S+/gi, "<redacted>"),
  );
  exit(1);
}

const confirmedReset = existing.length > 0;

if (confirmedReset) {
  const account = existing[0];
  console.log("");
  console.log("  THIS ACCOUNT ALREADY EXISTS.");
  console.log(`    role            : ${account.role}`);
  console.log(`    active          : ${account.is_active}`);
  console.log(`    password set    : ${account.has_password}`);
  console.log("");
  console.log("  Continuing will reset its password, reactivate it if it was");
  console.log("  suspended, sign out every session it holds, and revoke any");
  console.log("  invitation or reset link outstanding for it.");
  console.log("  The role is NOT changed.");
  console.log("");

  const typed = await ask("  Type the address again to confirm, or anything else to stop: ");
  if (typed.trim().toLowerCase() !== normalised) {
    rl.close();
    console.error("Stopped. Nothing was changed.");
    exit(1);
  }
}

/*
  `rl` is closed first: readline and raw-mode reading cannot both own stdin,
  and leaving it listening swallows the keystrokes the hidden prompt needs.
*/
rl.close();

const password = await askSecret("New password (min 12 characters, hidden): ");
const again = await askSecret("Repeat password (hidden): ");

if (password !== again) {
  console.error("Passwords did not match.");
  exit(1);
}

const problem = passwordProblem(password);
if (problem) {
  console.error(problem);
  exit(1);
}

const passwordHash = await hashPassword(password);

/*
  The role is only applied on insert. Re-running this for an existing user
  resets their password and reactivates them; it must not silently promote an
  engineer to an administrator because someone left the argument off.
*/
/*
  `password_set_at` and `session_version` are both maintained here, because
  this command sets a password and the application reads both:

  - **`password_set_at`** is what distinguishes "invited, not yet accepted"
    from "set up". Leaving it null would show a colleague who is signing in
    perfectly happily as having an outstanding invitation.
  - **`session_version`** is incremented on an *existing* user, so resetting
    somebody's password from the terminal ends their existing sessions exactly
    as a self-service reset does. A password changed because it may have been
    exposed, that leaves the old sessions alive, has not been changed.
*/
/*
  **Two statements, because they are two different acts.**

  A single `ON CONFLICT DO UPDATE` cannot tell them apart. The account was
  looked up a moment ago; if somebody inserted that address in between — a
  colleague at another terminal, a second copy of this command — an upsert
  would silently turn "create a new administrator" into "reset that person's
  password, sign out their sessions and revoke their links", with no
  confirmation, because the confirmation was never asked for.

  So a fresh creation inserts and does **nothing** on conflict. Getting no row
  back means the race happened, and the command stops rather than guessing.
  Only a run the operator explicitly confirmed may update.
*/
let row;

if (confirmedReset) {
  [row] = await sql`
    UPDATE app_user
    SET password_hash = ${passwordHash},
        name = ${name},
        password_set_at = now(),
        session_version = session_version + 1,
        is_active = true,
        updated_at = now()
    WHERE email = ${normalised}
    RETURNING id, email, name, role, created_at
  `;

  if (!row) {
    /*
      The mirror image: the account existed at lookup and is gone now. Rare,
      but inserting here would create an account the operator was told they
      were resetting — a different act again.
    */
    console.error(
      "\nThat account no longer exists — it was removed while this was running.\n" +
        "Nothing was changed. Run the command again to create it fresh.",
    );
    exit(1);
  }
} else {
  [row] = await sql`
    INSERT INTO app_user (email, name, password_hash, role, password_set_at)
    VALUES (${normalised}, ${name}, ${passwordHash}, ${role}, now())
    ON CONFLICT (email) DO NOTHING
    RETURNING id, email, name, role, created_at
  `;

  if (!row) {
    console.error(
      "\nThat address was created by something else while this was running,\n" +
        "so nothing was changed — this run would have reset it rather than\n" +
        "created it, and you were not asked to confirm that.\n" +
        "Run the command again: it will show the existing account and ask.",
    );
    exit(1);
  }
}

/*
  Any invitation or reset link outstanding for this account is stood down.
  A password has just been set by somebody with database access; an emailed
  link that still works is a spare key nobody is watching.
*/
await sql`
  UPDATE account_credential SET revoked_at = now()
  WHERE user_id = ${row.id} AND consumed_at IS NULL AND revoked_at IS NULL
`;

console.log("User ready:");
console.log(`  ${row.name} <${row.email}>  role=${row.role}`);
