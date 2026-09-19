-- Reverses 0005.
--
-- Dropping this discards the record of which address each queued
-- certificate email was approved for. Anything still `pending` would fall
-- back to resolving the recipient role at send time, which is the behaviour
-- that predates the column — deliverable, but no longer provably the
-- address somebody approved. Drain the outbox before running this.
-- No job, document or certificate row is touched.
ALTER TABLE "outbound_email" DROP COLUMN IF EXISTS "recipient_address";
