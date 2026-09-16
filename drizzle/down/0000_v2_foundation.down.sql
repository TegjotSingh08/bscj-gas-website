/*
  Reverses 0000, the entire V2 foundation.

  DESTRUCTIVE. This drops every V2 table and every row in them. It exists so a
  failed first deployment can be unwound cleanly on a fresh or staging
  database, not as an operational tool: once real jobs, certificates or
  invoices exist, running this loses them permanently and there is no recovery
  short of a backup.

  Nothing here touches V1. The public booking flow, Google Calendar and Redis
  are untouched by this migration in either direction — after running it the
  site still takes bookings exactly as it did before V2 existed.

  Prefer a Neon branch to this. Branching the database, applying there and
  checking the result is cheaper and safer than any rollback script.

  Tables are dropped children-first so foreign keys never block the drop.
*/

DROP TABLE IF EXISTS "activity";--> statement-breakpoint
DROP TABLE IF EXISTS "audit_event";--> statement-breakpoint
DROP TABLE IF EXISTS "message";--> statement-breakpoint
DROP TABLE IF EXISTS "contact_attempt";--> statement-breakpoint
DROP TABLE IF EXISTS "outbound_email";--> statement-breakpoint
DROP TABLE IF EXISTS "invoice_line";--> statement-breakpoint
DROP TABLE IF EXISTS "compliance_cycle";--> statement-breakpoint
DROP TABLE IF EXISTS "invoice";--> statement-breakpoint
DROP TABLE IF EXISTS "certificate";--> statement-breakpoint
DROP TABLE IF EXISTS "remedial";--> statement-breakpoint
DROP TABLE IF EXISTS "scheduling_token";--> statement-breakpoint
DROP TABLE IF EXISTS "document";--> statement-breakpoint
DROP TABLE IF EXISTS "job";--> statement-breakpoint
DROP TABLE IF EXISTS "volume_commitment";--> statement-breakpoint
DROP TABLE IF EXISTS "pricing_agreement_line";--> statement-breakpoint
DROP TABLE IF EXISTS "pricing_agreement";--> statement-breakpoint
DROP TABLE IF EXISTS "tenancy";--> statement-breakpoint
DROP TABLE IF EXISTS "property";--> statement-breakpoint
DROP TABLE IF EXISTS "customer";--> statement-breakpoint
DROP TABLE IF EXISTS "business_setting";--> statement-breakpoint
DROP TABLE IF EXISTS "app_user";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_organisation";--> statement-breakpoint

-- Enumerations, once nothing references them.
DROP TYPE IF EXISTS "public"."app_role";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."calendar_sync_state";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."certificate_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."compliance_cycle_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."contact_channel";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."contact_outcome";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."contact_purpose";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."customer_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."document_kind";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."email_state";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."invoice_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."job_lifecycle_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."job_source";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."message_author_kind";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."organisation_plan";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."price_source";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."pricing_agreement_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."remedial_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."renewal_source";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."scheduling_method";
