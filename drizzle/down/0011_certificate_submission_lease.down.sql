-- Reverses 0011.
--
-- Drops the lease timestamp from `certificate_draft`. No document, no
-- certificate and no submitted record is affected — the column records only
-- when an in-progress attempt claimed the job.
--
-- **What goes back with it** is the ability to recover an interrupted
-- submission automatically: without the column, a claim left behind by a
-- process that died cannot be told from one still running, and the engineer
-- holding it has to be released by an administrator from the reconciliation
-- page instead.

ALTER TABLE "certificate_draft" DROP COLUMN IF EXISTS "submission_started_at";
