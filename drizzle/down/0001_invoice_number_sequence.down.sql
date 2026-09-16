-- Reverses 0001. Safe only while no invoice has been raised: dropping the
-- sequence does not affect rows already numbered, but re-creating it later
-- would restart at 1 and collide with every number already issued.
-- Check `SELECT count(*) FROM invoice;` before running this.
DROP SEQUENCE IF EXISTS invoice_number_seq;
