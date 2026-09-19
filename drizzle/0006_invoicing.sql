/*
  Invoicing.

  Additive throughout. Every column is nullable or defaulted, no column is
  dropped, no data is rewritten, and nothing outside `invoice`, `invoice_line`
  and two columns of `customer` is touched. An existing database that has never
  raised an invoice — which is every one of them, the sequence has never been
  drawn — is unaffected until somebody creates a draft.

  Five things happen here, and each was a decision:

  1. **`invoice_status` gains `issued`.** Issue, provider acceptance and
     payment are three different facts. `draft → sent → paid` had no state for
     "this is a real invoice with a number and a PDF, and nobody has emailed it
     yet" — which is the normal state of an invoice handed over in person or
     downloaded from the portal. Added *before* `sent` so the enum reads in the
     order the states occur.

  2. **`invoice.number` becomes nullable.** A draft holds no number. The
     sequence is drawn once, at issue, because a number consumed by a draft
     somebody abandons is a gap in the series a business has to explain.

  3. **One live invoice per job**, as a partial unique index on
     `primary_job_id` where the invoice is not void. The database enforces it
     because two administrators pressing the button at the same moment is
     precisely what a read-then-write in the application fails to stop. Void is
     excluded so a mistake can be voided and the job invoiced again.

  4. **The payer's billing address is a distinct thing from the property.** Two
     columns on `customer` so it is typed once, and a snapshot on `invoice` so
     an agency that moves office does not retrospectively re-address an invoice
     already in somebody's accounts. Nothing substitutes the service address
     for a missing billing address.

  5. **Issue, payment and voiding each record who and when.** An invoice that
     cannot say who issued it is a document with no author.
*/

--> statement-breakpoint
/*
  The new state.

  `ADD VALUE` is transactional on PostgreSQL 12 and later, and the value is
  only *declared* here — nothing in this migration writes it — so the
  restriction on using a new label in the transaction that created it cannot
  bite. `IF NOT EXISTS` so re-running is harmless.
*/
ALTER TYPE "invoice_status" ADD VALUE IF NOT EXISTS 'issued' BEFORE 'sent';--> statement-breakpoint

/*
  A draft has no number.

  Safe in both directions: no row currently has one — the sequence has never
  been drawn — and the unique index on the column already ignores nulls, so
  any number of drafts coexist while two issued invoices still cannot share a
  number.
*/
ALTER TABLE "invoice" ALTER COLUMN "number" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "primary_job_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "quoted_total_pence" integer;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "billing_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "issued_by" uuid;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "paid_on" date;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "paid_by" uuid;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "voided_by" uuid;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "void_reason" text;--> statement-breakpoint

/*
  `restrict` on the job, `set null` on the people.

  A job with an invoice against it must not be deletable — the invoice would
  stop being able to say what it was for. A user who leaves may be removed, and
  the invoice keeps its number, its lines and its PDF; only the attribution
  goes, which the audit log still holds.
*/
DO $$ BEGIN
  ALTER TABLE "invoice" ADD CONSTRAINT "invoice_primary_job_id_job_id_fk"
    FOREIGN KEY ("primary_job_id") REFERENCES "public"."job"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "invoice" ADD CONSTRAINT "invoice_issued_by_app_user_id_fk"
    FOREIGN KEY ("issued_by") REFERENCES "public"."app_user"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "invoice" ADD CONSTRAINT "invoice_paid_by_app_user_id_fk"
    FOREIGN KEY ("paid_by") REFERENCES "public"."app_user"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "invoice" ADD CONSTRAINT "invoice_voided_by_app_user_id_fk"
    FOREIGN KEY ("voided_by") REFERENCES "public"."app_user"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "invoice_primary_job_idx" ON "invoice" USING btree ("primary_job_id");--> statement-breakpoint

/*
  The rule that matters.

  A job may have many invoices over its life — one issued in error, voided,
  and a correct one raised after it — but never two that are *live* at once.
  Without this, a double-submitted form or two administrators working the same
  queue produce two invoices for one piece of work, and the customer receives
  both.
*/
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_active_job_key"
  ON "invoice" USING btree ("primary_job_id")
  WHERE "primary_job_id" IS NOT NULL AND "status" <> 'void';--> statement-breakpoint

/*
  Where the bills go.

  Distinct from the property, which is where the work happens. Both nullable:
  a customer whose billing address nobody has typed yet is the normal starting
  state, and the invoice screen asks for it rather than quietly reusing the
  property.
*/
ALTER TABLE "customer" ADD COLUMN IF NOT EXISTS "billing_address_lines" jsonb;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN IF NOT EXISTS "billing_postcode" text;
