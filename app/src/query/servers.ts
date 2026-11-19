import { createServerFn } from "@tanstack/react-start";
import { count, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { db, getDatabaseDriver } from "@/db";
import { node, server } from "@/db/proxy-schema";
import { fromInput, fromResult } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import {
  notifyAgentConfigChanged,
  notifyAgentUpdateTrigger,
} from "@/lib/agent-notifications";
import { generateAgentToken } from "@/lib/agent-token";
import { ensureAdmin } from "@/lib/ensure-admin";
import { supportsInteractiveTransactions } from "@/lib/env-schema";
import {
  createServerSchema,
  serverIdSchema,
  updateServerSchema,
} from "@/orpc/proxy/schema";
import {
  disableAgentBackupCredential,
  enableAgentBackupCredential,
  rotateAgentCredential,
} from "@/query/agent";
import {
  countPendingConfigChangesByServer,
  recordConfigChange,
} from "@/query/config-change";
import { deleteServerRecord } from "@/query/server-deletion";
import { type ServerDTO, toServerDTO } from "@/query/server-dto";

/** TanStack Query key for the admin server list. */
export const SERVERS_QUERY_KEY = ["admin", "servers"] as const;

export type { ServerDTO } from "@/query/server-dto";

/** Server summary joined with the live child-node count for the list UI. */
export interface ServerListItem extends ServerDTO {
  nodeCount: number;
  /**
   * Changes recorded against this server that its agent has not confirmed
   * applied yet (`revisionSeq > appliedRevisionSeq`). Non-zero while a change
   * is inside the poll window; stays non-zero ("awaiting apply") if the agent
   * is offline — the subscription gate holds back those changes indefinitely.
   */
  pendingConfigChanges: number;
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
    const pendingCounts = await countPendingConfigChangesByServer(
      servers.map((row) => row.id),
    );

    const countByServer = new Map(
      nodeCounts.map((row) => [row.serverId, row.count]),
    );
    const result: ServerListItem[] = servers.map((row) => ({
      ...toServerDTO(row),
      nodeCount: countByServer.get(row.id) ?? 0,
      pendingConfigChanges: pendingCounts.get(row.id) ?? 0,
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
    return toServerDTO(row);
  });

export const createServer = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.create", {
      targetType: "server",
      targetId: fromResult("server", "id"),
    }),
  ])
  .validator(createServerSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { enableBackupToken, ...serverData } = data;
    const credential = enableBackupToken ? generateAgentToken() : null;

    const [row] = await db
      .insert(server)
      .values({
        id: randomUUID(),
        ...serverData,
        agentTokenHash: credential?.hash ?? null,
        agentTokenPrefix: credential?.prefix ?? null,
      })
      .returning();

    // Plaintext token is returned once here and never persisted.
    return { server: toServerDTO(row!), token: credential?.token ?? null };
  });

export const updateServer = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.update", {
      targetType: "server",
      targetId: fromInput("id"),
    }),
  ])
  .validator(updateServerSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { id, ...rest } = data;

    const [existing] = await db
      .select({
        enabled: server.enabled,
        desiredAgentVersion: server.desiredAgentVersion,
        desiredSingBoxVersion: server.desiredSingBoxVersion,
      })
      .from(server)
      .where(eq(server.id, id));
    if (!existing) {
      throw new Error("Not found");
    }

    const [row] = await db
      .update(server)
      .set(rest)
      .where(eq(server.id, id))
      .returning();

    if (!row) {
      throw new Error("Not found");
    }
    // Publish gate: a freshly enabled server's nodes stay out of
    // subscriptions until the agent applies the config that serves them;
    // disabling hides them immediately (safe direction). Address/name edits
    // resolve client-side and change no agent state, so they are not gated.
    if (rest.enabled !== undefined && rest.enabled !== existing.enabled) {
      await recordConfigChange(db, {
        kind: "server",
        subjectId: id,
        prevRow: { enabled: existing.enabled },
        serverIds: [id],
      });
      await notifyAgentConfigChanged([id], "server enabled state changed");
    }

    const agentVersionChanged =
      rest.desiredAgentVersion !== undefined &&
      rest.desiredAgentVersion !== existing.desiredAgentVersion;
    const singBoxVersionChanged =
      rest.desiredSingBoxVersion !== undefined &&
      rest.desiredSingBoxVersion !== existing.desiredSingBoxVersion;
    if (row.enabled && (agentVersionChanged || singBoxVersionChanged)) {
      await notifyAgentUpdateTrigger(id, {
        target:
          agentVersionChanged && singBoxVersionChanged
            ? "all"
            : agentVersionChanged
              ? "agent"
              : "sing-box",
        desiredAgentVersion: row.desiredAgentVersion,
        desiredSingBoxVersion: row.desiredSingBoxVersion,
        force: true,
      });
    }
    return toServerDTO(row);
  });

