# Migrations

Plain SQL, generated with `drizzle-kit generate`, committed, and reviewed
before anything is applied. The application never migrates itself at runtime:
on a live system the file is the artefact that gets read before it touches
production data.

## Applying

```
npm run db:generate   # after changing src/lib/db/schema.ts
npm run db:migrate    # applies anything outstanding, in journal order
```

`db:migrate` needs `DATABASE_URL`. It applies only what the journal in
`meta/_journal.json` says is outstanding, so re-running it is safe.

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
