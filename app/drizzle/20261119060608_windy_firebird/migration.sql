ALTER TABLE "server" ADD COLUMN "ws_credential_kind" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "ws_credential_identity_id" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "ws_credential_generation" integer;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "ws_credential_expires_at" timestamp;