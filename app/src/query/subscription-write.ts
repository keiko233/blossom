import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { type Plan, type Subscription, subscription } from "@/db/plan-schema";
import {
  authorizationPlanIds,
  needsAuthorizationRecord,
  type SubscriptionPatch,
} from "@/lib/subscription-bulk";
import {
  generateSubscriptionCredentials,
  generateSubscriptionToken,
} from "@/lib/subscription-credentials";
import {
  listServerIdsForPlanIds,
  recordConfigChange,
} from "@/query/config-change";

/**
 * Write side of subscriptions that is shared between admin server functions
 * (`@/query/subscriptions`) and the user-facing redeem flow
 * (`@/query/redeem-user`). These are plain functions with no authorization of
 * their own: callers must have established who may do this. They live outside
 * the server-function modules because those are imported by client pages, and
 * a plain exported function that touches `db` would not be stripped from the
 * client bundle the way a server function handler is.
 */

export interface InsertSubscriptionInput {
  userId: string;
  plan: Pick<Plan, "id" | "trafficBytes" | "deviceLimit">;
  startedAt: Date;
  expiresAt: Date;
  /** Pre-chosen id, so a caller can find the row again if a later step fails. */
  id?: string;
}

/**
 * Creates a subscription for a plan and records the publish-gate `credential`
 * change. Quota and device limit are snapshotted so later plan edits don't
 * affect already-granted subscriptions.
 */
export async function insertSubscription(
  input: InsertSubscriptionInput,
): Promise<Subscription> {
  const credentials = generateSubscriptionCredentials();
  const [row] = await db
    .insert(subscription)
    .values({
      id: input.id ?? randomUUID(),
      userId: input.userId,
      planId: input.plan.id,
      startedAt: input.startedAt,
      expiresAt: input.expiresAt,
      trafficQuotaBytes: input.plan.trafficBytes,
      deviceLimit: input.plan.deviceLimit,
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
    serverIds: await listServerIdsForPlanIds(db, [input.plan.id]),
  });
  return row;
}

/**
 * The single place a subscription row is updated: shared by the per-row server
 * fn, the bulk operations and redemptions so all of them emit identical
 * publish-gate records.
 *
 * Publish gate: re-activations (status/expiry moving from ineligible to
 * eligible) and plan changes (node access) change what the agent must serve;
 * hold the subscription payload until every affected server confirms.
 * De-activation directions are already refused at fetch time. A plan change
 * covers the servers of both the old and the new plan.
 */
export async function applySubscriptionUpdate(
  existing: Subscription,
  patch: SubscriptionPatch,
): Promise<Subscription> {
  const [row] = await db
    .update(subscription)
    .set(patch)
    .where(eq(subscription.id, existing.id))
    .returning();
  if (!row) {
    throw new Error("Not found");
  }

  if (needsAuthorizationRecord(existing, row)) {
    await recordConfigChange(db, {
      kind: "authorization",
      subjectId: existing.id,
      prevRow: {
        planId: existing.planId,
        status: existing.status,
        expiresAt: existing.expiresAt.toISOString(),
      },
      serverIds: await listServerIdsForPlanIds(
        db,
        authorizationPlanIds(existing, row),
      ),
    });
  }
  return row;
}
