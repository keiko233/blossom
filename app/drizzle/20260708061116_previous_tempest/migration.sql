CREATE TABLE "plan" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"duration_days" integer NOT NULL,
	"traffic_bytes" bigint NOT NULL,
	"device_limit" integer DEFAULT 0 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_group" (
	"plan_id" text,
	"group_id" text,
	CONSTRAINT "plan_group_pkey" PRIMARY KEY("plan_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"traffic_quota_bytes" bigint NOT NULL,
	"traffic_used_bytes" bigint DEFAULT 0 NOT NULL,
	"device_limit" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_group" (
	"node_id" text,
	"group_id" text,
	CONSTRAINT "node_group_pkey" PRIMARY KEY("node_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "proxy_group" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"remark" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "plan_group_group_idx" ON "plan_group" ("group_id");--> statement-breakpoint
CREATE INDEX "subscription_user_idx" ON "subscription" ("user_id");--> statement-breakpoint
CREATE INDEX "subscription_user_active_idx" ON "subscription" ("user_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "subscription_plan_idx" ON "subscription" ("plan_id");--> statement-breakpoint
CREATE INDEX "node_group_group_idx" ON "node_group" ("group_id");--> statement-breakpoint
ALTER TABLE "plan_group" ADD CONSTRAINT "plan_group_plan_id_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "plan_group" ADD CONSTRAINT "plan_group_group_id_proxy_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "proxy_group"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_plan_id_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "node_group" ADD CONSTRAINT "node_group_node_id_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "node"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "node_group" ADD CONSTRAINT "node_group_group_id_proxy_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "proxy_group"("id") ON DELETE CASCADE;