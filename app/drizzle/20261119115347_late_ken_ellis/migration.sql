ALTER TABLE "server" ADD COLUMN "ws_pending_session_id" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "ws_pending_identity_id" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "ws_pending_generation" integer;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "ws_pending_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "server" ALTER COLUMN "agent_token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ALTER COLUMN "agent_token_prefix" DROP NOT NULL;