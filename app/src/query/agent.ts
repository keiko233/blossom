import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { subscription } from "@/db/plan-schema";
import { node, server, type Server } from "@/db/proxy-schema";
import { trafficRecord, type NewTrafficRecord } from "@/db/traffic-schema";

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
  agentVersion: string | undefined,
): Promise<void> {
  await db
    .update(server)
    .set({ lastSeenAt: new Date(), agentVersion })
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