/**
 * Refuses to delete a server that still has nodes. The FK is RESTRICT in the
 * schema, so even a race here cannot orphan the rows — this check turns the
 * cryptic FK error into a clear user-facing message.
 */
export const deleteServer = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.delete", {
      targetType: "server",
      targetId: fromInput("id"),
    }),
  ])
  .validator(serverIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const row = await deleteServerRecord(data.id, {
      interactive: supportsInteractiveTransactions(getDatabaseDriver()),
    });
    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id };
  });

export const regenerateServerToken = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.regenerate_token", {
      targetType: "server",
      targetId: fromInput("id"),
    }),
  ])
  .validator(serverIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return resetBackupToken(data.id);
  });

/** Backward-compatible alias for the backup-token reset operation. */
async function resetBackupToken(id: string) {
  const credential = generateAgentToken();
  // The rotation also ends a current static v2 session in the same statement,
  // so the old credential's session cannot keep writing. OAuth is untouched.
  const row = await rotateAgentCredential(id, credential);
  if (!row) {
    throw new Error("Not found");
  }
  return { id: row.id, token: credential.token };
}

export const resetServerBackupToken = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.backup_token_reset", {
      targetType: "server",
      targetId: fromInput("id"),
    }),
  ])
  .validator(serverIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return resetBackupToken(data.id);
  });

export const enableServerBackupToken = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.backup_token_enable", {
      targetType: "server",
      targetId: fromInput("id"),
    }),
  ])
  .validator(serverIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const credential = generateAgentToken();
    const row = await enableAgentBackupCredential(data.id, credential);
    if (!row) {
      const [existing] = await db
        .select({ id: server.id })
        .from(server)
        .where(eq(server.id, data.id));
      if (!existing) {
        throw new Error("Not found");
      }
      throw new Error(
        "A static backup token is already enabled; reset it instead.",
      );
    }
    return { id: row.id, token: credential.token };
  });

export const disableServerBackupToken = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.backup_token_disable", {
      targetType: "server",
      targetId: fromInput("id"),
    }),
  ])
  .validator(serverIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const row = await disableAgentBackupCredential(data.id);
    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id };
  });

export const checkServerUpdate = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.check_update", {
      targetType: "server",
      targetId: fromInput("id"),
    }),
  ])
  .validator(serverIdSchema.extend({ target: z.enum(["agent", "sing-box"]) }))
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db
      .select({
        enabled: server.enabled,
        transport: server.transportMode,
        desiredAgentVersion: server.desiredAgentVersion,
        desiredSingBoxVersion: server.desiredSingBoxVersion,
      })
      .from(server)
      .where(eq(server.id, data.id));
    const desired =
      data.target === "agent"
        ? row?.desiredAgentVersion
        : row?.desiredSingBoxVersion;
    if (!row?.enabled || !desired) return "unmanaged";
    if (row.transport !== "ws") return "polling";
    await notifyAgentUpdateTrigger(data.id, {
      target: data.target,
      desiredAgentVersion: row.desiredAgentVersion,
      desiredSingBoxVersion: row.desiredSingBoxVersion,
      force: true,
    });
    return "requested";
  });
