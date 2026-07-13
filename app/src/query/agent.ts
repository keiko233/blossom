import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";

import { db } from "@/db";
import { subscription } from "@/db/plan-schema";
import { node, server, type Server } from "@/db/proxy-schema";
import { trafficRecord, type NewTrafficRecord } from "@/db/traffic-schema";
import type { heartbeatSchema } from "@/orpc/proxy/schema";

type AgentHeartbeat = z.infer<typeof heartbeatSchema>;

export async function findAgentServerByTokenHash(
  tokenHash: string,
): Promise<Server | null> {
  const [row] = await db
    .select()
    .from(server)
    .where(eq(server.agentTokenHash, tokenHash));
  return row ?? null;
}

export async function listEnabledServerNodes(serverId: string) {
  return db
    .select()
    .from(node)
    .where(and(eq(node.serverId, serverId), eq(node.enabled, true)))
    .orderBy(asc(node.id));
}

export async function updateAgentHeartbeat(
  serverId: string,
  input: AgentHeartbeat,
): Promise<void> {
  const hasStatus =
    input.runtimeState !== undefined ||
    input.configState !== undefined ||
    input.observedRevision !== undefined ||
    input.appliedRevision !== undefined ||
    input.error !== undefined ||
    input.clearError !== undefined;
  const error = input.error;
  const sanitizeMessage = (message: string) =>
    [...message]
      .filter((character) => {
        const code = character.charCodeAt(0);
        return (
          code === 9 ||
          code === 10 ||
          code === 13 ||
          (code >= 32 && code !== 127)
        );
      })
      .join("")
      .replace(/\/tmp\/[^\s:]+/g, "<config>")
      .replace(
        /("[^"]*(?:password|token|secret|private_key)[^"]*"\s*:\s*")[^"]*/gi,
        "$1<redacted>",
      )
      .slice(0, 4096);

  await db
    .update(server)
    .set({
      lastSeenAt: new Date(),
      ...(input.agentVersion !== undefined
        ? { agentVersion: input.agentVersion }
        : {}),
      ...(input.singBoxVersion !== undefined
        ? { singBoxVersion: input.singBoxVersion }
        : {}),
      ...(input.runtimeState !== undefined
        ? { runtimeState: input.runtimeState }
        : {}),
      ...(input.configState !== undefined
        ? { configState: input.configState }
        : {}),
      ...(input.observedRevision !== undefined
        ? { observedRevision: input.observedRevision }
        : {}),
      ...(input.appliedRevision !== undefined
        ? { appliedRevision: input.appliedRevision }
        : {}),
      ...(input.clearActiveNodeIds
        ? { activeNodeIds: [] }
        : input.activeNodeIds !== undefined
          ? { activeNodeIds: input.activeNodeIds }
          : {}),
      ...(hasStatus ? { statusReportedAt: new Date() } : {}),
      ...(!hasStatus
        ? {
            runtimeState: "unknown" as const,
            configState: "unknown" as const,
            activeNodeIds: [],
            statusReportedAt: null,
            lastErrorPhase: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            lastErrorNodeId: null,
            lastErrorAt: null,
          }
        : {}),
      ...(input.appliedAt !== undefined
        ? { lastAppliedAt: new Date(input.appliedAt) }
        : {}),
      ...(input.clearError
        ? {
            lastErrorPhase: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            lastErrorNodeId: null,
            lastErrorAt: null,
          }
        : error === undefined
          ? {}
          : {
              lastErrorPhase: error.phase,
              lastErrorCode: error.code,
              lastErrorMessage: sanitizeMessage(error.message),
              lastErrorNodeId: error.nodeId ?? null,
              lastErrorAt: error.occurredAt
                ? new Date(error.occurredAt)
                : new Date(),
            }),
    })
    .where(eq(server.id, serverId));
}

export async function listServerNodeIds(serverId: string): Promise<string[]> {
  const rows = await db
    .select({ id: node.id })
    .from(node)
    .where(eq(node.serverId, serverId));
  return rows.map((row) => row.id);
}

export async function getSubscriptionUserMap(
  subscriptionIds: string[],
): Promise<Map<string, string>> {
  if (subscriptionIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: subscription.id, userId: subscription.userId })
    .from(subscription)
    .where(inArray(subscription.id, subscriptionIds));
  return new Map(rows.map((row) => [row.id, row.userId]));
}

/**
 * Appends traffic history before incrementing quota counters. The Neon HTTP
 * driver has no interactive transactions, so this preserves the existing
 * retry semantics: a partial failure may over-log but never double-count quota.
 */
export async function recordAgentTraffic(
  records: NewTrafficRecord[],
  deltaBySubscription: ReadonlyMap<string, number>,
): Promise<void> {
  await db.insert(trafficRecord).values(records);

  for (const [subscriptionId, delta] of deltaBySubscription) {
    await db
      .update(subscription)
      .set({
        trafficUsedBytes: sql`${subscription.trafficUsedBytes} + ${delta}`,
      })
      .where(eq(subscription.id, subscriptionId));
  }
}
