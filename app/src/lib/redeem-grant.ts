import type { Plan, Subscription } from "@/db/plan-schema";
import { type RedeemMode, resolveRedeemDurationDays } from "@/lib/redeem-batch";
import { extendExpiry, type SubscriptionPatch } from "@/lib/subscription-bulk";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type ExistingSubscription = Pick<
  Subscription,
  "id" | "planId" | "status" | "expiresAt" | "trafficQuotaBytes"
>;

export type RedeemGrant =
  | {
      kind: "create";
      startedAt: Date;
      expiresAt: Date;
    }
  | {
      kind: "extend";
      subscriptionId: string;
      patch: Required<
        Pick<SubscriptionPatch, "expiresAt" | "trafficQuotaBytes">
      >;
    };

/**
 * The active subscription an `extend` redemption renews: same plan, status
 * `active` and not yet expired. With several, the one expiring last wins.
 */
export function findExtendableSubscription<T extends ExistingSubscription>(
  subscriptions: readonly T[],
  planId: string,
  now: Date,
): T | undefined {
  return subscriptions
    .filter(
      (sub) =>
        sub.planId === planId &&
        sub.status === "active" &&
        sub.expiresAt.getTime() > now.getTime(),
    )
    .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0];
}

/**
 * Quota after topping up a subscription with one more plan allowance:
 *
 * - `0` means unlimited on both sides: an unlimited subscription stays
 *   unlimited, and topping up with an unlimited plan makes it unlimited.
 * - Otherwise the plan's allowance is *added* to the current quota. Traffic
 *   already used stays counted, so the user gets a full extra allowance rather
 *   than a reset.
 */
export function topUpQuota(
  currentQuotaBytes: number,
  planTrafficBytes: number,
): number {
  if (currentQuotaBytes === 0 || planTrafficBytes === 0) return 0;
  return currentQuotaBytes + planTrafficBytes;
}

export interface PlanRedeemGrantInput {
  mode: RedeemMode;
  durationDays: number | null;
  plan: Pick<Plan, "id" | "durationDays" | "trafficBytes">;
  /** The user's subscriptions (any plan, any status). */
  userSubscriptions: readonly ExistingSubscription[];
  now: Date;
}

/**
 * Decides what a redemption does:
 *
 * - `new`: always creates a subscription starting now, lasting the batch's
 *   duration (override, else the plan's).
 * - `extend`: if the user has an active subscription on the same plan, its
 *   expiry moves out by the duration (from its current expiry, never from the
 *   past) and its quota is topped up (`topUpQuota`); otherwise it creates one
 *   like `new`.
 */
export function planRedeemGrant(input: PlanRedeemGrantInput): RedeemGrant {
  const days = resolveRedeemDurationDays(
    { durationDays: input.durationDays },
    input.plan,
  );

  if (input.mode === "extend") {
    const existing = findExtendableSubscription(
      input.userSubscriptions,
      input.plan.id,
      input.now,
    );
    if (existing) {
      return {
        kind: "extend",
        subscriptionId: existing.id,
        patch: {
          expiresAt: extendExpiry(
            existing.expiresAt,
            days,
            "expiry",
            input.now,
          ),
          trafficQuotaBytes: topUpQuota(
            existing.trafficQuotaBytes,
            input.plan.trafficBytes,
          ),
        },
      };
    }
  }

  return {
    kind: "create",
    startedAt: input.now,
    expiresAt: new Date(input.now.getTime() + days * MS_PER_DAY),
  };
}
