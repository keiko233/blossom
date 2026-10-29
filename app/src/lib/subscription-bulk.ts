import type { Plan, Subscription } from "@/db/plan-schema";
import type { BulkSubscriptionAction } from "@/orpc/plan/schema";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Columns a subscription update may touch (the shared update path's input). */
export interface SubscriptionPatch {
  status?: Subscription["status"];
  expiresAt?: Date;
  trafficUsedBytes?: number;
  planId?: string;
  trafficQuotaBytes?: number;
  deviceLimit?: number;
}

/**
 * New expiry after extending by `days`. "expiry" extends from the current
 * expiry, or from `now` when that has already passed (an expired subscription
 * must not be extended into the past); "now" always extends from `now`.
 */
export function extendExpiry(
  currentExpiresAt: Date,
  days: number,
  base: "expiry" | "now",
  now: Date,
): Date {
  const start =
    base === "expiry" && currentExpiresAt.getTime() > now.getTime()
      ? currentExpiresAt
      : now;
  return new Date(start.getTime() + days * MS_PER_DAY);
}

/**
 * The row update a bulk action performs on one subscription, or null for
 * `delete` (which has no patch). `targetPlan` is required for `changePlan`.
 */
export function resolveBulkPatch(
  action: Exclude<BulkSubscriptionAction, { type: "delete" }>,
  existing: Pick<Subscription, "expiresAt">,
  targetPlan: Pick<Plan, "id" | "trafficBytes" | "deviceLimit"> | undefined,
  now: Date,
): SubscriptionPatch {
  switch (action.type) {
    case "extend":
      return {
        expiresAt: extendExpiry(
          existing.expiresAt,
          action.days,
          action.base,
          now,
        ),
      };
    case "resetTraffic":
      return { trafficUsedBytes: 0 };
    case "setStatus":
      return { status: action.status };
    case "changePlan":
      if (!targetPlan) {
        throw new Error("Plan not found");
      }
      return {
        planId: targetPlan.id,
        // Quota and device limit are snapshots; only refreshed on request.
        ...(action.resnapshot
          ? {
              trafficQuotaBytes: targetPlan.trafficBytes,
              deviceLimit: targetPlan.deviceLimit,
            }
          : {}),
      };
  }
}

type GateFields = Pick<Subscription, "status" | "expiresAt" | "planId">;

/**
 * Whether an update changes what the agent must serve and so needs a publish
 * gate `authorization` record: status or expiry moved (re-activation), or the
 * plan moved (node access changed). Single and bulk updates share this.
 */
export function needsAuthorizationRecord(
  before: GateFields,
  after: GateFields,
): boolean {
  return (
    before.status !== after.status ||
    before.expiresAt.getTime() !== after.expiresAt.getTime() ||
    before.planId !== after.planId
  );
}

/**
 * Plans whose servers an authorization record must cover: the union of the old
 * and new plan, so both newly reachable and no-longer-reachable nodes are
 * tracked.
 */
export function authorizationPlanIds(
  before: Pick<Subscription, "planId">,
  after: Pick<Subscription, "planId">,
): string[] {
  return [...new Set([before.planId, after.planId])];
}
