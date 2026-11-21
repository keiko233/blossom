CREATE TABLE "listener_claim" (
	"server_id" text,
	"port" integer,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "listener_claim_pkey" PRIMARY KEY("server_id","port"),
	CONSTRAINT "listener_claim_port_range" CHECK ("port" BETWEEN 1 AND 65535),
	CONSTRAINT "listener_claim_owner_kind" CHECK ("owner_kind" IN ('subscriber_inbound', 'peer_inbound'))
);
--> statement-breakpoint
CREATE TABLE "managed_config_version" (
	"id" text PRIMARY KEY,
	"server_id" text NOT NULL,
	"version" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"intent" jsonb NOT NULL,
	"intent_digest" text NOT NULL,
	"subscriber_node_ids" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "managed_config_version_server_version_unique" UNIQUE("server_id","version")
);
--> statement-breakpoint
CREATE TABLE "managed_outbound" (
	"id" text PRIMARY KEY,
	"server_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"runtime_tag" text NOT NULL UNIQUE,
	"link_id" text UNIQUE,
	"dial_options" jsonb DEFAULT '{}' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "managed_outbound_kind_link" CHECK (("kind" = 'peer_link' AND "link_id" IS NOT NULL)
        OR ("kind" = 'direct_profile' AND "link_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "managed_rollout" (
	"id" text PRIMARY KEY,
	"state" text DEFAULT 'applying' NOT NULL,
	"topology_generation" integer NOT NULL,
	"current_ordinal" integer DEFAULT 0 NOT NULL,
	"stage_count" integer NOT NULL,
	"requested_by_user_id" text,
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	CONSTRAINT "managed_rollout_ordinal_range" CHECK ("current_ordinal" BETWEEN 0 AND "stage_count")
);
--> statement-breakpoint
CREATE TABLE "managed_rollout_claim" (
	"server_id" text PRIMARY KEY,
	"rollout_id" text NOT NULL,
	"claimed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_rollout_stage" (
	"rollout_id" text,
	"ordinal" integer,
	"server_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"config_version_id" text NOT NULL,
	"previous_config_version_id" text,
	"managed_fingerprint" text NOT NULL,
	"min_revision_seq" integer,
	"subscriber_intent" jsonb,
	"subscriber_previous" jsonb,
	"deadline_at" timestamp,
	"issued_at" timestamp,
	"confirmed_at" timestamp,
	"failure_code" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "managed_rollout_stage_pkey" PRIMARY KEY("rollout_id","ordinal"),
	CONSTRAINT "managed_rollout_stage_ordinal" CHECK ("ordinal" >= 1)
);
--> statement-breakpoint
CREATE TABLE "managed_server_state" (
	"server_id" text PRIMARY KEY,
	"desired_config_version_id" text,
	"desired_rollout_id" text,
	"desired_ordinal" integer,
	"desired_min_revision_seq" integer,
	"desired_managed_fingerprint" text,
	"applied_config_version_id" text,
	"applied_managed_fingerprint" text,
	"applied_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_topology" (
	"id" text PRIMARY KEY,
	"generation" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "managed_topology_singleton" CHECK ("id" = 'global')
);
--> statement-breakpoint
CREATE TABLE "peer_inbound" (
	"id" text PRIMARY KEY,
	"server_id" text NOT NULL,
	"name" text NOT NULL,
	"runtime_tag" text NOT NULL UNIQUE,
	"protocol" text NOT NULL,
	"listen_address" text NOT NULL,
	"listen_port" integer NOT NULL,
	"advertised_address" text NOT NULL,
	"advertised_port" integer NOT NULL,
	"tls_server_name" text NOT NULL,
	"certificate_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "peer_link" (
	"id" text PRIMARY KEY,
	"source_server_id" text NOT NULL,
	"destination_inbound_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "peer_link_source_destination_unique" UNIQUE("source_server_id","destination_inbound_id"),
	CONSTRAINT "peer_link_id_source_unique" UNIQUE("id","source_server_id")
);
--> statement-breakpoint
CREATE TABLE "peer_link_credential" (
	"link_id" text,
	"generation" integer,
	"state" text DEFAULT 'active' NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"retired_at" timestamp,
	CONSTRAINT "peer_link_credential_pkey" PRIMARY KEY("link_id","generation")
);
--> statement-breakpoint
CREATE INDEX "listener_claim_owner_idx" ON "listener_claim" ("owner_kind","owner_id");--> statement-breakpoint
CREATE INDEX "managed_outbound_server_idx" ON "managed_outbound" ("server_id");--> statement-breakpoint
CREATE INDEX "managed_rollout_state_idx" ON "managed_rollout" ("state");--> statement-breakpoint
CREATE INDEX "managed_rollout_claim_rollout_idx" ON "managed_rollout_claim" ("rollout_id");--> statement-breakpoint
CREATE INDEX "managed_rollout_stage_server_idx" ON "managed_rollout_stage" ("server_id","state");--> statement-breakpoint
CREATE INDEX "peer_inbound_server_idx" ON "peer_inbound" ("server_id");--> statement-breakpoint
CREATE INDEX "peer_link_destination_idx" ON "peer_link" ("destination_inbound_id");--> statement-breakpoint
ALTER TABLE "listener_claim" ADD CONSTRAINT "listener_claim_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "managed_config_version" ADD CONSTRAINT "managed_config_version_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "managed_outbound" ADD CONSTRAINT "managed_outbound_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "managed_outbound" ADD CONSTRAINT "managed_outbound_link_source_fk" FOREIGN KEY ("link_id","server_id") REFERENCES "peer_link"("id","source_server_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "managed_rollout_claim" ADD CONSTRAINT "managed_rollout_claim_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id");--> statement-breakpoint
ALTER TABLE "managed_rollout_claim" ADD CONSTRAINT "managed_rollout_claim_rollout_id_managed_rollout_id_fkey" FOREIGN KEY ("rollout_id") REFERENCES "managed_rollout"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "managed_rollout_stage" ADD CONSTRAINT "managed_rollout_stage_rollout_id_managed_rollout_id_fkey" FOREIGN KEY ("rollout_id") REFERENCES "managed_rollout"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "managed_rollout_stage" ADD CONSTRAINT "managed_rollout_stage_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "managed_rollout_stage" ADD CONSTRAINT "managed_rollout_stage_szhMN4c7oumS_fkey" FOREIGN KEY ("config_version_id") REFERENCES "managed_config_version"("id");--> statement-breakpoint
ALTER TABLE "managed_rollout_stage" ADD CONSTRAINT "managed_rollout_stage_5v31G073BEz8_fkey" FOREIGN KEY ("previous_config_version_id") REFERENCES "managed_config_version"("id");--> statement-breakpoint
ALTER TABLE "managed_server_state" ADD CONSTRAINT "managed_server_state_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "managed_server_state" ADD CONSTRAINT "managed_server_state_L1uHQbh64qKY_fkey" FOREIGN KEY ("desired_config_version_id") REFERENCES "managed_config_version"("id");--> statement-breakpoint
ALTER TABLE "managed_server_state" ADD CONSTRAINT "managed_server_state_desired_rollout_id_managed_rollout_id_fkey" FOREIGN KEY ("desired_rollout_id") REFERENCES "managed_rollout"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "managed_server_state" ADD CONSTRAINT "managed_server_state_etpzX51DYyPp_fkey" FOREIGN KEY ("applied_config_version_id") REFERENCES "managed_config_version"("id");--> statement-breakpoint
ALTER TABLE "peer_inbound" ADD CONSTRAINT "peer_inbound_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "peer_inbound" ADD CONSTRAINT "peer_inbound_certificate_id_managed_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "managed_certificate"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "peer_link" ADD CONSTRAINT "peer_link_source_server_id_server_id_fkey" FOREIGN KEY ("source_server_id") REFERENCES "server"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "peer_link" ADD CONSTRAINT "peer_link_destination_inbound_id_peer_inbound_id_fkey" FOREIGN KEY ("destination_inbound_id") REFERENCES "peer_inbound"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "peer_link_credential" ADD CONSTRAINT "peer_link_credential_link_id_peer_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "peer_link"("id") ON DELETE CASCADE;