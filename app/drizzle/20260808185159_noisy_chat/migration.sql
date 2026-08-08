CREATE TABLE "config_change" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"prev_row" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_change_server" (
	"change_id" text,
	"server_id" text,
	"revision_seq" integer NOT NULL,
	CONSTRAINT "config_change_server_pkey" PRIMARY KEY("change_id","server_id")
);
--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "desired_revision_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "applied_revision_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "config_change_subject_idx" ON "config_change" ("kind","subject_id");--> statement-breakpoint
CREATE INDEX "config_change_server_pending_idx" ON "config_change_server" ("server_id","revision_seq");--> statement-breakpoint
ALTER TABLE "config_change_server" ADD CONSTRAINT "config_change_server_change_id_config_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "config_change"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "config_change_server" ADD CONSTRAINT "config_change_server_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE CASCADE;