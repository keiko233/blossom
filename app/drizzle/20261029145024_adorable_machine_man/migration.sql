CREATE TABLE "redeem_attempt" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"ip" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redeem_batch" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"plan_id" text NOT NULL,
	"duration_days" integer,
	"mode" text DEFAULT 'new' NOT NULL,
	"max_redemptions_per_code" integer DEFAULT 1 NOT NULL,
	"per_user_limit" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp,
	"disabled" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redeem_code" (
	"id" text PRIMARY KEY,
	"batch_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redeem_redemption" (
	"id" text PRIMARY KEY,
	"code_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"user_id" text NOT NULL,
	"subscription_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "redeem_attempt_user_idx" ON "redeem_attempt" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "redeem_attempt_ip_idx" ON "redeem_attempt" ("ip","created_at");--> statement-breakpoint
CREATE INDEX "redeem_batch_plan_idx" ON "redeem_batch" ("plan_id");--> statement-breakpoint
CREATE INDEX "redeem_batch_created_idx" ON "redeem_batch" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "redeem_code_hash_idx" ON "redeem_code" ("code_hash");--> statement-breakpoint
CREATE INDEX "redeem_code_batch_idx" ON "redeem_code" ("batch_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "redeem_redemption_code_user_idx" ON "redeem_redemption" ("code_id","user_id");--> statement-breakpoint
CREATE INDEX "redeem_redemption_batch_idx" ON "redeem_redemption" ("batch_id","created_at");--> statement-breakpoint
CREATE INDEX "redeem_redemption_user_idx" ON "redeem_redemption" ("user_id","batch_id");--> statement-breakpoint
ALTER TABLE "redeem_attempt" ADD CONSTRAINT "redeem_attempt_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "redeem_batch" ADD CONSTRAINT "redeem_batch_plan_id_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "redeem_batch" ADD CONSTRAINT "redeem_batch_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "redeem_code" ADD CONSTRAINT "redeem_code_batch_id_redeem_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "redeem_batch"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "redeem_redemption" ADD CONSTRAINT "redeem_redemption_code_id_redeem_code_id_fkey" FOREIGN KEY ("code_id") REFERENCES "redeem_code"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "redeem_redemption" ADD CONSTRAINT "redeem_redemption_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "redeem_redemption" ADD CONSTRAINT "redeem_redemption_subscription_id_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscription"("id") ON DELETE SET NULL;