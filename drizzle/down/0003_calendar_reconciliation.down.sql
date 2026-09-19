-- Reverses 0003.
--
-- Dropping the column discards any outstanding cleanup record, so anything
-- still queued should be reconciled before running this: an obsolete calendar
-- event whose id is only in this column becomes findable by date and address
-- alone once it is gone. No job, appointment or customer row is touched.
DROP INDEX IF EXISTS "job_calendar_sync_state_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "job_calendar_cleanup_idx";
--> statement-breakpoint
ALTER TABLE "job" DROP COLUMN IF EXISTS "calendar_previous_event_id";
