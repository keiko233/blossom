import { count, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { user } from "@/db/auth-schema";
import { session } from "@/db/auth-schema";
import { plan, type Subscription, subscription } from "@/db/plan-schema";
import { type Node, node, type Server, server } from "@/db/proxy-schema";
import {
  isNodeConfigChange,
  snapshotNodeForGate,
} from "@/lib/node-config-change";
import { parseNodeSettings } from "@/orpc/proxy/schema";
import {
  listServerIdsForSubscriptionId,
  listServerIdsForUserId,
  recordConfigChange,
} from "@/query/config-change";
import type { ServerDTO } from "@/query/servers";

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

function stripAgentTokenHash(row: Server): ServerDTO {
  const { agentTokenHash: _, ...rest } = row;
  return rest;
}

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
  return rows.map(stripAgentTokenHash);
}

export async function getServerMCP(
  actorUserId: string,
  serverId: string,
): Promise<ServerDTO | null> {
  await requireActorAdmin(actorUserId);
  const [row] = await db.select().from(server).where(eq(server.id, serverId));
  return row ? stripAgentTokenHash(row) : null;
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

  // Publish gate: capture the pre-ban state so an unban can be held back
  // until agents serve the user's credentials again.
  const [preBan] = await db
    .select({ banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, targetUserId));

  const banExpires = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400 * 1000)
    : undefined;

  await db
    .update(user)
    .set({
      banned: true,
      banReason: reason ?? null,
      banExpires: banExpires ?? null,
    })
    .where(eq(user.id, targetUserId));

  await db.delete(session).where(eq(session.userId, targetUserId));

  if (preBan && !preBan.banned) {
    await recordConfigChange(db, {
      kind: "authorization",
      subjectId: targetUserId,
      prevRow: {
        banned: preBan.banned,
        banExpires: preBan.banExpires?.toISOString() ?? null,
      },
      serverIds: await listServerIdsForUserId(db, targetUserId),
    });
  }

  return { id: targetUserId };
}

