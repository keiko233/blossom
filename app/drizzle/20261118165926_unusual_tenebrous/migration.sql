ALTER TABLE "server" ADD COLUMN "transport_mode" text DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "ws_connected_at" timestamp;