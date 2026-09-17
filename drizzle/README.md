# Migrations

Plain SQL, generated with `drizzle-kit generate`, committed, and reviewed
before anything is applied. The application never migrates itself at runtime:
on a live system the file is the artefact that gets read before it touches
production data.

## Applying

```
npm run db:status     # read-only: what is applied, what is outstanding
npm run db:generate   # after changing src/lib/db/schema.ts
npm run db:migrate    # applies anything outstanding, in journal order
```

`drizzle.config.ts` loads `.env.local` itself, so there is no need to
`source` it first. A variable already set in the real environment wins, which
is what CI and production need.

It applies only what the journal in `meta/_journal.json` says is outstanding,
so re-running it is safe.

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
