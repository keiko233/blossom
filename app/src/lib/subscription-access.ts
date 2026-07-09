import { and, eq, gt, isNull, lt, or } from "drizzle-orm";

import { db } from "@/db";
import { user } from "@/db/auth-schema";
import { planGroup, subscription } from "@/db/plan-schema";
import type { Subscription } from "@/db/plan-schema";
import { node, nodeGroup } from "@/db/proxy-schema";
import type { Node } from "@/db/proxy-schema";

/**
 * Finds an active subscription by its public link token. Returns the
 * subscription together with the user row so callers can enforce bans.
 */
export async function findSubscriptionByToken(
  token: string,
): Promise<{
  subscription: Subscription;
  user: { banned: boolean | null; banExpires: Date | null };
} | null> {
  const [row] = await db
    .select({
      subscription,
      user: { banned: user.banned, banExpires: user.banExpires },
    })
    .from(subscription)
    .innerJoin(user, eq(user.id, subscription.userId))
    .where(eq(subscription.token, token));

  return row ?? null;
}

/**
 * Resolves the nodes a single subscription may access right now. The caller is
 * expected to have already validated the subscription status, expiration, ban
 * state, and traffic quota. This only filters the node side (`enabled = true`
 * and the subscription's plan groups).
 */
export async function getSubscriptionAccessibleNodes(
  subscriptionId: string,
): Promise<Node[]> {
  const rows = await db
    .select({ node })
    .from(subscription)
    .innerJoin(planGroup, eq(planGroup.planId, subscription.planId))
    .innerJoin(nodeGroup, eq(nodeGroup.groupId, planGroup.groupId))
    .innerJoin(node, eq(node.id, nodeGroup.nodeId))
    .where(and(eq(subscription.id, subscriptionId), eq(node.enabled, true)));

  const byId = new Map<string, Node>();
  for (const row of rows) {
    byId.set(row.node.id, row.node);
  }
  return [...byId.values()];
}

/**
 * Resolves the nodes a user may access right now: the union of nodes across
 * all groups bound to the plans of the user's active, unexpired subscriptions.
 * Multiple subscriptions stack. Traffic exhaustion is deliberately not
 * filtered here yet — enforcement is a separate concern.
 *
 * Callers are user-facing endpoints and the subscription compiler, which
 * bring their own auth.
 */
export async function getUserAccessibleNodes(userId: string): Promise<Node[]> {
  const rows = await db
    .select({ node })
    .from(subscription)
    .innerJoin(planGroup, eq(planGroup.planId, subscription.planId))
    .innerJoin(nodeGroup, eq(nodeGroup.groupId, planGroup.groupId))
    .innerJoin(node, eq(node.id, nodeGroup.nodeId))
    .where(
      and(
        eq(subscription.userId, userId),
        eq(subscription.status, "active"),
        gt(subscription.expiresAt, new Date()),
        eq(node.enabled, true),
      ),
    );

  // Dedupe in JS: DISTINCT over jsonb columns is awkward, and overlapping
  // groups across plans produce duplicates.
  const byId = new Map<string, Node>();
  for (const row of rows) {
    byId.set(row.node.id, row.node);
  }
  return [...byId.values()];
}

/**
 * Inverse of `getUserAccessibleNodes`: the subscriptions entitled to use a node
 * right now, i.e. the entries to embed as sing-box inbound users when compiling
 * that node's config. Filters out expired/cancelled subscriptions, banned users
 * (`banned` is trusted only alongside `banExpires` — better-auth clears expired
 * bans lazily), and exhausted quotas (0 means unlimited, mirroring deviceLimit).
 * Enforcement is exactly this filter: a dropped subscription disappears from the
 * config on the agent's next pull.
 *
 * The caller is the token-authenticated agent endpoint.
 */
export async function getNodeActiveSubscriptions(
  nodeId: string,
): Promise<Subscription[]> {
  const now = new Date();
  const rows = await db
    .select({ subscription })
    .from(nodeGroup)
    .innerJoin(planGroup, eq(planGroup.groupId, nodeGroup.groupId))
    .innerJoin(subscription, eq(subscription.planId, planGroup.planId))
    .innerJoin(user, eq(user.id, subscription.userId))
    .where(
      and(
        eq(nodeGroup.nodeId, nodeId),
        eq(subscription.status, "active"),
        gt(subscription.expiresAt, now),
        or(
          isNull(user.banned),
          eq(user.banned, false),
          // Expired temp ban not yet cleared by better-auth. NULL banExpires
          // (permanent ban) yields SQL NULL here, i.e. stays excluded.
          lt(user.banExpires, now),
        ),
        or(
          eq(subscription.trafficQuotaBytes, 0),
          lt(subscription.trafficUsedBytes, subscription.trafficQuotaBytes),
        ),
      ),
    );

  // Overlapping groups across plans produce duplicate rows; dedupe by id.
  const byId = new Map<string, Subscription>();
  for (const row of rows) {
    byId.set(row.subscription.id, row.subscription);
  }
  return [...byId.values()];
}
