import { sql } from "drizzle-orm";

import type { Database } from "@/db";
import { oauthResource } from "@/db/oauth-schema";

import {
  MCP_RESOURCE_NAME,
  type OAuthResourceIdentifiers,
} from "./oauth-provider-config";

/**
 * Links every existing non-agent OAuth client to the MCP resource. Needed
 * before per-client resource enforcement can keep legacy MCP clients working:
 * clients registered before the resource was configured have no link, and the
 * provider would refuse their `resource` request as `invalid_target`.
 *
 * Idempotent: the resource row is inserted only when missing, and existing
 * links are skipped, so concurrent processes can run it at once. Agent clients
 * are excluded, both by identity row and by any link to the agent resource, so
 * a machine client never gains the MCP resource.
 */
export async function linkNonAgentClientsToMcpResource(
  db: Database,
  resources: OAuthResourceIdentifiers,
): Promise<void> {
  const mcpResource = resources.mcp;
  await db
    .insert(oauthResource)
    .values({
      id: crypto.randomUUID(),
      identifier: mcpResource,
      name: MCP_RESOURCE_NAME,
    })
    .onConflictDoNothing({ target: oauthResource.identifier });

  await db.execute(
    sql`
    INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at)
    SELECT gen_random_uuid()::text, c.client_id, ${mcpResource}, now()
    FROM oauth_client c
    WHERE NOT EXISTS (
        SELECT 1 FROM agent_identity a WHERE a.oauth_client_id = c.client_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM oauth_client_resource g
        WHERE g.client_id = c.client_id AND g.resource_id = ${resources.agent}
      )
      AND NOT EXISTS (
        SELECT 1 FROM oauth_client_resource l
        WHERE l.client_id = c.client_id AND l.resource_id = ${mcpResource}
      )
    ON CONFLICT DO NOTHING
  `,
    "objects",
  );
}

let mcpLinksReady: Promise<void> | undefined;

/**
 * Runs the backfill once per process before the first auth request, and retries
 * on the next request if it failed. Auth requests cannot be served correctly
 * until legacy clients are linked, so callers await this first.
 */
export function ensureMcpResourceLinks(
  db: Database,
  resources: OAuthResourceIdentifiers,
): Promise<void> {
  mcpLinksReady ??= linkNonAgentClientsToMcpResource(db, resources).catch(
    (error: unknown) => {
      mcpLinksReady = undefined;
      throw error;
    },
  );
  return mcpLinksReady;
}
