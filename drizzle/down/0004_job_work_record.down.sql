-- Reverses 0004.
--
-- Dropping these discards the engineer's own account of every visit and the
-- times they went on site. The timeline entries written alongside them
-- survive, so the history is not lost outright, but the columns any list or
-- detail page reads are gone. No job, appointment, customer or certificate
-- row is otherwise touched.
ALTER TABLE "job" DROP COLUMN IF EXISTS "completion_notes";
--> statement-breakpoint
ALTER TABLE "job" DROP COLUMN IF EXISTS "work_started_at";
