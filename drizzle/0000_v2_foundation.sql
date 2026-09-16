/*
  The V2 foundation.

  Additive in its entirety. Nothing here touches anything V1 reads or writes:
  bookings continue to be written to Google Calendar and reserved through Redis
  exactly as before, and reversing this migration leaves the public booking
  flow working. See drizzle/down/0000_v2_foundation.down.sql.

  Generated from src/lib/db/schema.ts with `drizzle-kit generate`, then
  committed and reviewed. The application never migrates itself at runtime — on
  a live system the file is the artefact that gets read before it touches
  production data.
*/

CREATE TYPE "public"."app_role" AS ENUM('admin', 'engineer', 'agent_owner', 'agent_member');--> statement-breakpoint
CREATE TYPE "public"."calendar_sync_state" AS ENUM('not_required', 'pending', 'synced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."certificate_status" AS ENUM('issued', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."compliance_cycle_status" AS ENUM('active', 'superseded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."contact_channel" AS ENUM('email', 'sms', 'phone', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."contact_outcome" AS ENUM('queued', 'sent', 'failed', 'responded', 'no_response');--> statement-breakpoint
CREATE TYPE "public"."contact_purpose" AS ENUM('invitation', 'reminder', 'escalation', 'other');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('landlord', 'letting_agent', 'tenant', 'homeowner');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('certificate', 'invoice');--> statement-breakpoint
CREATE TYPE "public"."email_state" AS ENUM('pending', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."job_lifecycle_status" AS ENUM('draft', 'tenant_outreach', 'awaiting_tenant', 'scheduled', 'engineer_assigned', 'in_progress', 'remedial_required', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_source" AS ENUM('website_self', 'website_landlord', 'portal', 'admin');--> statement-breakpoint
CREATE TYPE "public"."message_author_kind" AS ENUM('agent', 'admin', 'engineer', 'system');--> statement-breakpoint
CREATE TYPE "public"."organisation_plan" AS ENUM('free_legacy', 'agent_standard', 'agent_pro', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."price_source" AS ENUM('list', 'agreement', 'override');--> statement-breakpoint
CREATE TYPE "public"."pricing_agreement_status" AS ENUM('draft', 'active', 'expired');--> statement-breakpoint
CREATE TYPE "public"."remedial_status" AS ENUM('recorded', 'awaiting_approval', 'approved', 'declined', 'completed');--> statement-breakpoint
CREATE TYPE "public"."renewal_source" AS ENUM('manual', 'derived');--> statement-breakpoint
CREATE TYPE "public"."scheduling_method" AS ENUM('self_booked', 'landlord_selected', 'tenant_selected', 'admin_selected');--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"property_id" uuid,
	"agent_organisation_id" uuid,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_organisation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"company_number" text,
	"email" text NOT NULL,
	"phone" text,
	"billing_line1" text,
	"billing_line2" text,
	"billing_town" text,
	"billing_postcode" text,
	"plan" "organisation_plan" DEFAULT 'free_legacy' NOT NULL,
	"remedial_authority_pence" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_organisation_id" uuid,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "app_role" DEFAULT 'admin' NOT NULL,
	"totp_secret" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_description" text,
	"impersonated_user_id" uuid,
	"impersonated_organisation_id" uuid,
	"kind" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "certificate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"agent_organisation_id" uuid,
	"certificate_number" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"status" "certificate_status" DEFAULT 'issued' NOT NULL,
	"inspection_date" date NOT NULL,
	"next_due_date" date NOT NULL,
	"issued_by" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correction_reason" text,
	"document_id" uuid
);
--> statement-breakpoint
CREATE TABLE "compliance_cycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"agent_organisation_id" uuid,
	"product_id" text NOT NULL,
	"established_by_job_id" uuid,
	"certificate_id" uuid,
	"inspection_date" date,
	"due_date" date NOT NULL,
	"due_date_source" "renewal_source" NOT NULL,
	"status" "compliance_cycle_status" DEFAULT 'active' NOT NULL,
	"renewal_job_id" uuid,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"channel" "contact_channel" NOT NULL,
	"purpose" "contact_purpose" NOT NULL,
	"outcome" "contact_outcome" DEFAULT 'queued' NOT NULL,
	"recipient" text,
	"detail" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_organisation_id" uuid,
	"type" "customer_type" NOT NULL,
	"name" text NOT NULL,
	"company" text,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"agent_organisation_id" uuid,
	"kind" "document_kind" NOT NULL,
	"blob_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_to" jsonb
);
--> statement-breakpoint
CREATE TABLE "invoice_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"job_id" uuid,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_pence" integer NOT NULL,
	"total_pence" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_organisation_id" uuid,
	"billing_customer_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"period_start" date,
	"period_end" date,
	"subtotal_pence" integer DEFAULT 0 NOT NULL,
	"vat_pence" integer DEFAULT 0 NOT NULL,
	"total_pence" integer DEFAULT 0 NOT NULL,
	"vat_registered" boolean DEFAULT false NOT NULL,
	"vat_number" text,
	"identity_snapshot" jsonb,
	"issued_at" timestamp with time zone,
	"due_date" date,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"paid_note" text,
	"document_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"agent_organisation_id" uuid,
	"customer_id" uuid NOT NULL,
	"billing_customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenancy_id" uuid,
	"assigned_engineer_id" uuid,
	"product_id" text NOT NULL,
	"appliance_count" integer,
	"price_total_pence" integer NOT NULL,
	"customer_snapshot" jsonb NOT NULL,
	"property_snapshot" jsonb NOT NULL,
	"price_snapshot" jsonb NOT NULL,
	"current_certificate_expiry" date,
	"complete_by_date" date,
	"requested_asap" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"next_renewal_date" date,
	"next_renewal_source" "renewal_source",
	"appointment_start" timestamp with time zone,
	"appointment_end" timestamp with time zone,
	"duration_minutes" integer,
	"scheduling_method" "scheduling_method" NOT NULL,
	"lifecycle_status" "job_lifecycle_status" NOT NULL,
	"calendar_event_id" text,
	"calendar_sync_state" "calendar_sync_state" DEFAULT 'not_required' NOT NULL,
	"deadline_exception_at" timestamp with time zone,
	"remedial_authority_pence" integer,
	"source" "job_source" NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"agent_organisation_id" uuid,
	"author_kind" "message_author_kind" NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_email" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"kind" text NOT NULL,
	"recipient" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" "email_state" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_agreement_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pricing_agreement_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"tier_min_jobs" integer NOT NULL,
	"tier_max_jobs" integer,
	"unit_price_pence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_agreement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "pricing_agreement_status" DEFAULT 'draft' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"agent_organisation_id" uuid,
	"house_or_name" text NOT NULL,
	"street" text NOT NULL,
	"town" text,
	"postcode" text NOT NULL,
	"access_notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remedial" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"agent_organisation_id" uuid,
	"description" text NOT NULL,
	"notes" text,
	"estimated_cost_pence" integer,
	"status" "remedial_status" DEFAULT 'recorded' NOT NULL,
	"completed_on_visit" boolean DEFAULT false NOT NULL,
	"authority_pence" integer DEFAULT 0 NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"declined_reason" text,
	"follow_up_job_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduling_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenancy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"started_on" date,
	"ended_on" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volume_commitment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_organisation_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"committed_jobs" integer NOT NULL,
	"notes" text,
	"agreed_by" uuid,
	"agreed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_impersonated_user_id_app_user_id_fk" FOREIGN KEY ("impersonated_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_impersonated_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("impersonated_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_setting" ADD CONSTRAINT "business_setting_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate" ADD CONSTRAINT "certificate_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate" ADD CONSTRAINT "certificate_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate" ADD CONSTRAINT "certificate_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate" ADD CONSTRAINT "certificate_issued_by_app_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate" ADD CONSTRAINT "certificate_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_cycle" ADD CONSTRAINT "compliance_cycle_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_cycle" ADD CONSTRAINT "compliance_cycle_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_cycle" ADD CONSTRAINT "compliance_cycle_established_by_job_id_job_id_fk" FOREIGN KEY ("established_by_job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_cycle" ADD CONSTRAINT "compliance_cycle_certificate_id_certificate_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificate"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_cycle" ADD CONSTRAINT "compliance_cycle_renewal_job_id_job_id_fk" FOREIGN KEY ("renewal_job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_attempt" ADD CONSTRAINT "contact_attempt_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_uploaded_by_app_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_billing_customer_id_customer_id_fk" FOREIGN KEY ("billing_customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_billing_customer_id_customer_id_fk" FOREIGN KEY ("billing_customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_tenancy_id_tenancy_id_fk" FOREIGN KEY ("tenancy_id") REFERENCES "public"."tenancy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_assigned_engineer_id_app_user_id_fk" FOREIGN KEY ("assigned_engineer_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_author_user_id_app_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_email" ADD CONSTRAINT "outbound_email_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_agreement_line" ADD CONSTRAINT "pricing_agreement_line_pricing_agreement_id_pricing_agreement_id_fk" FOREIGN KEY ("pricing_agreement_id") REFERENCES "public"."pricing_agreement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_agreement" ADD CONSTRAINT "pricing_agreement_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_agreement" ADD CONSTRAINT "pricing_agreement_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remedial" ADD CONSTRAINT "remedial_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remedial" ADD CONSTRAINT "remedial_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remedial" ADD CONSTRAINT "remedial_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remedial" ADD CONSTRAINT "remedial_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remedial" ADD CONSTRAINT "remedial_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_token" ADD CONSTRAINT "scheduling_token_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy" ADD CONSTRAINT "tenancy_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_commitment" ADD CONSTRAINT "volume_commitment_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_commitment" ADD CONSTRAINT "volume_commitment_agreed_by_app_user_id_fk" FOREIGN KEY ("agreed_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_job_idx" ON "activity" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "activity_property_idx" ON "activity" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "activity_organisation_idx" ON "activity" USING btree ("agent_organisation_id");--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "activity" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_organisation_name_idx" ON "agent_organisation" USING btree ("name");--> statement-breakpoint
CREATE INDEX "agent_organisation_active_idx" ON "agent_organisation" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "app_user_organisation_idx" ON "app_user" USING btree ("agent_organisation_id");--> statement-breakpoint
CREATE INDEX "app_user_role_idx" ON "app_user" USING btree ("role");--> statement-breakpoint
CREATE INDEX "audit_event_actor_idx" ON "audit_event" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_event_kind_idx" ON "audit_event" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "audit_event_subject_idx" ON "audit_event" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "audit_event_created_idx" ON "audit_event" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "certificate_number_version_key" ON "certificate" USING btree ("certificate_number","version");--> statement-breakpoint
CREATE INDEX "certificate_job_idx" ON "certificate" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "certificate_property_idx" ON "certificate" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "certificate_organisation_idx" ON "certificate" USING btree ("agent_organisation_id");--> statement-breakpoint
CREATE INDEX "certificate_due_idx" ON "certificate" USING btree ("next_due_date");--> statement-breakpoint
CREATE INDEX "compliance_cycle_property_idx" ON "compliance_cycle" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "compliance_cycle_organisation_idx" ON "compliance_cycle" USING btree ("agent_organisation_id");--> statement-breakpoint
CREATE INDEX "compliance_cycle_due_idx" ON "compliance_cycle" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "compliance_cycle_status_idx" ON "compliance_cycle" USING btree ("status");--> statement-breakpoint
CREATE INDEX "contact_attempt_job_idx" ON "contact_attempt" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "contact_attempt_purpose_idx" ON "contact_attempt" USING btree ("purpose");--> statement-breakpoint
CREATE INDEX "customer_email_idx" ON "customer" USING btree ("email");--> statement-breakpoint
CREATE INDEX "customer_name_idx" ON "customer" USING btree ("name");--> statement-breakpoint
CREATE INDEX "customer_organisation_idx" ON "customer" USING btree ("agent_organisation_id");--> statement-breakpoint
CREATE INDEX "document_job_idx" ON "document" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "document_organisation_idx" ON "document" USING btree ("agent_organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_blob_key" ON "document" USING btree ("blob_key");--> statement-breakpoint
CREATE INDEX "invoice_line_invoice_idx" ON "invoice_line" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_line_job_idx" ON "invoice_line" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_number_key" ON "invoice" USING btree ("number");--> statement-breakpoint
CREATE INDEX "invoice_organisation_idx" ON "invoice" USING btree ("agent_organisation_id");--> statement-breakpoint
CREATE INDEX "invoice_billing_customer_idx" ON "invoice" USING btree ("billing_customer_id");--> statement-breakpoint
CREATE INDEX "invoice_status_idx" ON "invoice" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "job_reference_key" ON "job" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "job_idempotency_key" ON "job" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "job_organisation_idx" ON "job" USING btree ("agent_organisation_id");--> statement-breakpoint
CREATE INDEX "job_customer_idx" ON "job" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "job_billing_customer_idx" ON "job" USING btree ("billing_customer_id");--> statement-breakpoint
CREATE INDEX "job_property_idx" ON "job" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "job_engineer_idx" ON "job" USING btree ("assigned_engineer_id");--> statement-breakpoint
CREATE INDEX "job_status_idx" ON "job" USING btree ("lifecycle_status");--> statement-breakpoint
CREATE INDEX "job_appointment_idx" ON "job" USING btree ("appointment_start");--> statement-breakpoint
CREATE INDEX "job_deadline_idx" ON "job" USING btree ("complete_by_date");--> statement-breakpoint
CREATE INDEX "job_renewal_idx" ON "job" USING btree ("next_renewal_date");--> statement-breakpoint
CREATE INDEX "job_calendar_event_idx" ON "job" USING btree ("calendar_event_id");--> statement-breakpoint
CREATE INDEX "message_job_idx" ON "message" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "message_organisation_idx" ON "message" USING btree ("agent_organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_email_idempotency_key" ON "outbound_email" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_email_state_idx" ON "outbound_email" USING btree ("state");--> statement-breakpoint
CREATE INDEX "outbound_email_job_idx" ON "outbound_email" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_agreement_line_key" ON "pricing_agreement_line" USING btree ("pricing_agreement_id","product_id","tier_min_jobs");--> statement-breakpoint
CREATE INDEX "pricing_agreement_line_agreement_idx" ON "pricing_agreement_line" USING btree ("pricing_agreement_id");--> statement-breakpoint
CREATE INDEX "pricing_agreement_organisation_idx" ON "pricing_agreement" USING btree ("agent_organisation_id");--> statement-breakpoint
CREATE INDEX "pricing_agreement_status_idx" ON "pricing_agreement" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pricing_agreement_effective_idx" ON "pricing_agreement" USING btree ("effective_from");--> statement-breakpoint
CREATE INDEX "property_customer_idx" ON "property" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "property_postcode_idx" ON "property" USING btree ("postcode");--> statement-breakpoint
CREATE INDEX "property_organisation_idx" ON "property" USING btree ("agent_organisation_id");--> statement-breakpoint
CREATE INDEX "remedial_job_idx" ON "remedial" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "remedial_property_idx" ON "remedial" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "remedial_organisation_idx" ON "remedial" USING btree ("agent_organisation_id");--> statement-breakpoint
CREATE INDEX "remedial_status_idx" ON "remedial" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduling_token_hash_key" ON "scheduling_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "scheduling_token_job_idx" ON "scheduling_token" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "tenancy_property_idx" ON "tenancy" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "tenancy_ended_idx" ON "tenancy" USING btree ("ended_on");--> statement-breakpoint
CREATE UNIQUE INDEX "volume_commitment_period_key" ON "volume_commitment" USING btree ("agent_organisation_id","period_start");