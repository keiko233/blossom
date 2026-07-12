import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { count, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { user } from "@/db/auth-schema";
import { plan, subscription } from "@/db/plan-schema";
import { node, server } from "@/db/proxy-schema";
import { trafficRecord } from "@/db/traffic-schema";
import { getAuth } from "@/lib/auth";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  banUserSchema,
  setUserRoleSchema,
  userIdSchema,
} from "@/orpc/user/schema";

/** TanStack Query key for the admin user list. */
export const USERS_QUERY_KEY = ["admin", "users"] as const;

const SECONDS_PER_DAY = 24 * 60 * 60;

export const listUsers = createServerFn({ method: "GET" }).handler(async () => {
  await ensureAdmin();
  const [users, subCounts] = await Promise.all([
    db.select().from(user).orderBy(desc(user.createdAt)),
    db
      .select({ userId: subscription.userId, count: count() })
      .from(subscription)
      .groupBy(subscription.userId),
  ]);

  const subCountByUser = new Map(
    subCounts.map((row) => [row.userId, row.count]),
  );
  return users.map((row) => ({
    ...row,
    subscriptionCount: subCountByUser.get(row.id) ?? 0,
  }));
});

export type UserListItem = Awaited<ReturnType<typeof listUsers>>[number];

/**
 * Everything the user detail page shows: the user row, their subscriptions
 * (with plan names and proxy credentials — this is an admin-only surface),
 * and the most recent traffic reports.
 */
export const getUserDetail = createServerFn({ method: "GET" })
  .validator(userIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db.select().from(user).where(eq(user.id, data.id));
    if (!row) {
      throw new Error("Not found");
    }

    const [subscriptions, traffic] = await Promise.all([
      db
        .select({ subscription, planName: plan.name })
        .from(subscription)
        .innerJoin(plan, eq(plan.id, subscription.planId))
        .where(eq(subscription.userId, data.id))
        .orderBy(desc(subscription.createdAt)),
      // Left-join both node and server: a deleted node nulls nodeName and the
      // denormalized serverId still points at the producing host if it
      // survives. Both gone → deleted.
      db
        .select({
          record: trafficRecord,
          nodeName: node.name,
          serverName: server.name,
        })
        .from(trafficRecord)
        .leftJoin(node, eq(node.id, trafficRecord.nodeId))
        .leftJoin(server, eq(server.id, trafficRecord.serverId))
        .where(eq(trafficRecord.userId, data.id))
        .orderBy(desc(trafficRecord.createdAt))
        .limit(50),
    ]);

    return { user: row, subscriptions, traffic };
  });

export type UserDetail = Awaited<ReturnType<typeof getUserDetail>>;

/**
 * Ban/role mutations go through the better-auth admin plugin rather than raw
 * drizzle: banning also revokes the user's sessions, which a direct UPDATE
 * would skip. The plugin re-checks that the calling session is an admin.
 */
export const banUser = createServerFn({ method: "POST" })
  .validator(banUserSchema)
  .handler(async ({ data }) => {
    const session = await ensureAdmin();
    if (session.user.id === data.userId) {
      throw new Error("Cannot ban yourself");
    }
    await getAuth().api.banUser({
      headers: getRequestHeaders(),
      body: {
        userId: data.userId,
        banReason: data.reason,
        banExpiresIn: data.expiresInDays
          ? data.expiresInDays * SECONDS_PER_DAY
          : undefined,
      },
    });
    return { id: data.userId };
  });

export const unbanUser = createServerFn({ method: "POST" })
  .validator(userIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    await getAuth().api.unbanUser({
      headers: getRequestHeaders(),
      body: { userId: data.id },
    });
    return { id: data.id };
  });

export const setUserRole = createServerFn({ method: "POST" })
  .validator(setUserRoleSchema)
  .handler(async ({ data }) => {
    const session = await ensureAdmin();
    // Self-demotion would lock the last admin out mid-session.
    if (session.user.id === data.userId && data.role !== "admin") {
      throw new Error("Cannot demote yourself");
    }
    await getAuth().api.setRole({
      headers: getRequestHeaders(),
      body: { userId: data.userId, role: data.role },
    });
    return { id: data.userId };
  });
