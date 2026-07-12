import { createServerFn } from "@tanstack/react-start";
import { asc, count, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { planGroup } from "@/db/plan-schema";
import { nodeGroup, proxyGroup } from "@/db/proxy-schema";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  createGroupSchema,
  groupIdSchema,
  updateGroupSchema,
} from "@/orpc/proxy/schema";

/** TanStack Query key for the admin group list. */
export const GROUPS_QUERY_KEY = ["admin", "groups"] as const;

export const listGroups = createServerFn({ method: "GET" }).handler(
  async () => {
    await ensureAdmin();
    const [groups, nodeCounts, planCounts] = await Promise.all([
      db
        .select()
        .from(proxyGroup)
        .orderBy(asc(proxyGroup.sortOrder), desc(proxyGroup.createdAt)),
      db
        .select({ groupId: nodeGroup.groupId, count: count() })
        .from(nodeGroup)
        .groupBy(nodeGroup.groupId),
      db
        .select({ groupId: planGroup.groupId, count: count() })
        .from(planGroup)
        .groupBy(planGroup.groupId),
    ]);

    const nodeCountByGroup = new Map(
      nodeCounts.map((row) => [row.groupId, row.count]),
    );
    const planCountByGroup = new Map(
      planCounts.map((row) => [row.groupId, row.count]),
    );
    return groups.map((group) => ({
      ...group,
      nodeCount: nodeCountByGroup.get(group.id) ?? 0,
      planCount: planCountByGroup.get(group.id) ?? 0,
    }));
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

export const createGroup = createServerFn({ method: "POST" })
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
      await db.delete(nodeGroup).where(eq(nodeGroup.groupId, id));
      if (nodeIds.length > 0) {
        await db
          .insert(nodeGroup)
          .values(nodeIds.map((nodeId) => ({ nodeId, groupId: id })));
      }
    }
    return row;
  });

export const deleteGroup = createServerFn({ method: "POST" })
  .validator(groupIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db
      .delete(proxyGroup)
      .where(eq(proxyGroup.id, data.id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id };
  });
