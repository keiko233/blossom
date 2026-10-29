import {
  and,
  asc,
  desc,
  eq,
  ilike,
  isNotNull,
  lte,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { redeemBatch, redeemCode } from "@/db/redeem-schema";
import { escapeLikePattern } from "@/lib/subscription-filters";
import type { RedeemBatchFilter } from "@/orpc/redeem/schema";

/** Correlated scalar subquery: how many codes the batch holds. */
export const redeemCodeCountSql = sql<number>`(select count(*)::int from ${redeemCode} where ${redeemCode.batchId} = ${redeemBatch.id})`;

/** Correlated scalar subquery: uses taken across the batch's codes. */
export const redeemRedeemedSql = sql<number>`(select coalesce(sum(${redeemCode.redemptionCount}), 0)::int from ${redeemCode} where ${redeemCode.batchId} = ${redeemBatch.id})`;

/**
 * WHERE conditions for the admin batch list, ANDed together by the caller.
 * The status filter mirrors `getRedeemBatchStatus` (`@/lib/redeem-batch`).
 * `now` is injected so it stays testable.
 */
export function buildRedeemBatchConditions(
  filter: RedeemBatchFilter,
  now: Date,
): SQL[] {
  const conditions: SQL[] = [];

  const search = filter.search?.trim();
  if (search) {
    const pattern = `%${escapeLikePattern(search)}%`;
    const match = or(
      ilike(redeemBatch.name, pattern),
      ilike(redeemBatch.note, pattern),
    );
    if (match) conditions.push(match);
  }

  if (filter.planId) conditions.push(eq(redeemBatch.planId, filter.planId));
  if (filter.mode) conditions.push(eq(redeemBatch.mode, filter.mode));

  if (filter.status) {
    const notDisabled = eq(redeemBatch.disabled, false);
    const expired = and(
      isNotNull(redeemBatch.expiresAt),
      lte(redeemBatch.expiresAt, now),
    );
    const exhausted = sql`(${redeemCodeCountSql} > 0 and ${redeemRedeemedSql} >= ${redeemCodeCountSql} * ${redeemBatch.maxRedemptionsPerCode})`;

    const condition =
      filter.status === "disabled"
        ? eq(redeemBatch.disabled, true)
        : filter.status === "expired"
          ? and(notDisabled, expired)
          : filter.status === "exhausted"
            ? and(notDisabled, not(expired!), exhausted)
            : and(notDisabled, not(expired!), not(exhausted));
    if (condition) conditions.push(condition);
  }

  return conditions;
}

/** Combined WHERE clause, or undefined when no filter applies. */
export function buildRedeemBatchWhere(
  filter: RedeemBatchFilter,
  now: Date,
): SQL | undefined {
  const conditions = buildRedeemBatchConditions(filter, now);
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** ORDER BY with the id as a tiebreaker so pages never overlap. */
export function buildRedeemBatchOrderBy(
  sort: RedeemBatchFilter["sort"],
  dir: RedeemBatchFilter["sortDir"],
): SQL[] {
  const direction = dir === "asc" ? asc : desc;
  const primary =
    sort === "name"
      ? direction(sql`lower(${redeemBatch.name})`)
      : sort === "expiresAt"
        ? // Batches that never expire sort last either way.
          sql`${redeemBatch.expiresAt} ${dir === "asc" ? sql`asc` : sql`desc`} nulls last`
        : direction(redeemBatch.createdAt);
  return [primary, direction(redeemBatch.id)];
}
