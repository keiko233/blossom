CREATE TABLE "agent_enrollment_grant" (
	"id" text PRIMARY KEY,
	"server_id" text NOT NULL,
	"mode" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"capabilities" jsonb DEFAULT '[]' NOT NULL,
	"release" text,
	"status" text DEFAULT 'issued' NOT NULL,
	"attempt_id" text UNIQUE,
	"claimed_at" timestamp,
	"redeemed_at" timestamp,
	"revoked_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_enrollment_grant_mode_check" CHECK ("mode" in ('enroll', 'replace')),
	CONSTRAINT "agent_enrollment_grant_status_check" CHECK ("status" in ('issued', 'redeeming', 'redeemed', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "agent_identity" (
	"id" text PRIMARY KEY,
	"server_id" text NOT NULL,
	"generation" integer NOT NULL,
	"oauth_client_id" text NOT NULL UNIQUE,
	"status" text NOT NULL,
	"grant_id" text,
	"attempt_id" text NOT NULL UNIQUE,
	"operator_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"activated_at" timestamp,
	"revoked_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_identity_status_check" CHECK ("status" in ('pending', 'active', 'superseded', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX "agent_enrollment_grant_server_idx" ON "agent_enrollment_grant" ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identity_server_generation_uidx" ON "agent_identity" ("server_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identity_server_active_uidx" ON "agent_identity" ("server_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identity_server_pending_uidx" ON "agent_identity" ("server_id") WHERE "status" = 'pending';--> statement-breakpoint
ALTER TABLE "agent_enrollment_grant" ADD CONSTRAINT "agent_enrollment_grant_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_enrollment_grant" ADD CONSTRAINT "agent_enrollment_grant_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agent_identity" ADD CONSTRAINT "agent_identity_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "agent_identity" ADD CONSTRAINT "agent_identity_oauth_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("oauth_client_id") REFERENCES "oauth_client"("client_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "agent_identity" ADD CONSTRAINT "agent_identity_grant_id_agent_enrollment_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "agent_enrollment_grant"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agent_identity" ADD CONSTRAINT "agent_identity_operator_user_id_user_id_fkey" FOREIGN KEY ("operator_user_id") REFERENCES "user"("id") ON DELETE SET NULL;