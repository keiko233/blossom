import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { plan, subscription } from "@/db/plan-schema";
import { node, server } from "@/db/proxy-schema";
import { trafficRecord } from "@/db/traffic-schema";
import { ensureSession } from "@/lib/auth";

/** Prefix for the signed-in user's own dashboard data query key. */
export const CURRENT_USER_QUERY_KEY = ["user", "dashboard"] as const;

/**
 * Build a query key scoped to a specific authenticated user so that a
 * logout/login as another account never reads the previous account's cache.
 */
export function currentUserQueryKey(userId: string) {
  return [...CURRENT_USER_QUERY_KEY, userId] as const;
}

/**
 * Read-only view of the current user's subscriptions and recent traffic.
 * User ID is taken exclusively from the server session; no userId input is
 * accepted. Fields are selected explicitly — token is included so the owner can
 * build their subscription URL, but credentialUuid and credentialPassword are
 * never returned.
 */
export const getCurrentUser = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await ensureSession();
    const userId = session.user.id;

    const [subscriptions, trafficRecords] = await Promise.all([
      db
        .select({
          id: subscription.id,
          planName: plan.name,
          status: subscription.status,
          startedAt: subscription.startedAt,
          expiresAt: subscription.expiresAt,
          trafficQuotaBytes: subscription.trafficQuotaBytes,
          trafficUsedBytes: subscription.trafficUsedBytes,
          deviceLimit: subscription.deviceLimit,
          token: subscription.token,
        })
        .from(subscription)
        .innerJoin(plan, eq(plan.id, subscription.planId))
        .where(eq(subscription.userId, userId))
        .orderBy(desc(subscription.createdAt)),
      db
        .select({
          id: trafficRecord.id,
          nodeName: node.name,
          serverName: server.name,
          uplinkBytes: trafficRecord.uplinkBytes,
          downlinkBytes: trafficRecord.downlinkBytes,
          createdAt: trafficRecord.createdAt,
        })
        .from(trafficRecord)
        .leftJoin(node, eq(node.id, trafficRecord.nodeId))
        .leftJoin(server, eq(server.id, trafficRecord.serverId))
        .where(eq(trafficRecord.userId, userId))
        .orderBy(desc(trafficRecord.createdAt))
        .limit(50),
    ]);

    return {
      subscriptions,
      // Map the joined rows onto the table's `sourceName`/`isServer` contract:
      // a non-null node name wins; otherwise fall back to the denormalized
      // server name (true for multi-inbound records whose node has moved /
      // been deleted); finally both null → deleted.
      trafficRecords: trafficRecords.map((r) => ({
        id: r.id,
        sourceName: r.nodeName ?? r.serverName,
        isServer: r.nodeName === null && r.serverName !== null,
        uplinkBytes: r.uplinkBytes,
        downlinkBytes: r.downlinkBytes,
        createdAt: r.createdAt,
      })),
    };
  },
);

export type CurrentUser = Awaited<ReturnType<typeof getCurrentUser>>;
