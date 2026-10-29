import { createServerFn } from "@tanstack/react-start";
import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { user } from "@/db/auth-schema";
import { plan, subscription } from "@/db/plan-schema";
import { bulkMetadata, fromInput, fromResult } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { ensureAdmin } from "@/lib/ensure-admin";
import { resolveBulkPatch } from "@/lib/subscription-bulk";
import {
  generateSubscriptionCredentials,
  generateSubscriptionToken,
} from "@/lib/subscription-credentials";
import { subscriptionsToCsv } from "@/lib/subscription-csv";
import {
  buildSubscriptionOrderBy,
  buildSubscriptionWhere,
} from "@/lib/subscription-filters";
import {
  type BulkSubscriptionResult,
  bulkSubscriptionSchema,
  createSubscriptionSchema,
  listSubscriptionsSchema,
  SUBSCRIPTION_EXPORT_MAX_ROWS,
  subscriptionFilterSchema,
  subscriptionIdSchema,
  updateSubscriptionSchema,
} from "@/orpc/plan/schema";
import {
  listServerIdsForSubscriptionId,
  recordConfigChange,
} from "@/query/config-change";
import {
  applySubscriptionUpdate,
  insertSubscription,
} from "@/query/subscription-write";

/** TanStack Query key for the admin subscription list. */
export const SUBSCRIPTIONS_QUERY_KEY = ["admin", "subscriptions"] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const subscriptionRowColumns = {
  id: subscription.id,
  userId: user.id,
  userName: user.name,
  userEmail: user.email,
  planId: plan.id,
  planName: plan.name,
  status: subscription.status,
  startedAt: subscription.startedAt,
  expiresAt: subscription.expiresAt,
  trafficQuotaBytes: subscription.trafficQuotaBytes,
  trafficUsedBytes: subscription.trafficUsedBytes,
  deviceLimit: subscription.deviceLimit,
  createdAt: subscription.createdAt,
};

/**
 * Filtered, sorted and paginated in SQL. Rows deliberately omit the
 * credentials and link token: they stay behind the per-subscription actions.
 */
export const listSubscriptions = createServerFn({ method: "GET" })
  .validator(listSubscriptionsSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const where = buildSubscriptionWhere(data, new Date());

    const [rows, [totalRow]] = await Promise.all([
      db
        .select(subscriptionRowColumns)
        .from(subscription)
        .innerJoin(user, eq(user.id, subscription.userId))
        .innerJoin(plan, eq(plan.id, subscription.planId))
        .where(where)
        .orderBy(...buildSubscriptionOrderBy(data.sort, data.sortDir))
        .limit(data.pageSize)
        .offset((data.page - 1) * data.pageSize),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(subscription)
        .innerJoin(user, eq(user.id, subscription.userId))
        .innerJoin(plan, eq(plan.id, subscription.planId))
        .where(where),
    ]);
    return { rows, total: totalRow?.total ?? 0 };
  });

export type SubscriptionListItem = Awaited<
  ReturnType<typeof listSubscriptions>
>["rows"][number];

/**
 * CSV of every row matching the filters (not just one page), capped at
 * SUBSCRIPTION_EXPORT_MAX_ROWS; `truncated` tells the caller the cap hit.
 */
export const exportSubscriptionsCsv = createServerFn({ method: "GET" })
  .validator(subscriptionFilterSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const rows = await db
      .select(subscriptionRowColumns)
      .from(subscription)
      .innerJoin(user, eq(user.id, subscription.userId))
      .innerJoin(plan, eq(plan.id, subscription.planId))
      .where(buildSubscriptionWhere(data, new Date()))
      .orderBy(...buildSubscriptionOrderBy(data.sort, data.sortDir))
      .limit(SUBSCRIPTION_EXPORT_MAX_ROWS + 1);
    const truncated = rows.length > SUBSCRIPTION_EXPORT_MAX_ROWS;
    const exported = truncated
      ? rows.slice(0, SUBSCRIPTION_EXPORT_MAX_ROWS)
      : rows;
    return {
      csv: subscriptionsToCsv(exported),
      count: exported.length,
      truncated,
    };
  });

export const createSubscription = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("subscription.create", {
      targetType: "subscription",
      targetId: fromResult("id"),
    }),
  ])
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

    return insertSubscription({
      userId: data.userId,
      plan: planRow,
      startedAt,
      expiresAt,
    });
  });
