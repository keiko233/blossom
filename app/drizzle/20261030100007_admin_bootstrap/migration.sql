CREATE TABLE "admin_bootstrap" (
	"id" boolean PRIMARY KEY DEFAULT true,
	"claimed_user_id" text,
	"claimed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "admin_bootstrap_singleton" CHECK ("id" = true)
);
