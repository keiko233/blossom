ALTER TABLE "server" ADD COLUMN "desired_agent_version" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "desired_sing_box_version" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "agent_update_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "agent_update_target" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "agent_update_error" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "agent_update_checked_at" timestamp;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "sing_box_update_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "sing_box_update_target" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "sing_box_update_error" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "sing_box_update_checked_at" timestamp;