CREATE TABLE "routing_rule" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"match_type" text NOT NULL,
	"values" text[] NOT NULL,
	"action" text NOT NULL,
	"scope" text DEFAULT 'client' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
