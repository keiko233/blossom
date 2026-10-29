import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { user } from "@/db/auth-schema";
import { subscription } from "@/db/plan-schema";
import { escapeLikePattern } from "@/lib/subscription-filters";
import type { UserFilter } from "@/orpc/user/schema";

/** Correlated EXISTS: the user holds an unexpired active subscription. */
function hasActiveSubscription(now: Date): SQL {
  return sql`exists (select 1 from ${subscription} where ${and(
    eq(subscription.userId, user.id),
    eq(subscription.status, "active"),
    gt(subscription.expiresAt, now),
  )})`;
}

/**
 * WHERE conditions for the admin user list/export, ANDed together by the
 * caller. `now` is injected so the subscription filter stays testable.
 */
export function buildUserConditions(filter: UserFilter, now: Date): SQL[] {
  const conditions: SQL[] = [];

  const search = filter.search?.trim();
  if (search) {
    const pattern = `%${escapeLikePattern(search)}%`;
    const match = or(
      ilike(user.name, pattern),
      ilike(user.email, pattern),
      ilike(user.id, pattern),
    );
    if (match) conditions.push(match);
  }

  if (filter.role === "admin") {
    conditions.push(eq(user.role, "admin"));
  } else if (filter.role === "user") {
    // The column is nullable and defaults to "user": null counts as a user.
    const plain = or(isNull(user.role), ne(user.role, "admin"));
    if (plain) conditions.push(plain);
  }

  // Matches the stored flag, like the status badge: a timed ban stays listed
  // as banned until better-auth lifts it on the user's next sign-in attempt.
  if (filter.status === "banned") {
    conditions.push(eq(user.banned, true));
  } else if (filter.status === "active") {
    const notBanned = or(isNull(user.banned), eq(user.banned, false));
    if (notBanned) conditions.push(notBanned);
  }

  if (filter.subscription === "active") {
    conditions.push(hasActiveSubscription(now));
  } else if (filter.subscription === "none") {
    conditions.push(sql`not ${hasActiveSubscription(now)}`);
  }

  return conditions;
}

/** Combined WHERE clause, or undefined when no filter applies. */
export function buildUserWhere(filter: UserFilter, now: Date): SQL | undefined {
  const conditions = buildUserConditions(filter, now);
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** ORDER BY with the id as a tiebreaker so pages never overlap. */
export function buildUserOrderBy(
  sort: UserFilter["sort"],
  dir: UserFilter["sortDir"],
): SQL[] {
  const direction = dir === "asc" ? asc : desc;
  const primary =
    sort === "name"
      ? direction(sql`lower(${user.name})`)
      : sort === "email"
        ? direction(sql`lower(${user.email})`)
        : direction(user.createdAt);
  return [primary, direction(user.id)];
}
