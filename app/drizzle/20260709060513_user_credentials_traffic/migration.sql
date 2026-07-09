CREATE TABLE "traffic_record" (
	"id" text PRIMARY KEY,
	"subscription_id" text NOT NULL,
	"user_id" text NOT NULL,
	"node_id" text,
	"uplink_bytes" bigint NOT NULL,
	"downlink_bytes" bigint NOT NULL,
	"window_started_at" timestamp,
	"window_ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "credential_uuid" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "credential_password" text;--> statement-breakpoint
UPDATE "subscription" SET
	"credential_uuid" = gen_random_uuid()::text,
	"credential_password" = encode(sha256((gen_random_uuid()::text || clock_timestamp()::text)::bytea), 'base64');--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "credential_uuid" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "credential_password" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_credential_uuid_key" UNIQUE("credential_uuid");--> statement-breakpoint
CREATE INDEX "traffic_record_subscription_idx" ON "traffic_record" ("subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "traffic_record_user_idx" ON "traffic_record" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "traffic_record_node_idx" ON "traffic_record" ("node_id","created_at");--> statement-breakpoint
ALTER TABLE "traffic_record" ADD CONSTRAINT "traffic_record_subscription_id_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscription"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "traffic_record" ADD CONSTRAINT "traffic_record_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "traffic_record" ADD CONSTRAINT "traffic_record_node_id_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "node"("id") ON DELETE SET NULL;