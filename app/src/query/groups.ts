import { createServerFn } from "@tanstack/react-start";
import { asc, count, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { plan, planGroup, subscription } from "@/db/plan-schema";
import { nodeGroup, proxyGroup } from "@/db/proxy-schema";
import { summarizeGroupImpact } from "@/lib/access-impact";
import { fromInput, fromResult } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  createGroupSchema,
  groupIdSchema,
  updateGroupSchema,
} from "@/orpc/proxy/schema";
import {
  listServerIdsForGroupIds,
  listServerIdsForNodeIds,
  recordConfigChange,
} from "@/query/config-change";

/** TanStack Query key for the admin group list. */
export const GROUPS_QUERY_KEY = ["admin", "groups"] as const;

export const listGroups = createServerFn({ method: "GET" }).handler(
  async () => {
    await ensureAdmin();
    const [groups, memberships, planCounts] = await Promise.all([
      db
        .select()
        .from(proxyGroup)
        .orderBy(asc(proxyGroup.sortOrder), desc(proxyGroup.createdAt)),
      db
        .select({ groupId: nodeGroup.groupId, nodeId: nodeGroup.nodeId })
        .from(nodeGroup),
      db
        .select({ groupId: planGroup.groupId, count: count() })
        .from(planGroup)
        .groupBy(planGroup.groupId),
    ]);

    // Member ids ride along so the plan form can preview the nodes a set of
    // groups resolves to without one request per group.
    const nodeIdsByGroup = new Map<string, string[]>();
    for (const { groupId, nodeId } of memberships) {
      const list = nodeIdsByGroup.get(groupId) ?? [];
      list.push(nodeId);
      nodeIdsByGroup.set(groupId, list);
    }
    const planCountByGroup = new Map(
      planCounts.map((row) => [row.groupId, row.count]),
    );
    return groups.map((group) => {
      const nodeIds = nodeIdsByGroup.get(group.id) ?? [];
      return {
        ...group,
        nodeIds,
        nodeCount: nodeIds.length,
        planCount: planCountByGroup.get(group.id) ?? 0,
      };
    });
  },
);

export type GroupListItem = Awaited<ReturnType<typeof listGroups>>[number];

export const getGroup = createServerFn({ method: "GET" })
  .validator(groupIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db
      .select()
      .from(proxyGroup)
      .where(eq(proxyGroup.id, data.id));
    if (!row) {
      throw new Error("Not found");
    }
    const members = await db
      .select({ nodeId: nodeGroup.nodeId })
      .from(nodeGroup)
      .where(eq(nodeGroup.groupId, data.id));
    return { ...row, nodeIds: members.map((member) => member.nodeId) };
  });

/**
 * Read-only: the plans that bind a group and how many subscriptions sit on
 * each, for the edit page and the delete confirmation. Advisory only; the
 * mutation does not depend on it.
 */
export const getGroupImpact = createServerFn({ method: "GET" })
  .validator(groupIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const rows = await db
      .select({
        id: plan.id,
        name: plan.name,
        subscriptionCount: count(subscription.id),
      })
      .from(planGroup)
      .innerJoin(plan, eq(plan.id, planGroup.planId))
      .leftJoin(subscription, eq(subscription.planId, plan.id))
      .where(eq(planGroup.groupId, data.id))
      .groupBy(plan.id, plan.name, plan.sortOrder)
      .orderBy(asc(plan.sortOrder), asc(plan.name));
    return summarizeGroupImpact(rows);
  });

export const createGroup = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("group.create", {
      targetType: "group",
      targetId: fromResult("id"),
    }),
  ])
  .validator(createGroupSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { nodeIds, ...meta } = data;

    // Sequential statements: the neon-http driver has no interactive
    // transactions. Parent row goes first so a partial failure never leaves
    // orphaned junction rows (they cascade on group delete anyway).
    const [row] = await db
      .insert(proxyGroup)
      .values({ id: randomUUID(), ...meta })
      .returning();

    if (nodeIds.length > 0) {
      await db
        .insert(nodeGroup)
        .values(nodeIds.map((nodeId) => ({ nodeId, groupId: row.id })));
    }
    return row;
  });

export const updateGroup = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("group.update", {
      targetType: "group",
      targetId: fromInput("id"),
    }),
  ])
  .validator(updateGroupSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { id, nodeIds, ...meta } = data;

    const [row] = await db
      .update(proxyGroup)
      .set(meta)
      .where(eq(proxyGroup.id, id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }

    // Replace the full membership: delete + insert beats diffing at this scale.
    if (nodeIds !== undefined) {
      const previousNodeIds = (
        await db
          .select({ nodeId: nodeGroup.nodeId })
          .from(nodeGroup)
          .where(eq(nodeGroup.groupId, id))
      ).map((member) => member.nodeId);
      await db.delete(nodeGroup).where(eq(nodeGroup.groupId, id));
      if (nodeIds.length > 0) {
        await db
          .insert(nodeGroup)
          .values(nodeIds.map((nodeId) => ({ nodeId, groupId: id })));
      }
      // Publish gate: newly membered nodes stay out of subscriptions until
      // the hosting agents apply the change; removed nodes drop immediately.
      const unchanged =
        previousNodeIds.length === nodeIds.length &&
        previousNodeIds.every((nodeId) => nodeIds.includes(nodeId));
      if (!unchanged) {
        await recordConfigChange(db, {
          kind: "authorization",
          subjectId: id,
          prevRow: { nodeIds: previousNodeIds },
          serverIds: await listServerIdsForNodeIds(db, [
            ...new Set([...previousNodeIds, ...nodeIds]),
          ]),
        });
      }
    }
    return row;
  });

export const deleteGroup = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("group.delete", {
      targetType: "group",
      targetId: fromInput("id"),
    }),
  ])
  .validator(groupIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    // Publish gate: capture membership before the cascade wipes it so the
    // affected servers' agents get a revision bump for the removal.
    const previousNodeIds = (
      await db
        .select({ nodeId: nodeGroup.nodeId })
        .from(nodeGroup)
        .where(eq(nodeGroup.groupId, data.id))
    ).map((member) => member.nodeId);
    const serverIds = await listServerIdsForGroupIds(db, [data.id]);
    const [row] = await db
      .delete(proxyGroup)
      .where(eq(proxyGroup.id, data.id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }
    if (previousNodeIds.length > 0) {
      await recordConfigChange(db, {
        kind: "authorization",
        subjectId: data.id,
        prevRow: { nodeIds: previousNodeIds },
        serverIds,
      });
    }
    return { id: row.id };
  });
