CREATE TABLE "traffic_report" (
	"id" text PRIMARY KEY,
	"server_id" text NOT NULL,
	"report_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"accepted" integer NOT NULL,
	"dropped" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "traffic_report_server_report_unique" UNIQUE("server_id","report_id")
);
--> statement-breakpoint
CREATE INDEX "traffic_report_server_created_idx" ON "traffic_report" ("server_id","created_at");--> statement-breakpoint
ALTER TABLE "traffic_report" ADD CONSTRAINT "traffic_report_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE CASCADE;