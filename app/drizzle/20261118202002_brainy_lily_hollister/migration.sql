CREATE TABLE "certificate_issuance_job" (
	"id" text PRIMARY KEY,
	"certificate_id" text NOT NULL,
	"generation" integer NOT NULL,
	"issuer_server_id" text NOT NULL,
	"challenge_type" text NOT NULL,
	"acme_provider" text NOT NULL,
	"acme_staging" boolean DEFAULT false NOT NULL,
	"domains" jsonb NOT NULL,
	"state" text DEFAULT 'dispatched' NOT NULL,
	"dns_records" jsonb DEFAULT '[]' NOT NULL,
	"challenge_approved_at" timestamp,
	"challenge_expires_at" timestamp NOT NULL,
	"dispatch_count" integer DEFAULT 0 NOT NULL,
	"last_dispatched_at" timestamp,
	"last_error_phase" text,
	"last_error" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_certificate" ADD COLUMN "issuance_mode" text DEFAULT 'legacy_control_plane' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_certificate" ADD COLUMN "issuer_server_id" text;--> statement-breakpoint
ALTER TABLE "managed_certificate" ADD COLUMN "challenge_type" text DEFAULT 'dns-01' NOT NULL;--> statement-breakpoint
CREATE INDEX "certificate_issuance_job_certificate_idx" ON "certificate_issuance_job" ("certificate_id","created_at");--> statement-breakpoint
CREATE INDEX "certificate_issuance_job_issuer_idx" ON "certificate_issuance_job" ("issuer_server_id","state");--> statement-breakpoint
CREATE INDEX "certificate_issuance_job_state_idx" ON "certificate_issuance_job" ("state");--> statement-breakpoint
ALTER TABLE "certificate_issuance_job" ADD CONSTRAINT "certificate_issuance_job_v1w1hF880Bqh_fkey" FOREIGN KEY ("certificate_id") REFERENCES "managed_certificate"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "certificate_issuance_job" ADD CONSTRAINT "certificate_issuance_job_issuer_server_id_server_id_fkey" FOREIGN KEY ("issuer_server_id") REFERENCES "server"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "managed_certificate" ADD CONSTRAINT "managed_certificate_issuer_server_id_server_id_fkey" FOREIGN KEY ("issuer_server_id") REFERENCES "server"("id") ON DELETE SET NULL;