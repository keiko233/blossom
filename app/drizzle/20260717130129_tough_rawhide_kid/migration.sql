CREATE TABLE "certificate_material" (
	"id" text PRIMARY KEY,
	"certificate_id" text NOT NULL,
	"version" integer NOT NULL,
	"certificate_ciphertext" text NOT NULL,
	"private_key_ciphertext" text NOT NULL,
	"not_before" timestamp NOT NULL,
	"not_after" timestamp NOT NULL,
	"fingerprint_sha256" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "certificate_material_version_unique" UNIQUE("certificate_id","version")
);
--> statement-breakpoint
CREATE TABLE "certificate_server" (
	"certificate_id" text,
	"server_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"desired_generation" integer DEFAULT 1 NOT NULL,
	"applied_generation" integer,
	"last_error" text,
	"last_action_id" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "certificate_server_pkey" PRIMARY KEY("certificate_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "managed_certificate" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"domains" jsonb NOT NULL,
	"acme_email" text,
	"acme_staging" boolean DEFAULT false NOT NULL,
	"dns_mode" text,
	"self_signed_validity_days" integer DEFAULT 365 NOT NULL,
	"renewal_days_before_expiry" integer DEFAULT 30 NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"desired_generation" integer DEFAULT 1 NOT NULL,
	"active_material_version" integer,
	"not_before" timestamp,
	"not_after" timestamp,
	"fingerprint_sha256" text,
	"challenge" jsonb,
	"challenge_approved_at" timestamp,
	"issuance_state_ciphertext" text,
	"issuance_lease_expires_at" timestamp,
	"issuance_attempt_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "certificate_id" text;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "tls_server_name" text;--> statement-breakpoint
CREATE INDEX "certificate_server_server_idx" ON "certificate_server" ("server_id");--> statement-breakpoint
CREATE INDEX "certificate_server_state_idx" ON "certificate_server" ("state");--> statement-breakpoint
CREATE INDEX "managed_certificate_kind_idx" ON "managed_certificate" ("kind");--> statement-breakpoint
ALTER TABLE "certificate_material" ADD CONSTRAINT "certificate_material_certificate_id_managed_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "managed_certificate"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "certificate_server" ADD CONSTRAINT "certificate_server_certificate_id_managed_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "managed_certificate"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "certificate_server" ADD CONSTRAINT "certificate_server_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "node" ADD CONSTRAINT "node_certificate_id_managed_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "managed_certificate"("id") ON DELETE RESTRICT;