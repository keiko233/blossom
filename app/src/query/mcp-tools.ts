import { desc, eq } from "drizzle-orm";

import { db, getDatabaseDriver } from "@/db";
import { user } from "@/db/auth-schema";
import { session } from "@/db/auth-schema";
import { plan, type Subscription, subscription } from "@/db/plan-schema";
import { type Node, node, server } from "@/db/proxy-schema";
import { notifyAgentConfigChanged } from "@/lib/agent-notifications";
import { supportsInteractiveTransactions } from "@/lib/env-schema";
import {
  isNodeConfigChange,
  snapshotNodeForGate,
} from "@/lib/node-config-change";
import { parseNodeSettings } from "@/orpc/proxy/schema";
import { withoutNodeTlsMaterial } from "@/orpc/proxy/sing-box-registry";
import {
  type DbHandle,
  type RecordConfigChangeInput,
  type RecordConfigChangeResult,
  listServerIdsForSubscriptionId,
  listServerIdsForUserId,
  recordConfigChange,
} from "@/query/config-change";
import { withDatabaseTransaction } from "@/query/group-membership-write";
import {
  deleteLegacySubscriberNode,
  isLegacyNodeStructuralChange,
  LegacyNodeWriteRejectedError,
  type LegacyNodeWriteRejection,
  writeLegacySubscriberNode,
} from "@/query/managed-topology-write";
import { deleteServerRecord } from "@/query/server-deletion";
import { type ServerDTO, toServerDTO } from "@/query/server-dto";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export type SubscriptionSummary = Omit<
  Subscription,
  "credentialUuid" | "credentialPassword" | "token"
>;

export type UserSummary = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role: string | null;
  banned: boolean | null;
  banReason: string | null;
  banExpires: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function stripSubscriptionCredentials(row: Subscription): SubscriptionSummary {
  const {
    credentialUuid: _credUuid,
    credentialPassword: _credPw,
    token: _token,
    ...rest
  } = row;
  return rest;
}

function toUserSummary(row: typeof user.$inferSelect): UserSummary {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    image: row.image,
    role: row.role,
    banned: row.banned,
    banReason: row.banReason,
    banExpires: row.banExpires,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Runs an entity write and its publish-gate `recordConfigChange` in one
 * transaction on `node-postgres` (sequentially on `neon-http`, which has no
 * interactive transactions). Agent notifications must wait until the
 * transaction has committed; see {@link notifyMCPConfigChange}.
 */
function inMCPTransaction<T>(run: (tx: DbHandle) => Promise<T>): Promise<T> {
  return withDatabaseTransaction(db, getDatabaseDriver(), run);
}

async function notifyMCPConfigChange(
  kind: RecordConfigChangeInput["kind"],
  change: RecordConfigChangeResult | null,
): Promise<void> {
  if (change) {
    await notifyAgentConfigChanged(change.serverIds, `MCP ${kind} change`);
  }
}

export async function requireActorAdmin(actorUserId: string): Promise<void> {
  const [actor] = await db
    .select({ role: user.role, banned: user.banned })
    .from(user)
    .where(eq(user.id, actorUserId));
  if (!actor) throw new Error("Actor not found");
  if (actor.banned) throw new Error("Forbidden");
  if (actor.role !== "admin") throw new Error("Forbidden");
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(limit, MAX_LIMIT));
}

// ── Read tools ───────────────────────────────────────────────────────

export async function listUsersMCP(
  actorUserId: string,
  limit = DEFAULT_LIMIT,
): Promise<UserSummary[]> {
  await requireActorAdmin(actorUserId);
  const rows = await db
    .select()
    .from(user)
    .orderBy(desc(user.createdAt))
    .limit(clampLimit(limit));
  return rows.map(toUserSummary);
}

export async function getUserMCP(
  actorUserId: string,
  targetUserId: string,
): Promise<UserSummary | null> {
  await requireActorAdmin(actorUserId);
  const [row] = await db.select().from(user).where(eq(user.id, targetUserId));
  return row ? toUserSummary(row) : null;
}

export async function listNodesMCP(
  actorUserId: string,
  limit = DEFAULT_LIMIT,
): Promise<Node[]> {
  await requireActorAdmin(actorUserId);
  return db
    .select()
    .from(node)
    .orderBy(desc(node.createdAt))
    .limit(clampLimit(limit));
}

