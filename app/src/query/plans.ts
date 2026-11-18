import {
  createPlanSchema,
  planIdSchema,
  updatePlanSchema,
} from "@blossom/contracts/plan";
import { createServerFn } from "@tanstack/react-start";
import { and, asc, count, desc, eq, gt } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { plan, planGroup, subscription } from "@/db/plan-schema";
import { redeemBatch } from "@/db/redeem-schema";
import type { PlanImpact } from "@/lib/access-impact";
import { fromInput, fromResult } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { notifyAgentConfigChanged } from "@/lib/agent-notifications";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  listServerIdsForGroupIds,
  recordConfigChange,
} from "@/query/config-change";
import { getSettings } from "@/query/settings-store";

/** TanStack Query key for the admin plan list. */
export const PLANS_QUERY_KEY = ["admin", "plans"] as const;

export const listPlans = createServerFn({ method: "GET" }).handler(async () => {
  await ensureAdmin();
  const [plans, bindings, subscriptionCounts] = await Promise.all([
    db.select().from(plan).orderBy(asc(plan.sortOrder), desc(plan.createdAt)),
    db
      .select({ planId: planGroup.planId, groupId: planGroup.groupId })
      .from(planGroup),
    db
      .select({ planId: subscription.planId, count: count() })
      .from(subscription)
      .groupBy(subscription.planId),
  ]);

  // Group ids ride along so pickers can preview the nodes a plan resolves to.
  const groupIdsByPlan = new Map<string, string[]>();
  for (const { planId, groupId } of bindings) {
    const list = groupIdsByPlan.get(planId) ?? [];
    list.push(groupId);
    groupIdsByPlan.set(planId, list);
  }
  const subscriptionCountByPlan = new Map(
    subscriptionCounts.map((row) => [row.planId, row.count]),
  );
  return plans.map((row) => {
    const groupIds = groupIdsByPlan.get(row.id) ?? [];
    return {
      ...row,
      groupIds,
      groupCount: groupIds.length,
      subscriptionCount: subscriptionCountByPlan.get(row.id) ?? 0,
    };
  });
});

export type PlanListItem = Awaited<ReturnType<typeof listPlans>>[number];

export const getPlan = createServerFn({ method: "GET" })
  .validator(planIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db.select().from(plan).where(eq(plan.id, data.id));
    if (!row) {
      throw new Error("Not found");
    }
    const bindings = await db
      .select({ groupId: planGroup.groupId })
      .from(planGroup)
      .where(eq(planGroup.planId, data.id));
    return { ...row, groupIds: bindings.map((binding) => binding.groupId) };
  });

/**
 * Read-only: what refers to a plan, so the edit page and delete confirmation
 * can show it. These mirror the checks `deletePlan` makes, but the mutation
 * re-checks on its own; nothing here is a guarantee.
 */
export const getPlanImpact = createServerFn({ method: "GET" })
  .validator(planIdSchema)
  .handler(async ({ data }): Promise<PlanImpact> => {
    await ensureAdmin();
    const [[subs], [activeSubs], [batches], { trial }] = await Promise.all([
      db
        .select({ count: count() })
        .from(subscription)
        .where(eq(subscription.planId, data.id)),
      db
        .select({ count: count() })
        .from(subscription)
        .where(
          and(
            eq(subscription.planId, data.id),
            eq(subscription.status, "active"),
            gt(subscription.expiresAt, new Date()),
          ),
        ),
      db
        .select({ count: count() })
        .from(redeemBatch)
        .where(eq(redeemBatch.planId, data.id)),
      getSettings(),
    ]);
    return {
      subscriptionCount: subs.count,
      activeSubscriptionCount: activeSubs.count,
      redeemBatchCount: batches.count,
      isTrialPlan: trial.planId === data.id,
    };
  });

export const createPlan = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("plan.create", {
      targetType: "plan",
      targetId: fromResult("id"),
    }),
  ])
  .validator(createPlanSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { groupIds, ...meta } = data;

    // Sequential statements: the neon-http driver has no interactive
    // transactions. Parent row goes first so a partial failure never leaves
    // orphaned junction rows (they cascade on plan delete anyway).
    const [row] = await db
      .insert(plan)
      .values({ id: randomUUID(), ...meta })
      .returning();

    if (groupIds.length > 0) {
      await db
        .insert(planGroup)
        .values(groupIds.map((groupId) => ({ planId: row.id, groupId })));
    }
    return row;
  });

export const updatePlan = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("plan.update", {
      targetType: "plan",
      targetId: fromInput("id"),
    }),
  ])
  .validator(updatePlanSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { id, groupIds, ...meta } = data;

    const [row] = await db
      .update(plan)
      .set(meta)
      .where(eq(plan.id, id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }

    // Replace the full binding list: delete + insert beats diffing at this scale.
    if (groupIds !== undefined) {
      const previousGroupIds = (
        await db
          .select({ groupId: planGroup.groupId })
          .from(planGroup)
          .where(eq(planGroup.planId, id))
      ).map((binding) => binding.groupId);
      await db.delete(planGroup).where(eq(planGroup.planId, id));
      if (groupIds.length > 0) {
        await db
          .insert(planGroup)
          .values(groupIds.map((groupId) => ({ planId: id, groupId })));
      }
      // Publish gate: newly reachable nodes stay out of subscriptions until
      // the hosting agents apply the change; lost nodes drop immediately.
      const unchanged =
        previousGroupIds.length === groupIds.length &&
        previousGroupIds.every((groupId) => groupIds.includes(groupId));
      if (!unchanged) {
        const change = await recordConfigChange(db, {
          kind: "authorization",
          subjectId: id,
          prevRow: { groupIds: previousGroupIds },
          serverIds: await listServerIdsForGroupIds(db, [
            ...new Set([...previousGroupIds, ...groupIds]),
          ]),
        });
        await notifyAgentConfigChanged(change.serverIds, "plan groups changed");
      }
    }
    return row;
  });

export const deletePlan = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("plan.delete", {
      targetType: "plan",
      targetId: fromInput("id"),
    }),
  ])
  .validator(planIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();

    // The new-user trial grants this plan; deleting it would silently turn the
    // trial off. Checked first: the trial plan usually has subscriptions too,
    // and this is the more useful explanation. Nothing in the database
    // references the setting, so this is the only guard.
    const { trial } = await getSettings();
    if (trial.planId === data.id) {
      throw new Error("Plan is the new-user trial plan");
    }

    // Refuse while subscriptions reference the plan (FK is RESTRICT as backstop).
    const [subs] = await db
      .select({ count: count() })
      .from(subscription)
      .where(eq(subscription.planId, data.id));
    if (subs.count > 0) {
      throw new Error("Plan has subscriptions");
    }
    // Same for redeem batches: their plan FK is RESTRICT, so issued codes
    // never end up pointing at nothing.
    const [batches] = await db
      .select({ count: count() })
      .from(redeemBatch)
      .where(eq(redeemBatch.planId, data.id));
    if (batches.count > 0) {
      throw new Error("Plan has redeem batches");
    }

    const [row] = await db.delete(plan).where(eq(plan.id, data.id)).returning();
    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id };
  });
