import { createServerFn } from "@tanstack/react-start";
import { asc, count, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { plan, planGroup, subscription } from "@/db/plan-schema";
import { nodeGroup, proxyGroup } from "@/db/proxy-schema";
import { summarizeGroupImpact } from "@/lib/access-impact";
import { fromInput, fromResult } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  createGroupSchema,
  deleteGroupSchema,
  groupIdSchema,
  updateGroupSchema,
} from "@/orpc/proxy/schema";
import {
  createGroupWithMembership,
  deleteGroupWithMembership,
  GroupMembershipConflictError,
  listOrderedGroupMembers,
  writeGroupMembership,
} from "@/query/group-membership-write";

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
        .select({
          groupId: nodeGroup.groupId,
          nodeId: nodeGroup.nodeId,
          position: nodeGroup.position,
        })
        .from(nodeGroup)
        .orderBy(
          asc(nodeGroup.groupId),
          asc(nodeGroup.position),
          asc(nodeGroup.nodeId),
        ),
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
    const members = await listOrderedGroupMembers(data.id);
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
    const state = await createGroupWithMembership({ ...meta, nodeIds });
    return state.group;
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
    const { id, nodeIds, expectedRevision, ...meta } = data;
    const result = await writeGroupMembership({
      groupId: id,
      expectedRevision,
      metadata: meta,
      nodeIds,
    });
    if (!result.ok) {
      if (result.reason === "not_found") throw new Error("Not found");
      if (result.reason === "revision_conflict") {
        throw new GroupMembershipConflictError({
          groupId: id,
          expectedRevision: expectedRevision ?? result.currentRevision - 1,
          currentRevision: result.currentRevision,
        });
      }
      if (result.reason === "duplicate_node_ids") {
        throw new Error(
          `Duplicate entrance IDs in group membership: ${result.duplicateNodeIds.join(", ")}`,
        );
      }
      throw new Error("Invalid empty entrance ID in group membership");
    }
    return result.group;
  });

export const deleteGroup = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("group.delete", {
      targetType: "group",
      targetId: fromInput("id"),
    }),
  ])
  .validator(deleteGroupSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const result = await deleteGroupWithMembership({
      groupId: data.id,
      expectedRevision: data.expectedRevision,
    });
    if (!result.ok) {
      if (result.reason === "not_found") throw new Error("Not found");
      throw new GroupMembershipConflictError({
        groupId: data.id,
        expectedRevision: data.expectedRevision ?? result.currentRevision - 1,
        currentRevision: result.currentRevision,
      });
    }
    return { id: result.result.groupId };
  });