export const resetSubscriptionCredentials = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("subscription.reset_credentials", {
      targetType: "subscription",
      targetId: fromInput("id"),
    }),
  ])
  .validator(subscriptionIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [existing] = await db
      .select()
      .from(subscription)
      .where(eq(subscription.id, data.id));
    if (!existing) {
      throw new Error("Not found");
    }
    const credentials = generateSubscriptionCredentials();
    const [row] = await db
      .update(subscription)
      .set({
        credentialUuid: credentials.uuid,
        credentialPassword: credentials.password,
      })
      .where(eq(subscription.id, data.id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }
    // Publish gate: subscriptions keep emitting the previous credentials for
    // nodes on servers that have not applied the rotation yet.
    await recordConfigChange(db, {
      kind: "credential",
      subjectId: data.id,
      prevRow: {
        credentialUuid: existing.credentialUuid,
        credentialPassword: existing.credentialPassword,
      },
      serverIds: await listServerIdsForSubscriptionId(db, data.id),
    });
    return row;
  });

/**
 * Rotates a subscription's link token. The old subscription URL stops working
 * immediately, but the proxy credentials are not changed: connected clients
 * keep working until the agent next pulls config.
 */
export const refreshSubscriptionToken = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("subscription.refresh_token", {
      targetType: "subscription",
      targetId: fromInput("id"),
    }),
  ])
  .validator(subscriptionIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db
      .update(subscription)
      .set({ token: generateSubscriptionToken() })
      .where(eq(subscription.id, data.id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }
    return row;
  });

async function removeSubscription(id: string): Promise<{ id: string }> {
  const [row] = await db
    .delete(subscription)
    .where(eq(subscription.id, id))
    .returning();
  if (!row) {
    throw new Error("Not found");
  }
  return { id: row.id };
}

export const updateSubscription = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("subscription.update", {
      targetType: "subscription",
      targetId: fromInput("id"),
    }),
  ])
  .validator(updateSubscriptionSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { id, expiresAt, ...rest } = data;

    const [existing] = await db
      .select()
      .from(subscription)
      .where(eq(subscription.id, id));
    if (!existing) {
      throw new Error("Not found");
    }

    return applySubscriptionUpdate(existing, {
      ...rest,
      ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
    });
  });

/**
 * Applies one action to many subscriptions. Each row goes through the same
 * code as its single-row counterpart (`applySubscriptionUpdate` /
 * `removeSubscription`), one at a time, so a failing row is reported without
 * blocking the rest and the gate records match one-by-one operation.
 */
export const bulkUpdateSubscriptions = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("subscription.bulk_update", {
      targetType: "subscription",
      metadata: bulkMetadata,
    }),
  ])
  .validator(bulkSubscriptionSchema)
  .handler(async ({ data }): Promise<BulkSubscriptionResult> => {
    await ensureAdmin();
    const { action } = data;
    const ids = [...new Set(data.ids)];

    const existingRows = await db
      .select()
      .from(subscription)
      .where(inArray(subscription.id, ids));
    const existingById = new Map(existingRows.map((row) => [row.id, row]));

    let targetPlan: typeof plan.$inferSelect | undefined;
    if (action.type === "changePlan") {
      [targetPlan] = await db
        .select()
        .from(plan)
        .where(eq(plan.id, action.planId));
      if (!targetPlan) {
        throw new Error("Plan not found");
      }
    }

    const now = new Date();
    const result: BulkSubscriptionResult = { succeeded: 0, failed: [] };
    for (const id of ids) {
      try {
        const existing = existingById.get(id);
        if (!existing) {
          throw new Error("Not found");
        }
        if (action.type === "delete") {
          await removeSubscription(id);
        } else {
          await applySubscriptionUpdate(
            existing,
            resolveBulkPatch(action, existing, targetPlan, now),
          );
        }
        result.succeeded += 1;
      } catch (error) {
        result.failed.push({
          id,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
    return result;
  });

export const deleteSubscription = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("subscription.delete", {
      targetType: "subscription",
      targetId: fromInput("id"),
    }),
  ])
  .validator(subscriptionIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return removeSubscription(data.id);
  });

// Node-access resolution helpers (getUserAccessibleNodes,
// getNodeActiveSubscriptions) live in `@/query/subscription-access`: they are
// plain functions, and this module must stay importable from client pages.
