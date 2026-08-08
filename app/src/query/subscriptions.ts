import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { user } from "@/db/auth-schema";
import { plan, subscription } from "@/db/plan-schema";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  generateSubscriptionCredentials,
  generateSubscriptionToken,
} from "@/lib/subscription-credentials";
import {
  createSubscriptionSchema,
  subscriptionIdSchema,
  updateSubscriptionSchema,
} from "@/orpc/plan/schema";
import {
  listServerIdsForPlanIds,
  listServerIdsForSubscriptionId,
  recordConfigChange,
} from "@/query/config-change";

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
    const credentials = generateSubscriptionCredentials();
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
        credentialUuid: credentials.uuid,
        credentialPassword: credentials.password,
        token: generateSubscriptionToken(),
      })
      .returning();
    // Publish gate: the fresh credentials are in no running agent config yet,
    // so the subscription holds back its nodes until every server hosting them
    // has applied the revision that introduces this user.
    await recordConfigChange(db, {
      kind: "credential",
      subjectId: row.id,
      prevRow: null,
      serverIds: await listServerIdsForPlanIds(db, [data.planId]),
    });
    return row;
  });
export const resetSubscriptionCredentials = createServerFn({ method: "POST" })
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

export const updateSubscription = createServerFn({ method: "POST" })
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

    // Publish gate: re-activations (status/expiry moving from ineligible to
    // eligible) change what the agent must serve; hold the subscription
    // payload until every affected server confirms. De-activation directions
    // are already refused at fetch time.
    const statusChanged = row.status !== existing.status;
    const expiryChanged =
      row.expiresAt.getTime() !== existing.expiresAt.getTime();
    if (statusChanged || expiryChanged) {
      await recordConfigChange(db, {
        kind: "authorization",
        subjectId: id,
        prevRow: {
          planId: existing.planId,
          status: existing.status,
          expiresAt: existing.expiresAt.toISOString(),
        },
        serverIds: await listServerIdsForSubscriptionId(db, id),
      });
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

// Node-access resolution helpers (getUserAccessibleNodes,
// getNodeActiveSubscriptions) live in `@/query/subscription-access`: they are
// plain functions, and this module must stay importable from client pages.
