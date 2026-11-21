CREATE TABLE "managed_link_probe" (
	"id" text PRIMARY KEY,
	"rollout_id" text NOT NULL,
	"stage_ordinal" integer NOT NULL,
	"link_id" text NOT NULL,
	"credential_generation" integer NOT NULL,
	"source_server_id" text NOT NULL,
	"destination_server_id" text NOT NULL,
	"source_min_revision_seq" integer NOT NULL,
	"source_managed_fingerprint" text NOT NULL,
	"destination_min_revision_seq" integer NOT NULL,
	"destination_managed_fingerprint" text NOT NULL,
	"issued_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"outcome" text,
	"latency_ms" integer,
	"applied_desired_revision_seq" integer,
	"applied_managed_fingerprint" text,
	"completed_at" timestamp,
	"recorded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "managed_link_probe_stage_ordinal" CHECK ("stage_ordinal" >= 1),
	CONSTRAINT "managed_link_probe_credential_generation" CHECK ("credential_generation" >= 1),
	CONSTRAINT "managed_link_probe_revision_seqs" CHECK ("source_min_revision_seq" >= 0 AND "destination_min_revision_seq" >= 0),
	CONSTRAINT "managed_link_probe_expiry" CHECK ("expires_at" > "issued_at"),
	CONSTRAINT "managed_link_probe_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('succeeded', 'timeout', 'connect_failed', 'tls_failed', 'auth_rejected', 'responder_mismatch', 'generation_mismatch', 'expired', 'isolation_unavailable', 'unsupported')),
	CONSTRAINT "managed_link_probe_latency" CHECK ("latency_ms" IS NULL OR "latency_ms" BETWEEN 0 AND 60000)
);
--> statement-breakpoint
ALTER TABLE "managed_rollout_stage" ADD COLUMN "issued_revision_seq" integer;--> statement-breakpoint
ALTER TABLE "managed_rollout_stage" ADD COLUMN "probe_link_id" text;--> statement-breakpoint
ALTER TABLE "managed_rollout_stage" ADD COLUMN "recovery_min_revision_seq" integer;--> statement-breakpoint
ALTER TABLE "managed_rollout_stage" ADD COLUMN "recovery_managed_fingerprint" text;--> statement-breakpoint
ALTER TABLE "managed_rollout_stage" ADD COLUMN "recovery_issued_revision_seq" integer;--> statement-breakpoint
ALTER TABLE "managed_rollout_stage" ADD COLUMN "recovery_issued_at" timestamp;--> statement-breakpoint
ALTER TABLE "managed_rollout_stage" ADD COLUMN "recovery_deadline_at" timestamp;--> statement-breakpoint
ALTER TABLE "managed_rollout_stage" ADD COLUMN "recovery_proven_at" timestamp;--> statement-breakpoint
CREATE INDEX "managed_link_probe_stage_idx" ON "managed_link_probe" ("rollout_id","stage_ordinal","issued_at");--> statement-breakpoint
CREATE INDEX "managed_link_probe_source_idx" ON "managed_link_probe" ("source_server_id","issued_at");--> statement-breakpoint
ALTER TABLE "managed_link_probe" ADD CONSTRAINT "managed_link_probe_link_id_peer_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "peer_link"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "managed_link_probe" ADD CONSTRAINT "managed_link_probe_source_server_id_server_id_fkey" FOREIGN KEY ("source_server_id") REFERENCES "server"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "managed_link_probe" ADD CONSTRAINT "managed_link_probe_destination_server_id_server_id_fkey" FOREIGN KEY ("destination_server_id") REFERENCES "server"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "managed_link_probe" ADD CONSTRAINT "managed_link_probe_stage_fk" FOREIGN KEY ("rollout_id","stage_ordinal") REFERENCES "managed_rollout_stage"("rollout_id","ordinal") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "managed_rollout_stage" ADD CONSTRAINT "managed_rollout_stage_probe_link_id_peer_link_id_fkey" FOREIGN KEY ("probe_link_id") REFERENCES "peer_link"("id") ON DELETE SET NULL;