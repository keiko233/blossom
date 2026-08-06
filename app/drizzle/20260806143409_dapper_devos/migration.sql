ALTER TABLE "certificate_server" ADD COLUMN "installed_generation" integer;--> statement-breakpoint
ALTER TABLE "certificate_server" ADD COLUMN "installed_fingerprint_sha256" text;--> statement-breakpoint
ALTER TABLE "certificate_server" ADD COLUMN "installed_at" timestamp;--> statement-breakpoint
ALTER TABLE "certificate_server" ADD COLUMN "in_use_at" timestamp;--> statement-breakpoint
ALTER TABLE "certificate_server" ADD COLUMN "last_error_phase" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "agent_build_id" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "agent_capabilities" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
-- Certificate bindings are internal deployment state derived from node use: a
-- node that selects a certificate binds-and-uses it on save, and the row is
-- disabled when no node on the server uses it any more. This reconciles
-- existing data — every node with a certificate selection creates or re-enables
-- its (certificate_id, server_id) row at the certificate's current desired
-- generation. Idempotent: the composite primary-key conflict target means
-- re-running produces the same rows. The final reset below then makes the
-- acknowledgement state truthful.
INSERT INTO "certificate_server" ("certificate_id", "server_id", "enabled", "state", "desired_generation", "updated_at")
SELECT "node"."certificate_id", "node"."server_id", true, 'pending', "managed_certificate"."desired_generation", now()
FROM "node"
INNER JOIN "managed_certificate" ON "managed_certificate"."id" = "node"."certificate_id"
WHERE "node"."certificate_id" IS NOT NULL
ON CONFLICT ("certificate_id", "server_id") DO UPDATE SET
  "enabled" = true,
  "desired_generation" = EXCLUDED."desired_generation";--> statement-breakpoint
-- Old heartbeat-derived "active" acknowledgements predate the truthful,
-- fingerprint-verified V3 deployment reporting and cannot be trusted. Reset
-- every enabled binding to pending so the agent must re-prove (via
-- certificateDeployments) that its installed material is current before any
-- binding is acknowledged as active or in use again. Idempotent: re-running
-- resets the same fields to the same values.
UPDATE "certificate_server" SET
  "state" = 'pending',
  "applied_generation" = NULL,
  "installed_generation" = NULL,
  "installed_fingerprint_sha256" = NULL,
  "installed_at" = NULL,
  "in_use_at" = NULL,
  "last_error_phase" = NULL,
  "last_error" = NULL
WHERE "enabled" = true;
