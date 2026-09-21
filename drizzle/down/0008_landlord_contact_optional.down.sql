-- Reverses 0008.
--
-- **Run this only on a database where every customer has both an email and a
-- phone.** Restoring NOT NULL fails while any landlord is recorded without
-- them — which is exactly the state this migration exists to allow, so a
-- database that has imported a contactless portfolio cannot be reversed
-- without first supplying the missing details or removing those records.
--
-- Deal with them deliberately: find them with
--
--   SELECT id, name FROM customer WHERE email IS NULL OR phone IS NULL;
--
-- and either fill the details in or remove the records, rather than having
-- this migration decide on your behalf. Nothing is deleted here, and no
-- property, job, certificate or invoice is touched.

ALTER TABLE "customer" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "customer" ALTER COLUMN "phone" SET NOT NULL;