export async function getNodeMCP(
  actorUserId: string,
  nodeId: string,
): Promise<Node | null> {
  await requireActorAdmin(actorUserId);
  const [row] = await db.select().from(node).where(eq(node.id, nodeId));
  return row ?? null;
}

export async function listServersMCP(
  actorUserId: string,
  limit = DEFAULT_LIMIT,
): Promise<ServerDTO[]> {
  await requireActorAdmin(actorUserId);
  const rows = await db
    .select()
    .from(server)
    .orderBy(desc(server.createdAt))
    .limit(clampLimit(limit));
  return rows.map(toServerDTO);
}

export async function getServerMCP(
  actorUserId: string,
  serverId: string,
): Promise<ServerDTO | null> {
  await requireActorAdmin(actorUserId);
  const [row] = await db.select().from(server).where(eq(server.id, serverId));
  return row ? toServerDTO(row) : null;
}

export async function listPlansMCP(
  actorUserId: string,
  limit = DEFAULT_LIMIT,
): Promise<(typeof plan.$inferSelect)[]> {
  await requireActorAdmin(actorUserId);
  return db
    .select()
    .from(plan)
    .orderBy(desc(plan.createdAt))
    .limit(clampLimit(limit));
}

export async function listSubscriptionsMCP(
  actorUserId: string,
  limit = DEFAULT_LIMIT,
): Promise<SubscriptionSummary[]> {
  await requireActorAdmin(actorUserId);
  const rows = await db
    .select()
    .from(subscription)
    .orderBy(desc(subscription.createdAt))
    .limit(clampLimit(limit));
  return rows.map(stripSubscriptionCredentials);
}

// ── Write tools ──────────────────────────────────────────────────────

async function requireUserExists(targetUserId: string): Promise<void> {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, targetUserId));
  if (!row) throw new Error("Not found");
}

export async function banUserMCP(
  actorUserId: string,
  targetUserId: string,
  reason?: string,
  expiresInDays?: number,
): Promise<{ id: string }> {
  await requireActorAdmin(actorUserId);
  if (actorUserId === targetUserId) throw new Error("Cannot ban yourself");

  await requireUserExists(targetUserId);

  const banExpires = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400 * 1000)
    : undefined;

  const change = await inMCPTransaction(async (tx) => {
    // Publish gate: capture the pre-ban state so an unban can be held back
    // until agents serve the user's credentials again.
    const [preBan] = await tx
      .select({ banned: user.banned, banExpires: user.banExpires })
      .from(user)
      .where(eq(user.id, targetUserId));

    await tx
      .update(user)
      .set({
        banned: true,
        banReason: reason ?? null,
        banExpires: banExpires ?? null,
      })
      .where(eq(user.id, targetUserId));

    await tx.delete(session).where(eq(session.userId, targetUserId));

    if (!preBan || preBan.banned) return null;
    return recordConfigChange(tx, {
      kind: "authorization",
      subjectId: targetUserId,
      prevRow: {
        banned: preBan.banned,
        banExpires: preBan.banExpires?.toISOString() ?? null,
      },
      serverIds: await listServerIdsForUserId(tx, targetUserId),
    });
  });
  await notifyMCPConfigChange("authorization", change);

  return { id: targetUserId };
}

export async function unbanUserMCP(
  actorUserId: string,
  targetUserId: string,
): Promise<{ id: string }> {
  await requireActorAdmin(actorUserId);
  await requireUserExists(targetUserId);
  const change = await inMCPTransaction(async (tx) => {
    const [preUnban] = await tx
      .select({ banned: user.banned, banExpires: user.banExpires })
      .from(user)
      .where(eq(user.id, targetUserId));
    await tx
      .update(user)
      .set({ banned: false, banReason: null, banExpires: null })
      .where(eq(user.id, targetUserId));
    if (!preUnban?.banned) return null;
    return recordConfigChange(tx, {
      kind: "authorization",
      subjectId: targetUserId,
      prevRow: {
        banned: preUnban.banned,
        banExpires: preUnban.banExpires?.toISOString() ?? null,
      },
      serverIds: await listServerIdsForUserId(tx, targetUserId),
    });
  });
  await notifyMCPConfigChange("authorization", change);
  return { id: targetUserId };
}

export async function setUserRoleMCP(
  actorUserId: string,
  targetUserId: string,
  role: "admin" | "user",
): Promise<{ id: string }> {
  await requireActorAdmin(actorUserId);
  if (actorUserId === targetUserId && role !== "admin") {
    throw new Error("Cannot demote yourself");
  }
  await requireUserExists(targetUserId);
  await db.update(user).set({ role }).where(eq(user.id, targetUserId));
  return { id: targetUserId };
}

