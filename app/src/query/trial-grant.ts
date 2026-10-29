import { eq } from "drizzle-orm";

import { db } from "@/db";
import { plan, subscription } from "@/db/plan-schema";
import { isUniqueViolation } from "@/lib/pg-error";
import {
  planTrialPeriod,
  shouldGrantTrial,
  trialSubscriptionId,
} from "@/lib/trial";
import { getSettings } from "@/query/settings-store";
import { insertSubscription } from "@/query/subscription-write";

export type TrialGrantOutcome =
  | "granted"
  | "not_applicable"
  | "plan_missing"
  | "already_granted";

/**
 * Gives a newly self-registered user the configured trial subscription.
 *
 * Idempotent by construction: the subscription's primary key is derived from
 * the user (`trialSubscriptionId`), so a second attempt (a retried hook, a
 * race) fails on the key and reports `already_granted` instead of granting
 * twice; a user who already holds any subscription is left alone as well.
 *
 * Creation goes through `insertSubscription`, so credentials, the quota
 * snapshot and the publish-gate record are the same as for every other grant.
 * A deleted/unknown trial plan is logged and skipped (sign-up must not fail
 * over it). Other errors propagate; the caller decides whether they matter.
 *
 * No authorization of its own: only the account-creation hook calls it.
 */
export async function grantSignupTrial(
  userId: string,
  method: string,
): Promise<TrialGrantOutcome> {
  const { trial } = await getSettings();
  if (!shouldGrantTrial(trial, method)) return "not_applicable";

  const [planRow] = await db
    .select()
    .from(plan)
    .where(eq(plan.id, trial.planId!));
  if (!planRow) {
    console.warn(
      `[trial] plan "${trial.planId}" no longer exists; skipping the trial for user ${userId}`,
    );
    return "plan_missing";
  }

  const [existing] = await db
    .select({ id: subscription.id })
    .from(subscription)
    .where(eq(subscription.userId, userId))
    .limit(1);
  if (existing) return "already_granted";

  const { startedAt, expiresAt } = planTrialPeriod(trial, planRow, new Date());
  try {
    await insertSubscription({
      id: trialSubscriptionId(userId),
      userId,
      plan: planRow,
      startedAt,
      expiresAt,
    });
  } catch (error) {
    if (isUniqueViolation(error)) return "already_granted";
    throw error;
  }
  return "granted";
}
