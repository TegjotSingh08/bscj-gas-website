-- Reverses 0007, as far as PostgreSQL permits.
--
-- **Run this only on a database where nobody has been invited.** Dropping
-- `account_credential` discards every outstanding invitation and reset link,
-- and the record that they were sent and redeemed. Any link already in
-- somebody's inbox stops working, with no way to tell them apart from one
-- that was forged.
--
-- `app_user.password_hash` is restored to NOT NULL, which **fails while any
-- invited account has not yet set a password** — that is exactly what the
-- nullable column exists to record. Deal with those accounts deliberately
-- (set a password, or remove the account) rather than having this migration
-- decide on your behalf.
--
-- Dropping `session_version` means a password reset can no longer end
-- existing sessions: tokens issued before a reset would keep working until
-- they expire. That is the V2.8 behaviour, restored knowingly.
--
-- `portfolio_import` holds the record of which reviewed imports have already
-- run. Dropping it removes the thing that stops a re-submitted confirmation
-- importing a portfolio twice. The imported properties themselves are not
-- touched, and the per-address unique index from 0002 still refuses exact
-- duplicates.
--
-- The two enum types are dropped because nothing else uses them. No user,
-- job, property, invoice or certificate row is deleted, and the invoice
-- number sequence is not touched.

DROP TABLE IF EXISTS "portfolio_import";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."portfolio_import_status";--> statement-breakpoint

DROP INDEX IF EXISTS "outbound_email_user_idx";--> statement-breakpoint
ALTER TABLE "outbound_email" DROP CONSTRAINT IF EXISTS "outbound_email_app_user_id_app_user_id_fk";--> statement-breakpoint
-- Account-scoped messages have no job, so they cannot survive this column.
DELETE FROM "outbound_email" WHERE "app_user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_email" DROP COLUMN IF EXISTS "app_user_id";--> statement-breakpoint

DROP TABLE IF EXISTS "account_credential";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."account_credential_purpose";--> statement-breakpoint

ALTER TABLE "app_user" DROP COLUMN IF EXISTS "session_version";--> statement-breakpoint
ALTER TABLE "app_user" DROP COLUMN IF EXISTS "password_set_at";--> statement-breakpoint
-- Fails while an invited account still has no password. That is deliberate.
ALTER TABLE "app_user" ALTER COLUMN "password_hash" SET NOT NULL;