export async function createNodeMCP(
  actorUserId: string,
  input: {
    name: string;
    serverId: string;
    listenPort: number;
    protocol: string;
    settings: Record<string, unknown>;
    remark?: string;
    tags?: string[];
    enabled?: boolean;
    address?: string | null;
  },
): Promise<Node | LegacyNodeWriteRejection> {
  await requireActorAdmin(actorUserId);

  // Strip X.509 material and the raw `server_name` (as `createNode` does) so
  // MCP cannot persist inline certificate fields.
  const settings = parseNodeSettings(
    input.protocol,
    withoutNodeTlsMaterial(input.settings),
  );

  let change: RecordConfigChangeResult | null = null;
  let row: Node;
  try {
    row = await inMCPTransaction(async (tx) => {
      const written = await writeLegacySubscriberNode(
        {
          kind: "create",
          values: {
            id: crypto.randomUUID(),
            name: input.name,
            remark: input.remark ?? null,
            tags: input.tags ?? [],
            enabled: input.enabled ?? true,
            serverId: input.serverId,
            address: input.address ?? null,
            listenPort: input.listenPort,
            protocol: input.protocol,
            settings,
          },
        },
        { database: tx },
      );
      if (!written.ok) {
        if (written.reason === "not_found") {
          throw new Error("Failed to create node");
        }
        throw new LegacyNodeWriteRejectedError(written);
      }
      // Publish gate: hold a newly enabled node out of subscriptions until the
      // agent confirms the revision that first serves it.
      if (written.node.enabled) {
        change = await recordConfigChange(tx, {
          kind: "node",
          subjectId: written.node.id,
          prevRow: null,
          serverIds: [written.node.serverId],
        });
      }
      return written.node;
    });
  } catch (error) {
    if (error instanceof LegacyNodeWriteRejectedError) {
      return error.rejection;
    }
    throw error;
  }
  await notifyMCPConfigChange("node", change);
  return row;
}

export async function updateNodeMCP(
  actorUserId: string,
  nodeId: string,
  input: Partial<{
    name: string;
    remark: string;
    tags: string[];
    enabled: boolean;
    address: string | null;
    listenPort: number;
    protocol: string;
    serverId: string;
    settings: Record<string, unknown>;
  }>,
): Promise<Node | LegacyNodeWriteRejection> {
  await requireActorAdmin(actorUserId);

  if (Object.keys(input).length === 0) {
    throw new Error("Invalid node update: no changes supplied");
  }
  if (input.protocol !== undefined && input.settings === undefined) {
    throw new Error(
      "Invalid node update: settings are required when changing protocol",
    );
  }

  const { protocol, settings, address, ...rest } = input;

  let change: RecordConfigChangeResult | null = null;
  let row: Node;
  try {
    row = await inMCPTransaction(async (tx) => {
      const [existingNode] = await tx
        .select()
        .from(node)
        .where(eq(node.id, nodeId));
      if (!existingNode) throw new Error("Not found");

      const addressUpdate =
        address === undefined
          ? {}
          : { address: address === null ? null : address };

      // Strip X.509 material and the raw `server_name` (as `updateNode` does)
      // before the schema re-validates the fragment.
      const settingsUpdate =
        settings !== undefined
          ? {
              settings: parseNodeSettings(
                protocol ?? existingNode.protocol,
                withoutNodeTlsMaterial(settings),
              ),
            }
          : {};

      // Publish gate: record only changes that alter the compiled agent config
      // or the client connection tuple.
      const after = {
        protocol: protocol ?? existingNode.protocol,
        listenPort: rest.listenPort ?? existingNode.listenPort,
        settings: settingsUpdate.settings ?? existingNode.settings,
        certificateId: existingNode.certificateId,
        tlsServerName: existingNode.tlsServerName,
        serverId: rest.serverId ?? existingNode.serverId,
        enabled: rest.enabled ?? existingNode.enabled,
      };
      const configChanged = isNodeConfigChange(existingNode, after);
      const structural = isLegacyNodeStructuralChange(existingNode, after);
      const prevRow = configChanged
        ? await snapshotNodeForGate(tx, existingNode)
        : null;

      let updated: Node | undefined;
      if (structural) {
        const written = await writeLegacySubscriberNode(
          {
            kind: "update",
            nodeId,
            values: {
              ...rest,
              ...(protocol ? { protocol } : {}),
              ...settingsUpdate,
              ...addressUpdate,
            },
          },
          { database: tx },
        );
        if (!written.ok) {
          if (written.reason === "not_found") throw new Error("Not found");
          throw new LegacyNodeWriteRejectedError(written);
        }
        updated = written.node;
      } else {
        [updated] = await tx
          .update(node)
          .set({
            ...rest,
            ...(protocol ? { protocol } : {}),
            ...settingsUpdate,
            ...addressUpdate,
          })
          .where(eq(node.id, nodeId))
          .returning();
      }
      if (!updated) throw new Error("Not found");
      if (configChanged) {
        change = await recordConfigChange(tx, {
          kind: "node",
          subjectId: nodeId,
          prevRow,
          serverIds: [...new Set([existingNode.serverId, updated.serverId])],
        });
      }
      return updated;
    });
  } catch (error) {
    if (error instanceof LegacyNodeWriteRejectedError) {
      return error.rejection;
    }
    throw error;
  }
  await notifyMCPConfigChange("node", change);
  return row;
}

