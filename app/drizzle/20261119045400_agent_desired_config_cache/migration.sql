ALTER TABLE "server" ADD COLUMN "desired_inputs_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "desired_config_valid_until" timestamp;