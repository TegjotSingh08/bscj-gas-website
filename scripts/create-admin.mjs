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

if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Load your environment first.");
  exit(1);
}

const { hashPassword, passwordProblem } = await import(
  "../src/lib/auth/password.ts"
);
const { neon } = await import("@neondatabase/serverless");

const rl = createInterface({ input: stdin, output: stdout });

// No echo suppression here: this is a local admin tool run by the owner, and
// pretending to hide the password while it sits in the terminal buffer would
// be theatre. Run it somewhere private.
const password = await rl.question("New password (min 12 characters): ");
const again = await rl.question("Repeat password: ");
rl.close();

if (password !== again) {
  console.error("Passwords did not match.");
  exit(1);
}

const problem = passwordProblem(password);
if (problem) {
  console.error(problem);
  exit(1);
}

const sql = neon(env.DATABASE_URL);
const passwordHash = await hashPassword(password);
const normalised = email.trim().toLowerCase();

/*
  The role is only applied on insert. Re-running this for an existing user
  resets their password and reactivates them; it must not silently promote an
  engineer to an administrator because someone left the argument off.
*/
const [row] = await sql`
  INSERT INTO app_user (email, name, password_hash, role)
  VALUES (${normalised}, ${name}, ${passwordHash}, ${role})
  ON CONFLICT (email) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        name = EXCLUDED.name,
        is_active = true,
        updated_at = now()
  RETURNING id, email, name, role, created_at
`;

console.log("User ready:");
console.log(`  ${row.name} <${row.email}>  role=${row.role}`);