export async function deleteNodeMCP(
  actorUserId: string,
  nodeId: string,
): Promise<{ id: string } | LegacyNodeWriteRejection> {
  await requireActorAdmin(actorUserId);
  const driver = getDatabaseDriver();
  let changedServerIds: string[] = [];
  let result: { id: string };
  try {
    result = await withDatabaseTransaction(db, driver, async (tx) => {
      const deleted = await deleteLegacySubscriberNode(
        { nodeId },
        { database: tx },
      );
      if (!deleted.ok) {
        if (deleted.reason === "not_found") throw new Error("Not found");
        throw new LegacyNodeWriteRejectedError(deleted);
      }
      const row = deleted.node;
      if (row.enabled) {
        const change = await recordConfigChange(tx, {
          kind: "node",
          subjectId: row.id,
          prevRow: null,
          serverIds: [row.serverId],
        });
        changedServerIds = change.serverIds;
      }
      return { id: row.id };
    });
  } catch (error) {
    if (error instanceof LegacyNodeWriteRejectedError) {
      return error.rejection;
    }
    throw error;
  }
  await notifyAgentConfigChanged(changedServerIds, "MCP node change");
  return result;
}

export async function updateServerMCP(
  actorUserId: string,
  serverId: string,
  input: Partial<{
    name: string;
    remark: string;
    enabled: boolean;
    address: string;
    configPollIntervalSeconds: number;
    heartbeatIntervalSeconds: number;
  }>,
): Promise<ServerDTO> {
  await requireActorAdmin(actorUserId);
  if (Object.keys(input).length === 0) {
    throw new Error("Invalid server update: no changes supplied");
  }
  return writeServerWithGate(serverId, input);
}

export async function enableServerMCP(
  actorUserId: string,
  serverId: string,
): Promise<ServerDTO> {
  await requireActorAdmin(actorUserId);
  return writeServerWithGate(serverId, { enabled: true });
}

export async function disableServerMCP(
  actorUserId: string,
  serverId: string,
): Promise<ServerDTO> {
  await requireActorAdmin(actorUserId);
  return writeServerWithGate(serverId, { enabled: false });
}

/**
 * Updates a server and, when its `enabled` flag flips, records the publish-gate
 * change in the same transaction.
 */
async function writeServerWithGate(
  serverId: string,
  values: Partial<typeof server.$inferInsert>,
): Promise<ServerDTO> {
  let change: RecordConfigChangeResult | null = null;
  const row = await inMCPTransaction(async (tx) => {
    const [existing] = await tx
      .select({ enabled: server.enabled })
      .from(server)
      .where(eq(server.id, serverId));
    if (!existing) throw new Error("Not found");
    const [updated] = await tx
      .update(server)
      .set(values)
      .where(eq(server.id, serverId))
      .returning();
    if (!updated) throw new Error("Not found");
    if (values.enabled !== undefined && values.enabled !== existing.enabled) {
      change = await recordConfigChange(tx, {
        kind: "server",
        subjectId: serverId,
        prevRow: { enabled: existing.enabled },
        serverIds: [serverId],
      });
    }
    return updated;
  });
  await notifyMCPConfigChange("server", change);
  return toServerDTO(row);
}

