-- Reverses 0002. Dropping the index does not remove any row; it only stops
-- the database refusing a duplicate property within one agency. The
-- application's own pre-insert check continues to catch the ordinary case.
DROP INDEX IF EXISTS "property_org_address_key";
