CREATE TABLE "access_log" (
	"id" text PRIMARY KEY,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"user_id" text,
	"ip" text,
	"user_agent" text,
	"client_name" text,
	"client_version" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "token" text;--> statement-breakpoint
UPDATE "subscription" SET "token" = replace(gen_random_uuid()::text, '-', '');--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "token" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_token_key" UNIQUE("token");--> statement-breakpoint
CREATE INDEX "access_log_subject_idx" ON "access_log" ("subject_type","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "access_log_user_idx" ON "access_log" ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "access_log" ADD CONSTRAINT "access_log_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;