export async function deleteServerMCP(
  actorUserId: string,
  serverId: string,
): Promise<{ id: string }> {
  await requireActorAdmin(actorUserId);
  const row = await deleteServerRecord(serverId, {
    interactive: supportsInteractiveTransactions(getDatabaseDriver()),
  });
  if (!row) throw new Error("Not found");
  return { id: row.id };
}

export async function updateSubscriptionMCP(
  actorUserId: string,
  subscriptionId: string,
  input: {
    status?: "active" | "expired" | "cancelled";
    expiresAt?: string;
    trafficUsedBytes?: number;
  },
): Promise<SubscriptionSummary> {
  await requireActorAdmin(actorUserId);

  if (Object.keys(input).length === 0) {
    throw new Error("Invalid subscription update: no changes supplied");
  }

  if (input.expiresAt !== undefined) {
    const parsed = new Date(input.expiresAt);
    if (isNaN(parsed.getTime())) {
      throw new Error("Invalid expiresAt: must be a valid date string");
    }
  }

  const { row, change } = await inMCPTransaction(async (tx) => {
    const [existingSub] = await tx
      .select()
      .from(subscription)
      .where(eq(subscription.id, subscriptionId));
    if (!existingSub) throw new Error("Not found");

    const [updated] = await tx
      .update(subscription)
      .set({
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.expiresAt !== undefined
          ? { expiresAt: new Date(input.expiresAt) }
          : {}),
        ...(input.trafficUsedBytes !== undefined
          ? { trafficUsedBytes: input.trafficUsedBytes }
          : {}),
      })
      .where(eq(subscription.id, subscriptionId))
      .returning();
    if (!updated) throw new Error("Not found");
    // Publish gate: re-activations stay hidden from the subscription endpoint
    // until agents serve the user again; de-activations apply immediately.
    const gated =
      (input.status !== undefined && input.status !== existingSub.status) ||
      (input.expiresAt !== undefined &&
        new Date(input.expiresAt).getTime() !==
          existingSub.expiresAt.getTime());
    return {
      row: updated,
      change: gated
        ? await recordSubscriptionAuthorizationChange(
            tx,
            subscriptionId,
            existingSub,
          )
        : null,
    };
  });
  await notifyMCPConfigChange("authorization", change);
  return stripSubscriptionCredentials(row);
}

export async function cancelSubscriptionMCP(
  actorUserId: string,
  subscriptionId: string,
): Promise<SubscriptionSummary> {
  await requireActorAdmin(actorUserId);
  const { row, change } = await inMCPTransaction(async (tx) => {
    const [existingSub] = await tx
      .select()
      .from(subscription)
      .where(eq(subscription.id, subscriptionId));
    if (!existingSub) throw new Error("Not found");
    const [updated] = await tx
      .update(subscription)
      .set({ status: "cancelled" })
      .where(eq(subscription.id, subscriptionId))
      .returning();
    if (!updated) throw new Error("Not found");
    // Cancellation is the safe direction (the subscription endpoint already
    // refuses it); the record only tracks the pending agent-side removal.
    return {
      row: updated,
      change:
        existingSub.status !== "cancelled"
          ? await recordSubscriptionAuthorizationChange(
              tx,
              subscriptionId,
              existingSub,
            )
          : null,
    };
  });
  await notifyMCPConfigChange("authorization", change);
  return stripSubscriptionCredentials(row);
}

async function recordSubscriptionAuthorizationChange(
  tx: DbHandle,
  subscriptionId: string,
  previous: Subscription,
): Promise<RecordConfigChangeResult> {
  return recordConfigChange(tx, {
    kind: "authorization",
    subjectId: subscriptionId,
    prevRow: {
      planId: previous.planId,
      status: previous.status,
      expiresAt: previous.expiresAt.toISOString(),
    },
    serverIds: await listServerIdsForSubscriptionId(tx, subscriptionId),
  });
}

// ── Sing-box documentation ───────────────────────────────────────────

import {
  fetchDocPage,
  searchCatalog,
  type SingBoxDocEntry,
} from "@/orpc/mcp/singbox-docs";

export { validateDocPath } from "@/orpc/mcp/singbox-docs";
export type { SingBoxDocEntry };

export async function searchSingBoxDocs(
  actorUserId: string,
  query: string,
): Promise<SingBoxDocEntry[]> {
  await requireActorAdmin(actorUserId);
  return searchCatalog(query);
}

export async function getSingBoxDoc(
  actorUserId: string,
  path: string,
): Promise<{ path: string; content: string }> {
  await requireActorAdmin(actorUserId);
  return fetchDocPage(path);
}
