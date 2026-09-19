-- Reverses 0006, as far as PostgreSQL permits.
--
-- **Run this only on a database that has issued no invoices.** Dropping these
-- columns discards who issued each invoice, who recorded payment and when the
-- money arrived, the frozen billing address, the quoted price the invoice was
-- raised against, and the rule that stops a job being invoiced twice. None of
-- that is recoverable from the remaining columns.
--
-- `invoice.number` is restored to NOT NULL, which fails while any draft exists
-- — a draft has no number by design. Delete the drafts first, deliberately,
-- rather than having this migration delete rows on your behalf.
--
-- **`invoice_status` keeps the `issued` label.** PostgreSQL cannot remove a
-- value from an enum; doing it by hand means recreating the type and rewriting
-- every column that uses it. An unused label is harmless, so it stays. Any row
-- still in `issued` is moved to `draft` first, because the older code has no
-- state to read it as — and that row has a number and a PDF, which is why this
-- is only safe on a database that has issued nothing.
--
-- No job, document, certificate or customer row is deleted.

UPDATE "invoice" SET "status" = 'draft' WHERE "status" = 'issued';--> statement-breakpoint

DROP INDEX IF EXISTS "invoice_active_job_key";--> statement-breakpoint
DROP INDEX IF EXISTS "invoice_primary_job_idx";--> statement-breakpoint

ALTER TABLE "invoice" DROP CONSTRAINT IF EXISTS "invoice_primary_job_id_job_id_fk";--> statement-breakpoint
ALTER TABLE "invoice" DROP CONSTRAINT IF EXISTS "invoice_issued_by_app_user_id_fk";--> statement-breakpoint
ALTER TABLE "invoice" DROP CONSTRAINT IF EXISTS "invoice_paid_by_app_user_id_fk";--> statement-breakpoint
ALTER TABLE "invoice" DROP CONSTRAINT IF EXISTS "invoice_voided_by_app_user_id_fk";--> statement-breakpoint

ALTER TABLE "invoice" DROP COLUMN IF EXISTS "primary_job_id";--> statement-breakpoint
ALTER TABLE "invoice" DROP COLUMN IF EXISTS "quoted_total_pence";--> statement-breakpoint
ALTER TABLE "invoice" DROP COLUMN IF EXISTS "billing_snapshot";--> statement-breakpoint
ALTER TABLE "invoice" DROP COLUMN IF EXISTS "issued_by";--> statement-breakpoint
ALTER TABLE "invoice" DROP COLUMN IF EXISTS "paid_on";--> statement-breakpoint
ALTER TABLE "invoice" DROP COLUMN IF EXISTS "paid_by";--> statement-breakpoint
ALTER TABLE "invoice" DROP COLUMN IF EXISTS "voided_at";--> statement-breakpoint
ALTER TABLE "invoice" DROP COLUMN IF EXISTS "voided_by";--> statement-breakpoint
ALTER TABLE "invoice" DROP COLUMN IF EXISTS "void_reason";--> statement-breakpoint

ALTER TABLE "invoice" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "customer" DROP COLUMN IF EXISTS "billing_address_lines";--> statement-breakpoint
ALTER TABLE "customer" DROP COLUMN IF EXISTS "billing_postcode";
