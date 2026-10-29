import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, gt, gte, lte, sql } from "drizzle-orm";

import { db } from "@/db";
import { user } from "@/db/auth-schema";
import { plan, subscription } from "@/db/plan-schema";
import { node, server } from "@/db/proxy-schema";
import { trafficRecord } from "@/db/traffic-schema";
import {
  getExpiringSoonCutoff,
  OVERVIEW_LIST_LIMIT,
  QUOTA_WARNING_PERCENT,
  type ServerAttentionItem,
  summarizeServers,
} from "@/lib/admin-overview";
import { ensureAdmin } from "@/lib/ensure-admin";
import { countPendingConfigChangesByServer } from "@/query/config-change";

/** TanStack Query key for the admin overview dashboard. */
export const ADMIN_OVERVIEW_QUERY_KEY = ["admin", "overview"] as const;

const MS_PER_HOUR = 60 * 60 * 1000;

/** A subscription surfaced on an overview list, with its owner and plan. */
export interface OverviewSubscriptionItem {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  planName: string;
  expiresAt: Date;
  trafficQuotaBytes: number;
  trafficUsedBytes: number;
}

export interface AdminOverview {
  users: { total: number; banned: number };
  /**
   * `active` mirrors `isSubscriptionActive` (status active and not past its
   * expiry); `expiringSoon` / `nearQuota` count active subscriptions only.
   */
  subscriptions: {
    total: number;
    active: number;
    expiringSoon: number;
    nearQuota: number;
  };
  servers: { total: number; online: number; attention: number };
  nodes: { total: number; enabled: number };
  traffic: { last24hBytes: number; last30dBytes: number };
  /** Worst servers first, capped at `OVERVIEW_LIST_LIMIT`. */
  attentionServers: ServerAttentionItem[];
  /** Soonest expiry first, capped at `OVERVIEW_LIST_LIMIT`. */
  expiringSubscriptions: OverviewSubscriptionItem[];
  /** Highest usage first, capped at `OVERVIEW_LIST_LIMIT`. */
  nearQuotaSubscriptions: OverviewSubscriptionItem[];
}

/**
 * Everything the admin overview page shows, in one round trip. Counts and
 * sums are aggregate SQL; only the (few) servers are loaded row-wise because
 * agent liveness is derived in code by `deriveServerHealth`.
 */
export const getAdminOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminOverview> => {
    await ensureAdmin();

    const now = new Date();
    const expiringCutoff = getExpiringSoonCutoff(now.getTime());
    const since24h = new Date(now.getTime() - 24 * MS_PER_HOUR);
    const since30d = new Date(now.getTime() - 30 * 24 * MS_PER_HOUR);

    const isActive = and(
      eq(subscription.status, "active"),
      gt(subscription.expiresAt, now),
    );
    const isExpiringSoon = and(
      isActive,
      lte(subscription.expiresAt, expiringCutoff),
    );
    // Integer math on bigint columns: used * 100 >= quota * percent. Unlimited
    // quotas (0) are excluded explicitly since 0 >= 0 would otherwise match.
    const isNearQuota = and(
      isActive,
      gt(subscription.trafficQuotaBytes, 0),
      sql`${subscription.trafficUsedBytes} * 100 >= ${subscription.trafficQuotaBytes} * ${QUOTA_WARNING_PERCENT}::int`,
    );

    const subscriptionItem = {
      id: subscription.id,
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      planName: plan.name,
      expiresAt: subscription.expiresAt,
      trafficQuotaBytes: subscription.trafficQuotaBytes,
      trafficUsedBytes: subscription.trafficUsedBytes,
    };

    const [
      [userStats],
      [subscriptionStats],
      [nodeStats],
      [trafficStats],
      servers,
      expiringSubscriptions,
      nearQuotaSubscriptions,
    ] = await Promise.all([
      db
        .select({
          total: sql<number>`count(*)::int`,
          banned: sql<number>`count(*) filter (where ${user.banned} = true)::int`,
        })
        .from(user),
      db
        .select({
          total: sql<number>`count(*)::int`,
          active: sql<number>`count(*) filter (where ${isActive})::int`,
          expiringSoon: sql<number>`count(*) filter (where ${isExpiringSoon})::int`,
          nearQuota: sql<number>`count(*) filter (where ${isNearQuota})::int`,
        })
        .from(subscription),
      db
        .select({
          total: sql<number>`count(*)::int`,
          enabled: sql<number>`count(*) filter (where ${node.enabled} = true)::int`,
        })
        .from(node),
      db
        .select({
          last24h: sql<number>`coalesce(sum(${trafficRecord.uplinkBytes} + ${trafficRecord.downlinkBytes}) filter (where ${gte(trafficRecord.createdAt, since24h)}), 0)::float8`,
          last30d: sql<number>`coalesce(sum(${trafficRecord.uplinkBytes} + ${trafficRecord.downlinkBytes}), 0)::float8`,
        })
        .from(trafficRecord)
        .where(gte(trafficRecord.createdAt, since30d)),
      db
        .select({
          id: server.id,
          name: server.name,
          address: server.address,
          enabled: server.enabled,
          lastSeenAt: server.lastSeenAt,
          heartbeatIntervalSeconds: server.heartbeatIntervalSeconds,
          runtimeState: server.runtimeState,
          configState: server.configState,
          appliedRevision: server.appliedRevision,
          activeNodeIds: server.activeNodeIds,
          lastErrorMessage: server.lastErrorMessage,
        })
        .from(server),
      db
        .select(subscriptionItem)
        .from(subscription)
        .innerJoin(user, eq(user.id, subscription.userId))
        .innerJoin(plan, eq(plan.id, subscription.planId))
        .where(isExpiringSoon)
        .orderBy(asc(subscription.expiresAt))
        .limit(OVERVIEW_LIST_LIMIT),
      db
        .select(subscriptionItem)
        .from(subscription)
        .innerJoin(user, eq(user.id, subscription.userId))
        .innerJoin(plan, eq(plan.id, subscription.planId))
        .where(isNearQuota)
        .orderBy(
          desc(
            sql`${subscription.trafficUsedBytes}::float8 / ${subscription.trafficQuotaBytes}`,
          ),
        )
        .limit(OVERVIEW_LIST_LIMIT),
    ]);

    const pendingByServer = await countPendingConfigChangesByServer(
      servers.map((row) => row.id),
    );
    const serverSummary = summarizeServers(
      servers,
      pendingByServer,
      now.getTime(),
    );

    return {
      users: {
        total: userStats?.total ?? 0,
        banned: userStats?.banned ?? 0,
      },
      subscriptions: {
        total: subscriptionStats?.total ?? 0,
        active: subscriptionStats?.active ?? 0,
        expiringSoon: subscriptionStats?.expiringSoon ?? 0,
        nearQuota: subscriptionStats?.nearQuota ?? 0,
      },
      servers: {
        total: serverSummary.total,
        online: serverSummary.online,
        attention: serverSummary.attention.length,
      },
      nodes: {
        total: nodeStats?.total ?? 0,
        enabled: nodeStats?.enabled ?? 0,
      },
      traffic: {
        last24hBytes: Number(trafficStats?.last24h ?? 0),
        last30dBytes: Number(trafficStats?.last30d ?? 0),
      },
      attentionServers: serverSummary.attention.slice(0, OVERVIEW_LIST_LIMIT),
      expiringSubscriptions,
      nearQuotaSubscriptions,
    };
  },
);
