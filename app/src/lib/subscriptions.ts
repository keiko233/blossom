import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, gt } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { user } from "@/db/auth-schema";
import { plan, planGroup, subscription } from "@/db/plan-schema";
import { node, nodeGroup } from "@/db/proxy-schema";
import type { Node } from "@/db/proxy-schema";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  createSubscriptionSchema,
  subscriptionIdSchema,
  updateSubscriptionSchema,
} from "@/orpc/plan/schema";

/** TanStack Query key for the admin subscription list. */
export const SUBSCRIPTIONS_QUERY_KEY = ["admin", "subscriptions"] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const listSubscriptions = createServerFn({ method: "GET" }).handler(
  async () => {
    await ensureAdmin();
    return db
      .select({
        subscription,
        userName: user.name,
        userEmail: user.email,
        planName: plan.name,
      })
      .from(subscription)
      .innerJoin(user, eq(user.id, subscription.userId))
      .innerJoin(plan, eq(plan.id, subscription.planId))
      .orderBy(desc(subscription.createdAt));
  },
);

export const createSubscription = createServerFn({ method: "POST" })
  .validator(createSubscriptionSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();

    const [planRow] = await db
      .select()
      .from(plan)
      .where(eq(plan.id, data.planId));
    if (!planRow) {
      throw new Error("Plan not found");
    }

    const startedAt = data.startedAt ? new Date(data.startedAt) : new Date();
    const expiresAt = new Date(
      startedAt.getTime() + planRow.durationDays * MS_PER_DAY,
    );

    // Quota and device limit are snapshotted so later plan edits don't affect
    // already-sold subscriptions.
    const [row] = await db
      .insert(subscription)
      .values({
        id: randomUUID(),
        userId: data.userId,
        planId: data.planId,
        startedAt,
        expiresAt,
        trafficQuotaBytes: planRow.trafficBytes,
        deviceLimit: planRow.deviceLimit,
      })
      .returning();
    return row;
  });

export const updateSubscription = createServerFn({ method: "POST" })
  .validator(updateSubscriptionSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { id, expiresAt, ...rest } = data;

    const [row] = await db
      .update(subscription)
      .set({
        ...rest,
        ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
      })
      .where(eq(subscription.id, id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }
    return row;
  });

export const deleteSubscription = createServerFn({ method: "POST" })
  .validator(subscriptionIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db
      .delete(subscription)
      .where(eq(subscription.id, data.id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id };
  });

/**
 * Resolves the nodes a user may access right now: the union of nodes across
 * all groups bound to the plans of the user's active, unexpired subscriptions.
 * Multiple subscriptions stack. Traffic exhaustion is deliberately not
 * filtered here yet — enforcement is a separate concern.
 *
 * Plain helper (not a server function): callers are user-facing endpoints and
 * the subscription compiler, which bring their own auth.
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
