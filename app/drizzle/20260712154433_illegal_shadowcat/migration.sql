-- Phase 1 of the server/node refactor.
--
-- Before this migration, every `node` row was self-contained: it carried a
-- physical host address, an `agent_token_hash` the Rust agent authenticated
-- with, its own heartbeat `last_seen_at`/`agent_version`, and a fully-formed
-- sing-box inbound. After this migration those host-level attributes live on a
-- new `server` row; each `node` becomes one inbound inside the server's
-- config. The Rust agent keeps authenticating with the same token (now against
-- `server.agent_token_hash`), keeps the same heartbeat (now on `server`), and
-- continues to pull one JSON config — now a multi-inbound one.
--
-- Data migration is forward-only and NOT idempotent: it assumes the legacy
-- schema (node carrying agent_token_* / address) and the empty `server` table.
-- Every existing `node` becomes exactly one `server` (sharing the node's `id`),
-- the node's `agent_token_*`/`last_seen_at`/`agent_version` columns migrate
-- there, and `node.address` is cleared (so the node falls back to
-- `server.address`, keeping the resolved client endpoint unchanged). Existing
-- traffic rows get `server_id` back-filled from their `node_id` so per-server
-- audits keep working even after a later node move/delete. Re-running this
-- migration on an already-migrated database would fail (server rows already
-- exist, the dropped columns are gone). Drizzle's migration journal prevents
-- a second apply in normal operation.

CREATE TABLE "server" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"remark" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"address" text NOT NULL,
	"agent_token_hash" text NOT NULL UNIQUE,
	"agent_token_prefix" text NOT NULL,
	"last_seen_at" timestamp,
	"agent_version" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Add the new columns as nullable first so existing rows can be back-filled
-- before we tighten them. `traffic_record.server_id` stays nullable forever so
-- history survives future server deletes.
ALTER TABLE "node" ADD COLUMN "server_id" text;--> statement-breakpoint
ALTER TABLE "traffic_record" ADD COLUMN "server_id" text;--> statement-breakpoint

-- Drop the NOT NULL on node.address BEFORE writing NULLs into it; otherwise the
-- UPDATE below fails on a populated table. Done as the next statement after
-- `server_id` is added (and before any UPDATE touches `address`) so a failure
-- here leaves the column nullable rather than half-migrated.
ALTER TABLE "node" ALTER COLUMN "address" DROP NOT NULL;--> statement-breakpoint

-- One node -> one server (id is shared so references stay stable). `enabled`
-- is forced to `true`: a node that was locally disabled still had its agent
-- communicating, so the host it represents must remain workable.
INSERT INTO "server" (
	"id", "name", "remark", "enabled", "address",
	"agent_token_hash", "agent_token_prefix", "last_seen_at", "agent_version",
	"created_at", "updated_at"
)
SELECT
	"node"."id",
	"node"."name",
	"node"."remark",
	true,
	"node"."address",
	"node"."agent_token_hash",
	"node"."agent_token_prefix",
	"node"."last_seen_at",
	"node"."agent_version",
	"node"."created_at",
	"node"."updated_at"
FROM "node";--> statement-breakpoint

-- Point each node at its own server (same id) and clear its address so it
-- becomes a pure override (null = use server.address). Because server.address
-- was copied from this node's address, the resolved endpoint is unchanged.
UPDATE "node" SET "server_id" = "node"."id";--> statement-breakpoint
UPDATE "node" SET "address" = NULL;--> statement-breakpoint

-- Back-fill historical traffic rows with the producing server. Rows whose
-- node was already deleted (node_id IS NULL) keep server_id NULL too.
UPDATE "traffic_record" AS "tr"
SET "server_id" = "n"."server_id"
FROM "node" AS "n"
WHERE "tr"."node_id" = "n"."id";--> statement-breakpoint

ALTER TABLE "node" ALTER COLUMN "server_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "node" DROP CONSTRAINT "node_agent_token_hash_key";--> statement-breakpoint
ALTER TABLE "node" ADD CONSTRAINT "node_server_listen_port_unique" UNIQUE("server_id","listen_port");--> statement-breakpoint

ALTER TABLE "node" DROP COLUMN "agent_token_hash";--> statement-breakpoint
ALTER TABLE "node" DROP COLUMN "agent_token_prefix";--> statement-breakpoint
ALTER TABLE "node" DROP COLUMN "last_seen_at";--> statement-breakpoint
ALTER TABLE "node" DROP COLUMN "agent_version";--> statement-breakpoint

CREATE INDEX "node_server_idx" ON "node" ("server_id");--> statement-breakpoint
CREATE INDEX "server_enabled_idx" ON "server" ("enabled");--> statement-breakpoint
CREATE INDEX "traffic_record_server_idx" ON "traffic_record" ("server_id","created_at");--> statement-breakpoint

ALTER TABLE "node" ADD CONSTRAINT "node_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "traffic_record" ADD CONSTRAINT "traffic_record_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE SET NULL;