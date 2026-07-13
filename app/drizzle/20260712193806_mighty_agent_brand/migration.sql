ALTER TABLE "server" ADD COLUMN "config_poll_interval_seconds" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "heartbeat_interval_seconds" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "sing_box_version" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "runtime_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "config_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "observed_revision" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "applied_revision" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "active_node_ids" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "status_reported_at" timestamp;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "last_applied_at" timestamp;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "last_error_phase" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "last_error_message" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "last_error_node_id" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "last_error_at" timestamp;