CREATE TABLE "port_forward" (
	"id" text PRIMARY KEY,
	"server_id" text NOT NULL,
	"name" text NOT NULL,
	"runtime_tag" text NOT NULL UNIQUE,
	"enabled" boolean DEFAULT true NOT NULL,
	"listen_address" text DEFAULT '::' NOT NULL,
	"listen_port" integer NOT NULL,
	"network" text DEFAULT 'both' NOT NULL,
	"target_node_id" text,
	"target_address" text,
	"target_port" integer,
	"outbound_tag" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "port_forward_listen_port_range" CHECK ("listen_port" BETWEEN 1 AND 65535),
	CONSTRAINT "port_forward_network" CHECK ("network" IN ('tcp', 'udp', 'both')),
	CONSTRAINT "port_forward_target" CHECK (("target_node_id" IS NOT NULL AND "target_address" IS NULL AND "target_port" IS NULL)
        OR ("target_node_id" IS NULL AND "target_address" IS NOT NULL AND "target_port" BETWEEN 1 AND 65535))
);
--> statement-breakpoint
ALTER TABLE "managed_outbound" ADD COLUMN "protocol" text;--> statement-breakpoint
ALTER TABLE "managed_outbound" ADD COLUMN "settings" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_outbound" ADD COLUMN "secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "managed_outbound" ADD COLUMN "member_outbound_tags" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "peer_inbound" ADD COLUMN "network" text DEFAULT 'both' NOT NULL;--> statement-breakpoint
ALTER TABLE "peer_inbound" ADD COLUMN "settings" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "peer_inbound" ADD COLUMN "source_node_id" text;--> statement-breakpoint
ALTER TABLE "peer_inbound" ALTER COLUMN "tls_server_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "peer_inbound" ALTER COLUMN "certificate_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "port_forward_server_idx" ON "port_forward" ("server_id");--> statement-breakpoint
CREATE INDEX "port_forward_target_node_idx" ON "port_forward" ("target_node_id");--> statement-breakpoint
ALTER TABLE "peer_inbound" ADD CONSTRAINT "peer_inbound_source_node_id_node_id_fkey" FOREIGN KEY ("source_node_id") REFERENCES "node"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "port_forward" ADD CONSTRAINT "port_forward_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "port_forward" ADD CONSTRAINT "port_forward_target_node_id_node_id_fkey" FOREIGN KEY ("target_node_id") REFERENCES "node"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "peer_inbound" ADD CONSTRAINT "peer_inbound_network" CHECK ("network" IN ('tcp', 'udp', 'both'));--> statement-breakpoint
ALTER TABLE "listener_claim" DROP CONSTRAINT "listener_claim_owner_kind", ADD CONSTRAINT "listener_claim_owner_kind" CHECK ("owner_kind" IN ('subscriber_inbound', 'peer_inbound', 'port_forward'));--> statement-breakpoint
ALTER TABLE "managed_outbound" DROP CONSTRAINT "managed_outbound_kind_link", ADD CONSTRAINT "managed_outbound_kind_link" CHECK (("kind" = 'peer_link' AND "link_id" IS NOT NULL)
        OR ("kind" = 'direct_profile' AND "link_id" IS NULL)
        OR ("kind" = 'custom_proxy' AND "link_id" IS NULL AND "protocol" IS NOT NULL)
        OR ("kind" = 'outbound_group' AND "link_id" IS NULL AND "protocol" IN ('selector', 'urltest')));