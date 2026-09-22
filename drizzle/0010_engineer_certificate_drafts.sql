/*
  The engineer's server-held certificate draft.

  Purely additive: one new table, its own indexes and its own foreign keys.
  No existing table is altered, no column changes type or nullability, and no
  row is read or rewritten.

  `drizzle-kit generate` also proposed re-running two statements that 0008 and
  0009 already applied by hand — the customer contact nullability and the
  partial unique index on active compliance cycles. Both are already on the
  pilot; re-running the index would fail outright and the column changes would
  be no-ops. They are removed here, and 0010's snapshot records them as
  present so a later generate does not propose them again.
*/
CREATE TABLE "certificate_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"agent_organisation_id" uuid,
	"fields" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submission_key" text,
	"submitted_document_id" uuid,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "certificate_draft" ADD CONSTRAINT "certificate_draft_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "certificate_draft" ADD CONSTRAINT "certificate_draft_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "certificate_draft" ADD CONSTRAINT "certificate_draft_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "certificate_draft" ADD CONSTRAINT "certificate_draft_submitted_document_id_document_id_fk" FOREIGN KEY ("submitted_document_id") REFERENCES "public"."document"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "certificate_draft_job_key" ON "certificate_draft" USING btree ("job_id");
--> statement-breakpoint
CREATE INDEX "certificate_draft_organisation_idx" ON "certificate_draft" USING btree ("agent_organisation_id");
