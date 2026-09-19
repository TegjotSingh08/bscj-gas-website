/*
  What still has to happen in Google Calendar, kept in Postgres.

  Rescheduling is the case this exists for. Moving an appointment means
  creating the replacement event and then removing the superseded one, and
  Postgres cannot make a Google API call part of its transaction. Between the
  two calls the process can die, the API can time out, or the token can
  expire — and until now nothing recorded that an obsolete event was still
  sitting in the engineer's diary. The only trace was in the memory of a
  request that had already ended.

  `calendar_previous_event_id` is written **in the same UPDATE that moves the
  appointment**, so the record of the work outstanding is committed atomically
  with the change that created it. A crash one line later leaves a row naming
  exactly which event must go; the column is cleared only once Google has
  confirmed the deletion. That is what makes the cleanup a resumable sequence
  rather than a best-effort call.

  The two indexes are the reconciliation queue itself: one finds appointments
  Google does not reflect yet (`pending` / `failed`), the other finds events
  that outlived the appointment they belonged to.

  Additive and non-destructive. One nullable column and two indexes. It reads
  nothing, rewrites nothing, and every existing row keeps the behaviour it
  already had — a NULL here means "nothing outstanding", which is true of
  every job written before this migration.
*/
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "calendar_previous_event_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_calendar_cleanup_idx"
  ON "job" ("calendar_previous_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_calendar_sync_state_idx"
  ON "job" ("calendar_sync_state");
