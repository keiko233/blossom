CREATE TABLE "server_log_policy" (
	"server_id" text,
	"source" text,
	"desired_revision" integer DEFAULT 0 NOT NULL,
	"desired_level" text DEFAULT 'default' NOT NULL,
	"desired_deadline" timestamp,
	"desired_updated_at" timestamp DEFAULT now() NOT NULL,
	"desired_updated_by" text,
	"effective_revision" integer,
	"effective_level" text,
	"effective_baseline" text,
	"effective_deadline" timestamp,
	"effective_error" text,
	"effective_pending" boolean DEFAULT false NOT NULL,
	"effective_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "server_log_policy_pkey" PRIMARY KEY("server_id","source")
);
--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "log_policy_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "server_log_policy_server_idx" ON "server_log_policy" ("server_id");--> statement-breakpoint
ALTER TABLE "server_log_policy" ADD CONSTRAINT "server_log_policy_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE CASCADE;