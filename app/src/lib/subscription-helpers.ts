import type { SubscriptionStatus } from "@/db/plan-schema";

export interface SubscriptionUsabilityInput {
  status: SubscriptionStatus;
  expiresAt: Date | string | number;
  trafficQuotaBytes: number;
  trafficUsedBytes: number;
}

/**
 * Determine the effective status to display to a user. Cancelled is always
 * shown as cancelled; an active subscription whose expiration date has passed
 * is shown as expired; otherwise the stored status is returned.
 */
export function getEffectiveSubscriptionStatus(
  sub: Pick<SubscriptionUsabilityInput, "status" | "expiresAt">,
): SubscriptionStatus {
  if (sub.status === "cancelled") return "cancelled";
  if (sub.status === "expired") return "expired";
  return new Date(sub.expiresAt).getTime() <= Date.now() ? "expired" : "active";
}

/**
 * Whether a subscription is not cancelled and has not passed its expiration date.
 * This checks the explicit status and the expiresAt date independently so callers
 * can decide whether to also enforce quota.
 */
export function isSubscriptionActive(sub: SubscriptionUsabilityInput): boolean {
  if (sub.status !== "active") return false;
  return new Date(sub.expiresAt).getTime() > Date.now();
}

export function isSubscriptionExpired(
  sub: SubscriptionUsabilityInput,
): boolean {
  return (
    sub.status === "expired" || new Date(sub.expiresAt).getTime() <= Date.now()
  );
}

/**
 * Whether the subscription's traffic quota has been exhausted. Unlimited quotas
 * (trafficQuotaBytes === 0) are never considered exhausted.
 */
export function isQuotaExhausted(sub: SubscriptionUsabilityInput): boolean {
  return (
    sub.trafficQuotaBytes > 0 && sub.trafficUsedBytes >= sub.trafficQuotaBytes
  );
}

/**
 * Whether the subscription can be used to fetch a compiled config. A subscription
 * is usable only when it is active, not cancelled, not expired, and not over quota.
 */
export function isSubscriptionUsable(sub: SubscriptionUsabilityInput): boolean {
  return isSubscriptionActive(sub) && !isQuotaExhausted(sub);
}

/**
 * Build the absolute subscription URL. The origin is injected so this helper stays
 * pure and testable; call sites pass `window.location.origin` on the client.
 */
export function buildSubscriptionUrl(
  token: string,
  origin: string = "",
): string {
  const encodedToken = encodeURIComponent(token);
  const path = `/api/sub/${encodedToken}`;
  return origin ? `${origin}${path}` : path;
}
