import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";

import { type Database, db } from "@/db";
import { agentIdentity } from "@/db/agent-identity-schema";
import {
  oauthAccessToken,
  oauthClient,
  oauthClientResource,
} from "@/db/oauth-schema";
import { node, server } from "@/db/proxy-schema";

export interface DeleteServerOptions {
  database?: Database;
  /**
   * node-postgres can run one interactive transaction. neon-http uses the
   * parent-first, idempotent sequence below; a retry finishes the cleanup.
   */
  interactive?: boolean;
}

/**
 * Deletes a server only after every machine identity it owns is unusable and
 * its OAuth clients are no longer linked. Revoked identities used to keep the
 * server's RESTRICT foreign key alive, so a user could never delete such a
 * server; this path removes the mapping while leaving the admin audit trail
 * untouched.
 */
export async function deleteServerRecord(
  serverId: string,
  options: DeleteServerOptions = {},
): Promise<{ id: string } | null> {
  const database = options.database ?? db;

  const [nodeCount] = await database
    .select({ count: count() })
    .from(node)
    .where(eq(node.serverId, serverId));
  if ((nodeCount?.count ?? 0) > 0) {
    throw new Error(
      "Server still has nodes; move or delete them before removing it.",
    );
  }

  const identities = await database
    .select({
      identityId: agentIdentity.id,
      oauthClientId: agentIdentity.oauthClientId,
    })
    .from(agentIdentity)
    .where(eq(agentIdentity.serverId, serverId));
  const clientIds = [...new Set(identities.map((row) => row.oauthClientId))];

  const remove = async (tx: Database) => {
    if (clientIds.length > 0) {
      await tx
        .update(agentIdentity)
        .set({
          status: "revoked",
          revokedAt: sql`timezone('utc', now())`,
          updatedAt: sql`timezone('utc', now())`,
        })
        .where(
          and(
            eq(agentIdentity.serverId, serverId),
            inArray(agentIdentity.status, ["pending", "active"]),
          ),
        );
      await tx
        .update(oauthClient)
        .set({ disabled: true })
        .where(inArray(oauthClient.clientId, clientIds));
      await tx
        .delete(oauthClientResource)
        .where(inArray(oauthClientResource.clientId, clientIds));
      await tx
        .update(oauthAccessToken)
        .set({ revoked: sql`timezone('utc', now())` })
        .where(
          and(
            inArray(oauthAccessToken.clientId, clientIds),
            isNull(oauthAccessToken.revoked),
          ),
        );
      // Remove the mapping before its client: the identity->client foreign key
      // is RESTRICT, and deleting it first keeps the client cleanup reference
      // safe. Clients are already disabled and unlinked if a later step fails.
      await tx
        .delete(agentIdentity)
        .where(eq(agentIdentity.serverId, serverId));
      await tx
        .delete(oauthClient)
        .where(inArray(oauthClient.clientId, clientIds));
    } else {
      await tx
        .delete(agentIdentity)
        .where(eq(agentIdentity.serverId, serverId));
    }

    const [row] = await tx
      .delete(server)
      .where(eq(server.id, serverId))
      .returning();
    return row ? { id: row.id } : null;
  };

  if (options.interactive) {
    return (
      database as unknown as {
        transaction: <Result>(
          run: (tx: Database) => Promise<Result>,
        ) => Promise<Result>;
      }
    ).transaction(remove);
  }
  return remove(database);
}
