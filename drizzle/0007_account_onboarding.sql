/*
  Secure onboarding, and reviewed portfolio import.

  Additive throughout, with one relaxation and no destruction. Nothing is
  dropped, nothing is rewritten, no existing row changes meaning, and the
  invoice number sequence is not touched — an existing database keeps every
  invoice, job and certificate it already holds.

  Six things happen here, and each was a decision:

  1. **`account_credential` is a new table, not a reuse of
     `scheduling_token`.** A tenant's scheduling link is *deliberately
     reusable*: they may open it, close it and come back, and revoking it on
     first sight would strand them. A credential that sets a password must be
     the opposite — spent exactly once, by the submission that uses it. One
     table would mean one `used_at` column carrying two opposite rules, and
     one day carrying the wrong one.

  2. **`app_user.password_hash` becomes nullable.** BSCJ opens an account and
     invites its owner; nobody types a password on somebody else's behalf any
     more. Null is the honest record of "invited, not yet accepted".
     `authenticateUser` refuses a null hash at the same cost as a wrong
     password, so the state is not observable from the login form.

  3. **`app_user.session_version` is how a password reset ends existing
     sessions.** Sessions are JWTs, so there is no session table to delete
     from. The version is signed into the token at sign-in and compared on
     every request that makes a decision — against the row the request already
     re-reads, so it costs nothing extra. A reset increments it and every
     token issued before that moment is refused on its next request.

  4. **Existing accounts are backfilled, not left ambiguous.** Every account
     that exists today has a password, so `password_set_at` is set from
     `created_at` rather than left null — which would otherwise read as
     "invitation outstanding" for people who are already signed in.

  5. **`outbound_email` gains `app_user_id`.** An invitation and a reset are
     about an account, not a job. One queue carries both rather than a second
     worker with a second retry policy and a second set of mistakes; both
     columns are nullable and the worker branches on the kind.

  6. **`portfolio_import` makes a confirmation retry-safe.** The unique index
     on `(agent_organisation_id, plan_digest)` is what stops two browsers
     pressing Confirm from importing a portfolio twice — a read-then-write in
     the application does not. The digest covers the reviewed plan and a nonce
     minted with the preview, so re-submitting *one* preview is recognised
     while uploading the same file again is a new review and is allowed.
     No uploaded bytes are stored; only the outcome of rows already reviewed.
*/

CREATE TYPE "public"."account_credential_purpose" AS ENUM('invitation', 'password_reset');--> statement-breakpoint
CREATE TYPE "public"."portfolio_import_status" AS ENUM('running', 'complete', 'partial', 'failed');--> statement-breakpoint

/*
  Only the hash is stored, and the hash covers the purpose as well as the
  token — so a reset credential presented at the invitation door hashes to
  nothing on file, rather than relying on a `WHERE` somebody could forget.

  `consumed_at` is set by the same conditional UPDATE that reads the row, so
  two submissions racing produce exactly one winner. Opening a link sets
  nothing.

  Rows survive use. "This invitation was redeemed on the 4th" is a question
  the security log has to be able to answer, so nothing here is deleted.
*/
CREATE TABLE "account_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "account_credential_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_credential" ADD CONSTRAINT "account_credential_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_credential" ADD CONSTRAINT "account_credential_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_credential_hash_key" ON "account_credential" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "account_credential_user_idx" ON "account_credential" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "account_credential_expires_idx" ON "account_credential" USING btree ("expires_at");--> statement-breakpoint

/*
  Nullable, because an invited account has no password yet. Every account that
  already exists keeps the one it has: this relaxes a constraint and rewrites
  no data.
*/
ALTER TABLE "app_user" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "password_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

/*
  Backfill. Everybody on file today has a password, and leaving this null
  would show existing colleagues as "invitation outstanding" on the admin
  screen. `created_at` is the honest approximation: nobody recorded the moment
  the hash was written, and inventing `now()` would assert something false.
*/
UPDATE "app_user" SET "password_set_at" = "created_at" WHERE "password_hash" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "outbound_email" ADD COLUMN "app_user_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_email" ADD CONSTRAINT "outbound_email_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_email_user_idx" ON "outbound_email" USING btree ("app_user_id");--> statement-breakpoint

CREATE TABLE "portfolio_import" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_organisation_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"plan_digest" text NOT NULL,
	"filename" text,
	"row_count" integer NOT NULL,
	"status" "portfolio_import_status" DEFAULT 'running' NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "portfolio_import" ADD CONSTRAINT "portfolio_import_agent_organisation_id_agent_organisation_id_fk" FOREIGN KEY ("agent_organisation_id") REFERENCES "public"."agent_organisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_import" ADD CONSTRAINT "portfolio_import_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_import_plan_key" ON "portfolio_import" USING btree ("agent_organisation_id","plan_digest");--> statement-breakpoint
CREATE INDEX "portfolio_import_organisation_idx" ON "portfolio_import" USING btree ("agent_organisation_id");
