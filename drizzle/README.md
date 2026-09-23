# Migrations

Plain SQL, generated with `drizzle-kit generate`, committed, and reviewed
before anything is applied. The application never migrates itself at runtime:
on a live system the file is the artefact that gets read before it touches
production data.

## Applying

```
npm run db:status     # read-only: what is applied, what is outstanding
npm run db:journal    # read-only, offline: is the journal appliable at all?
npm run db:generate   # after changing src/lib/db/schema.ts
npm run db:migrate    # checks the journal, then applies what is outstanding
```

`drizzle.config.ts` loads `.env.local` itself, so there is no need to
`source` it first. A variable already set in the real environment wins, which
is what CI and production need.

It applies only what the journal in `meta/_journal.json` says is outstanding,
so re-running it is safe.

### `when` is an ordinal, and it decides whether the SQL runs at all

**Read this before hand-editing a journal entry or committing a generated
one.** The migrator does not diff the journal against the migration table. It
reads the newest `created_at` in `drizzle.__drizzle_migrations` and applies an
entry only if that entry's `when` is greater:

```js
// drizzle-orm/pg-core/dialect.js
if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
```

An entry whose `when` is lower — or equal — is **skipped without a word**. No
error, no warning, no row, exit code zero. On an empty database the check
short-circuits and everything applies, so a test suite that only ever builds
from scratch will never see it.

That is not hypothetical. `0010`–`0012` shipped with real generation
timestamps while `0008` and `0009` carried hand-picked round numbers running
ahead of real time, and the pilot could not be upgraded at all. See
`docs/V2_CURRENT_STATE.md`.

So:

- **Every entry's `when` must be strictly greater than the one before it.**
  `npm run db:journal` checks it, `db:migrate` will not run without it, and
  `src/lib/ops/migration-journal.test.ts` asserts it against this very file.
- **Never lower an applied migration's `when`.** Those numbers are already
  `created_at` values in live databases. Repair an ordering problem by raising
  the *unapplied* entries above the applied ones — the fix is always forwards.
- The numbers in this chain are deliberately round and synthetic. They are an
  ordering, not a history; `git log` is the history.
- The upgrade path itself is tested in
  `test/integration/migration-upgrade.test.ts`, which stages a database at
  `0009` and upgrades it with the real command rather than building from
  empty.

**`db:migrate` is silent when it succeeds.** A run that applies everything
prints a driver line, a websocket warning and then nothing — which looks
exactly like a run that did nothing. Use `db:status` rather than reading
anything into the silence. It is read-only, runs no DDL, and is safe against
production at any time.

`db:status` also compares each applied migration's recorded SHA-256 against
the file on disk, which catches the one mistake that is otherwise invisible:
editing a migration after it has been applied, so the database and the
repository quietly disagree about what ran.

### About that websocket warning

```
'@neondatabase/serverless' can only connect to remote Neon/Vercel Postgres/
Supabase instances through a websocket
```

Informational, and expected. drizzle-kit picks a driver from what is
installed, preferring `pg`, then `postgres`, then `@vercel/postgres`, then
`@neondatabase/serverless`. Only the last is a dependency here, so it uses the
Neon websocket driver — which works, and is why `pg` is deliberately not
installed just to change which message is printed.

### Pooled or direct

Neon hands out two connection strings for one database. The application
runtime uses the **pooled** one: every request is a short-lived serverless
function, where a connection pool is something to leak rather than reuse.

Migrations are the opposite shape — one long-lived session running DDL. The
pooled endpoint works and is what has been used, but a transaction pooler does
not hold session state, so anything depending on it can behave differently.
`drizzle.config.ts` therefore uses `DATABASE_URL_UNPOOLED` when one is set and
`DATABASE_URL` otherwise. Setting it is optional.

## Reversing

Every migration has a counterpart in `down/`, applied by hand with `psql`.
There is deliberately no `db:rollback` script: unwinding a live schema should
be a decision someone makes while looking at the SQL, not a command that is
easy to run by accident.

Read the header of the down file first. `0000` is destructive — it drops every
V2 table and everything in them.

## Neon branching

Neon can branch a database like git. Before applying anything to production,
branch it, apply there, and check the result. That is cheaper and safer than
any rollback script, and it is the recommended route for `0000`.

## What is not here

Nothing in these migrations touches V1. Bookings continue to be written to
Google Calendar and reserved through Redis exactly as before; the V2 tables are
additive, and reversing them leaves the public booking flow working.
