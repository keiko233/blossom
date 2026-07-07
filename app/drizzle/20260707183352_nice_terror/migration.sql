CREATE TABLE "node" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"remark" text,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"address" text NOT NULL,
	"listen_port" integer NOT NULL,
	"protocol" text NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"agent_token_hash" text NOT NULL UNIQUE,
	"agent_token_prefix" text NOT NULL,
	"last_seen_at" timestamp,
	"agent_version" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "node_protocol_idx" ON "node" ("protocol");