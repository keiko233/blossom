import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { announcement } from "@/db/announcement-schema";
import { subscription } from "@/db/plan-schema";
import { fromResult, fromInput } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { isAnnouncementVisible, sortAnnouncements } from "@/lib/announcements";
import { ensureSession } from "@/lib/auth";
import { ensureAdmin } from "@/lib/ensure-admin";
import { isSubscriptionActive } from "@/lib/subscription-helpers";
import {
  announcementIdSchema,
  createAnnouncementSchema,
  getAnnouncementIssues,
  updateAnnouncementSchema,
} from "@/orpc/announcement/schema";

/** TanStack Query key for the admin announcement list. */
export const ANNOUNCEMENTS_QUERY_KEY = ["admin", "announcements"] as const;

/**
 * Prefix for a signed-in user's announcement feed. Scoped per user id so that
 * switching accounts never shows the previous user's cached list.
 */
export const MY_ANNOUNCEMENTS_QUERY_KEY = ["user", "announcements"] as const;

export function myAnnouncementsQueryKey(userId: string) {
  return [...MY_ANNOUNCEMENTS_QUERY_KEY, userId] as const;
}

export const listAnnouncements = createServerFn({ method: "GET" }).handler(
  async () => {
    await ensureAdmin();
    return db
      .select()
      .from(announcement)
      .orderBy(desc(announcement.createdAt), desc(announcement.id));
  },
);

export type AnnouncementListItem = Awaited<
  ReturnType<typeof listAnnouncements>
>[number];

export const createAnnouncement = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("announcement.create", {
      targetType: "announcement",
      targetId: fromResult("id"),
    }),
  ])
  .validator(createAnnouncementSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db
      .insert(announcement)
      .values({ id: randomUUID(), ...data })
      .returning();
    return row;
  });

export const updateAnnouncement = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("announcement.update", {
      targetType: "announcement",
      targetId: fromInput("id"),
    }),
  ])
  .validator(updateAnnouncementSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { id, ...fields } = data;

    const [existing] = await db
      .select()
      .from(announcement)
      .where(eq(announcement.id, id));
    if (!existing) {
      throw new Error("Not found");
    }

    // The schema only checks fields submitted together; re-check the merged
    // row so e.g. switching the audience alone cannot leave a plan audience
    // without plans.
    const issues = getAnnouncementIssues({ ...existing, ...fields });
    if (issues.length > 0) {
      throw new Error(issues.map((issue) => issue.message).join("; "));
    }

    const [row] = await db
      .update(announcement)
      .set(fields)
      .where(eq(announcement.id, id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }
    return row;
  });

export const deleteAnnouncement = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("announcement.delete", {
      targetType: "announcement",
      targetId: fromInput("id"),
    }),
  ])
  .validator(announcementIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db
      .delete(announcement)
      .where(eq(announcement.id, data.id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id };
  });

/**
 * Published announcements the signed-in user should see right now, in display
 * order. The user is taken from the session only; the response carries no
 * audience or scheduling fields.
 */
export const listMyAnnouncements = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await ensureSession();
    const userId = session.user.id;
    const now = new Date();

    const [published, subscriptions] = await Promise.all([
      db
        .select()
        .from(announcement)
        .where(eq(announcement.published, true))
        .orderBy(desc(announcement.createdAt)),
      db
        .select({
          planId: subscription.planId,
          status: subscription.status,
          expiresAt: subscription.expiresAt,
          trafficQuotaBytes: subscription.trafficQuotaBytes,
          trafficUsedBytes: subscription.trafficUsedBytes,
        })
        .from(subscription)
        .where(eq(subscription.userId, userId)),
    ]);

    const activePlanIds = [
      ...new Set(
        subscriptions
          .filter((sub) => isSubscriptionActive(sub))
          .map((sub) => sub.planId),
      ),
    ];

    const visible = published.filter((row) =>
      isAnnouncementVisible(row, { now, activePlanIds }),
    );

    return sortAnnouncements(visible).map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      level: row.level,
      pinned: row.pinned,
      createdAt: row.createdAt,
    }));
  },
);

export type MyAnnouncement = Awaited<
  ReturnType<typeof listMyAnnouncements>
>[number];
