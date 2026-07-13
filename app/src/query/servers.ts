import { createServerFn } from "@tanstack/react-start";
import { count, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { node, server, type Server } from "@/db/proxy-schema";
import { generateAgentToken } from "@/lib/agent-token";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  createServerSchema,
  serverIdSchema,
  updateServerSchema,
} from "@/orpc/proxy/schema";

/** TanStack Query key for the admin server list. */
export const SERVERS_QUERY_KEY = ["admin", "servers"] as const;

/**
 * Server row as served to the admin UI. `agentTokenHash` is deliberately
 * omitted: only the non-secret `prefix` is exposed for display. The plaintext
 * token is returned exactly once on create/reset (see `createServer` /
 * `regenerateServerToken`).
 */
export type ServerDTO = Omit<Server, "agentTokenHash">;

/** Server summary joined with the live child-node count for the list UI. */
export interface ServerListItem extends ServerDTO {
  nodeCount: number;
}

function toDTO(row: Server): ServerDTO {
  const { agentTokenHash: _agentTokenHash, ...rest } = row;
  return rest;
}

export const listServers = createServerFn({ method: "GET" }).handler(
  async () => {
    await ensureAdmin();
    const [servers, nodeCounts] = await Promise.all([
      db.select().from(server).orderBy(desc(server.createdAt)),
      db
        .select({ serverId: node.serverId, count: count() })
        .from(node)
        .groupBy(node.serverId),
    ]);

    const countByServer = new Map(
      nodeCounts.map((row) => [row.serverId, row.count]),
    );
    const result: ServerListItem[] = servers.map((row) => ({
      ...toDTO(row),
      nodeCount: countByServer.get(row.id) ?? 0,
    }));
    return result;
  },
);

export const getServer = createServerFn({ method: "GET" })
  .validator(serverIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db.select().from(server).where(eq(server.id, data.id));
    if (!row) {
      throw new Error("Not found");
    }
    return toDTO(row);
  });

export const createServer = createServerFn({ method: "POST" })
  .validator(createServerSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const credential = generateAgentToken();

    const [row] = await db
      .insert(server)
      .values({
        id: randomUUID(),
        name: data.name,
        remark: data.remark,
        enabled: data.enabled,
        address: data.address,
        configPollIntervalSeconds: data.configPollIntervalSeconds,
        heartbeatIntervalSeconds: data.heartbeatIntervalSeconds,
        agentTokenHash: credential.hash,
        agentTokenPrefix: credential.prefix,
      })
      .returning();

    // Plaintext token is returned once here and never persisted.
    return { server: toDTO(row), token: credential.token };
  });

export const updateServer = createServerFn({ method: "POST" })
  .validator(updateServerSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { id, ...rest } = data;

    const [row] = await db
      .update(server)
      .set(rest)
      .where(eq(server.id, id))
      .returning();

    if (!row) {
      throw new Error("Not found");
    }
    return toDTO(row);
  });

/**
 * Refuses to delete a server that still has nodes. The FK is RESTRICT in the
 * schema, so even a race here cannot orphan the rows — this check turns the
 * cryptic FK error into a clear user-facing message.
 */
export const deleteServer = createServerFn({ method: "POST" })
  .validator(serverIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();

    const [countRow] = await db
      .select({ count: count() })
      .from(node)
      .where(eq(node.serverId, data.id));
    if ((countRow?.count ?? 0) > 0) {
      throw new Error(
        "Server still has nodes; move or delete them before removing it.",
      );
    }

    const [row] = await db
      .delete(server)
      .where(eq(server.id, data.id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id };
  });

export const regenerateServerToken = createServerFn({ method: "POST" })
  .validator(serverIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const credential = generateAgentToken();

    const [row] = await db
      .update(server)
      .set({
        agentTokenHash: credential.hash,
        agentTokenPrefix: credential.prefix,
      })
      .where(eq(server.id, data.id))
      .returning();

    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id, token: credential.token };
  });
