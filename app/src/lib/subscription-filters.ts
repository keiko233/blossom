import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { user } from "@/db/auth-schema";
import { subscription } from "@/db/plan-schema";
import {
  getExpiringSoonCutoff,
  QUOTA_WARNING_PERCENT,
} from "@/lib/admin-overview";
import type { SubscriptionFilter } from "@/orpc/plan/schema";

/** Escapes LIKE wildcards so user input is matched literally (`\` escape). */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * WHERE conditions for the admin subscription list/export, ANDed together by
 * the caller. `now` is injected so the time-relative filters stay testable.
 */
export function buildSubscriptionConditions(
  filter: SubscriptionFilter,
  now: Date,
): SQL[] {
  const conditions: SQL[] = [];

  const search = filter.search?.trim();
  if (search) {
    const pattern = `%${escapeLikePattern(search)}%`;
    const match = or(
      ilike(user.name, pattern),
      ilike(user.email, pattern),
      ilike(subscription.id, pattern),
    );
    if (match) conditions.push(match);
  }

  if (filter.status) {
    if (!filter.effective) {
      conditions.push(eq(subscription.status, filter.status));
    } else if (filter.status === "active") {
      // Effective status: active only while the expiry is still ahead.
      conditions.push(
        eq(subscription.status, "active"),
        gt(subscription.expiresAt, now),
      );
    } else if (filter.status === "expired") {
      const expired = or(
        eq(subscription.status, "expired"),
        and(
          eq(subscription.status, "active"),
          lte(subscription.expiresAt, now),
        ),
      );
      if (expired) conditions.push(expired);
    } else {
      conditions.push(eq(subscription.status, "cancelled"));
    }
  }

  if (filter.planId) {
    conditions.push(eq(subscription.planId, filter.planId));
  }

  if (filter.expiringWithinDays !== undefined) {
    conditions.push(
      eq(subscription.status, "active"),
      gt(subscription.expiresAt, now),
      lte(
        subscription.expiresAt,
        getExpiringSoonCutoff(now.getTime(), filter.expiringWithinDays),
      ),
    );
  }

  // Unlimited quotas (0) never count as over/near: 0 >= 0 would match.
  if (filter.quota === "over") {
    conditions.push(
      gt(subscription.trafficQuotaBytes, 0),
      gte(subscription.trafficUsedBytes, subscription.trafficQuotaBytes),
    );
  } else if (filter.quota === "near") {
    conditions.push(
      gt(subscription.trafficQuotaBytes, 0),
      sql`${subscription.trafficUsedBytes} * 100 >= ${subscription.trafficQuotaBytes} * ${QUOTA_WARNING_PERCENT}::int`,
    );
  }

  return conditions;
}

/** Combined WHERE clause, or undefined when no filter applies. */
export function buildSubscriptionWhere(
  filter: SubscriptionFilter,
  now: Date,
): SQL | undefined {
  const conditions = buildSubscriptionConditions(filter, now);
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Fraction of quota used; unlimited quotas sort as 0. */
const usageRatio = sql`case when ${subscription.trafficQuotaBytes} > 0 then ${subscription.trafficUsedBytes}::float8 / ${subscription.trafficQuotaBytes} else 0 end`;

/** ORDER BY with the id as a tiebreaker so pages never overlap. */
export function buildSubscriptionOrderBy(
  sort: SubscriptionFilter["sort"],
  dir: SubscriptionFilter["sortDir"],
): SQL[] {
  const direction = dir === "asc" ? asc : desc;
  const primary =
    sort === "usage"
      ? direction(usageRatio)
      : direction(
          sort === "expiresAt"
            ? subscription.expiresAt
            : subscription.createdAt,
        );
  return [primary, direction(subscription.id)];
}