export async function unbanUserMCP(
  actorUserId: string,
  targetUserId: string,
): Promise<{ id: string }> {
  await requireActorAdmin(actorUserId);
  await requireUserExists(targetUserId);
  const [preUnban] = await db
    .select({ banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, targetUserId));
  await db
    .update(user)
    .set({ banned: false, banReason: null, banExpires: null })
    .where(eq(user.id, targetUserId));
  if (preUnban?.banned) {
    await recordConfigChange(db, {
      kind: "authorization",
      subjectId: targetUserId,
      prevRow: {
        banned: preUnban.banned,
        banExpires: preUnban.banExpires?.toISOString() ?? null,
      },
      serverIds: await listServerIdsForUserId(db, targetUserId),
    });
  }
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
): Promise<Node> {
  await requireActorAdmin(actorUserId);

  const validatedSettings = parseNodeSettings(input.protocol, input.settings);

  const [row] = await db
    .insert(node)
    .values({
      id: crypto.randomUUID(),
      name: input.name,
      remark: input.remark ?? null,
      tags: input.tags ?? [],
      enabled: input.enabled ?? true,
      serverId: input.serverId,
      address: input.address ?? null,
      listenPort: input.listenPort,
      protocol: input.protocol,
      settings: validatedSettings,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  // Publish gate: hold a newly enabled node out of subscriptions until the
  // agent confirms the revision that first serves it.
  if (row.enabled) {
    await recordConfigChange(db, {
      kind: "node",
      subjectId: row.id,
      prevRow: null,
      serverIds: [row.serverId],
    });
  }
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
): Promise<Node> {
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

  const [existingNode] = await db
    .select()
    .from(node)
    .where(eq(node.id, nodeId));
  if (!existingNode) throw new Error("Not found");

  let effectiveProtocol: string | undefined;
  if (settings !== undefined) {
    effectiveProtocol = protocol;
    if (!effectiveProtocol) {
      effectiveProtocol = existingNode.protocol;
    }
  }

  const addressUpdate =
    address === undefined ? {} : { address: address === null ? null : address };

  const settingsUpdate =
    settings !== undefined
      ? { settings: parseNodeSettings(effectiveProtocol!, settings) }
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
  const prevRow = configChanged
    ? await snapshotNodeForGate(db, existingNode)
    : null;

  const [row] = await db
    .update(node)
    .set({
      ...rest,
      ...(protocol ? { protocol } : {}),
      ...settingsUpdate,
      ...addressUpdate,
    })
    .where(eq(node.id, nodeId))
    .returning();
  if (!row) throw new Error("Not found");
  if (configChanged) {
    await recordConfigChange(db, {
      kind: "node",
      subjectId: nodeId,
      prevRow,
      serverIds: [...new Set([existingNode.serverId, row.serverId])],
    });
  }
  return row;
}

export async function deleteNodeMCP(
  actorUserId: string,
  nodeId: string,
): Promise<{ id: string }> {
  await requireActorAdmin(actorUserId);
  const [row] = await db.delete(node).where(eq(node.id, nodeId)).returning();
  if (!row) throw new Error("Not found");
  if (row.enabled) {
    await recordConfigChange(db, {
      kind: "node",
      subjectId: row.id,
      prevRow: null,
      serverIds: [row.serverId],
    });
  }
  return { id: row.id };
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
  const [existingServer] = await db
    .select({ enabled: server.enabled })
    .from(server)
    .where(eq(server.id, serverId));
  if (!existingServer) throw new Error("Not found");
  const [row] = await db
    .update(server)
    .set(input)
    .where(eq(server.id, serverId))
    .returning();
  if (!row) throw new Error("Not found");
  if (input.enabled !== undefined && input.enabled !== existingServer.enabled) {
    await recordConfigChange(db, {
      kind: "server",
      subjectId: serverId,
      prevRow: { enabled: existingServer.enabled },
      serverIds: [serverId],
    });
  }
  return stripAgentTokenHash(row);
}

export async function enableServerMCP(
  actorUserId: string,
  serverId: string,
): Promise<ServerDTO> {
  await requireActorAdmin(actorUserId);
  const [existing] = await db
    .select({ enabled: server.enabled })
    .from(server)
    .where(eq(server.id, serverId));
  if (!existing) throw new Error("Not found");
  const [row] = await db
    .update(server)
    .set({ enabled: true })
    .where(eq(server.id, serverId))
    .returning();
  if (!row) throw new Error("Not found");
  if (!existing.enabled) {
    await recordConfigChange(db, {
      kind: "server",
      subjectId: serverId,
      prevRow: { enabled: false },
      serverIds: [serverId],
    });
  }
  return stripAgentTokenHash(row);
}

export async function disableServerMCP(
  actorUserId: string,
  serverId: string,
): Promise<ServerDTO> {
  await requireActorAdmin(actorUserId);
  const [existing] = await db
    .select({ enabled: server.enabled })
    .from(server)
    .where(eq(server.id, serverId));
  if (!existing) throw new Error("Not found");
  const [row] = await db
    .update(server)
    .set({ enabled: false })
    .where(eq(server.id, serverId))
    .returning();
  if (!row) throw new Error("Not found");
  if (existing.enabled) {
    await recordConfigChange(db, {
      kind: "server",
      subjectId: serverId,
      prevRow: { enabled: true },
      serverIds: [serverId],
    });
  }
  return stripAgentTokenHash(row);
}

export async function deleteServerMCP(
  actorUserId: string,
  serverId: string,
): Promise<{ id: string }> {
  await requireActorAdmin(actorUserId);

  const [countRow] = await db
    .select({ count: count() })
    .from(node)
    .where(eq(node.serverId, serverId));
  if ((countRow?.count ?? 0) > 0) {
    throw new Error(
      "Server still has nodes; move or delete them before removing it.",
    );
  }

  const [row] = await db
    .delete(server)
    .where(eq(server.id, serverId))
    .returning();
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

  const [existingSub] = await db
    .select()
    .from(subscription)
    .where(eq(subscription.id, subscriptionId));
  if (!existingSub) throw new Error("Not found");

  const [row] = await db
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
  if (!row) throw new Error("Not found");
  // Publish gate: re-activations stay hidden from the subscription endpoint
  // until agents serve the user again; de-activations apply immediately.
  if (
    (input.status !== undefined && input.status !== existingSub.status) ||
    (input.expiresAt !== undefined &&
      new Date(input.expiresAt).getTime() !== existingSub.expiresAt.getTime())
  ) {
    await recordConfigChange(db, {
      kind: "authorization",
      subjectId: subscriptionId,
      prevRow: {
        planId: existingSub.planId,
        status: existingSub.status,
        expiresAt: existingSub.expiresAt.toISOString(),
      },
      serverIds: await listServerIdsForSubscriptionId(db, subscriptionId),
    });
  }
  return stripSubscriptionCredentials(row);
}

export async function cancelSubscriptionMCP(
  actorUserId: string,
  subscriptionId: string,
): Promise<SubscriptionSummary> {
  await requireActorAdmin(actorUserId);
  const [existingSub] = await db
    .select()
    .from(subscription)
    .where(eq(subscription.id, subscriptionId));
  if (!existingSub) throw new Error("Not found");
  const [row] = await db
    .update(subscription)
    .set({ status: "cancelled" })
    .where(eq(subscription.id, subscriptionId))
    .returning();
  if (!row) throw new Error("Not found");
  // Cancellation is the safe direction (the subscription endpoint already
  // refuses it); the record only tracks the pending agent-side removal.
  if (existingSub.status !== "cancelled") {
    await recordConfigChange(db, {
      kind: "authorization",
      subjectId: subscriptionId,
      prevRow: {
        planId: existingSub.planId,
        status: existingSub.status,
        expiresAt: existingSub.expiresAt.toISOString(),
      },
      serverIds: await listServerIdsForSubscriptionId(db, subscriptionId),
    });
  }
  return stripSubscriptionCredentials(row);
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
