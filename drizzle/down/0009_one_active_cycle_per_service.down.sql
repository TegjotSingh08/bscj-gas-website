-- Reverses 0009.
--
-- Dropping an index removes a guarantee and touches no data. It is safe to run
-- at any time, and the application keeps working — it simply goes back to
-- being the only thing preventing two active positions for one service.
--
-- Nothing is deleted and no compliance history is affected.

DROP INDEX IF EXISTS "compliance_cycle_one_active_per_service";
