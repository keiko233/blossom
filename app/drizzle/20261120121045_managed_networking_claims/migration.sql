-- Custom SQL migration (Drizzle's schema DSL cannot express triggers or seed
-- rows) for the managed networking foundation.
--
-- 1. Seed the singleton topology fence at generation 0.
-- 2. Keep subscriber listener claims in step with "node" from every writer.
--    The trigger runs inside the writer's own statement, so UI, MCP, the
--    group-membership node-delete cascade and any later importer keep claims
--    atomic on node-postgres and neon-http alike. Node's own
--    (server_id, listen_port) unique constraint fires first, so the existing
--    port-conflict behaviour is unchanged until a peer claim exists.
-- 3. Backfill claims for existing nodes. Creating the trigger holds a lock on
--    "node" until this migration commits (the migrator runs in one
--    transaction), so no insert can slip between the trigger and the backfill.
-- 4. Reject UPDATE of "managed_config_version": intent is immutable once
--    recorded and may only be deleted when nothing references it.
INSERT INTO "managed_topology" ("id", "generation")
VALUES ('global', 0)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION "node_listener_claim_sync"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD."id" = NEW."id"
    AND OLD."server_id" = NEW."server_id"
    AND OLD."listen_port" = NEW."listen_port" THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    DELETE FROM "listener_claim"
    WHERE "owner_kind" = 'subscriber_inbound'
      AND "owner_id" = OLD."id";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO "listener_claim" ("server_id", "port", "owner_kind", "owner_id")
    VALUES (NEW."server_id", NEW."listen_port", 'subscriber_inbound', NEW."id");
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "node_listener_claim_sync"
AFTER INSERT OR UPDATE OR DELETE ON "node"
FOR EACH ROW EXECUTE FUNCTION "node_listener_claim_sync"();
--> statement-breakpoint
INSERT INTO "listener_claim" ("server_id", "port", "owner_kind", "owner_id")
SELECT "server_id", "listen_port", 'subscriber_inbound', "id"
FROM "node"
ON CONFLICT ("server_id", "port") DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION "managed_config_version_immutable"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'managed_config_version % is immutable', OLD."id"
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "managed_config_version_immutable"
BEFORE UPDATE ON "managed_config_version"
FOR EACH ROW EXECUTE FUNCTION "managed_config_version_immutable"();
