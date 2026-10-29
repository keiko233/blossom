import { z } from "zod";

import {
  SUBSCRIPTION_PAGE_SIZES,
  type SubscriptionFilterInput,
  subscriptionSortSchema,
  subscriptionStatusSchema,
} from "@/orpc/plan/schema";

export const DEFAULT_PAGE_SIZE = 20;

/** Day windows offered by the "expiring within" filter. */
export const EXPIRING_DAY_OPTIONS = [3, 7, 14, 30] as const;

/**
 * URL search params of the subscriptions page. Defaults are left out of the
 * URL (undefined), and every field falls back to undefined on garbage input so
 * a hand-edited link never breaks the page.
 */
export const subscriptionsSearchSchema = z.object({
  page: z.number().int().min(1).optional().catch(undefined),
  pageSize: z
    .number()
    .refine((value) =>
      (SUBSCRIPTION_PAGE_SIZES as readonly number[]).includes(value),
    )
    .optional()
    .catch(undefined),
  // Numeric-looking queries are parsed as numbers by the router.
  q: z
    .union([z.string(), z.number()])
    .transform(String)
    .optional()
    .catch(undefined),
  status: subscriptionStatusSchema.optional().catch(undefined),
  // Match the stored status instead of the effective one.
  stored: z.literal(true).optional().catch(undefined),
  plan: z.string().min(1).optional().catch(undefined),
  expiring: z.number().int().min(1).max(3650).optional().catch(undefined),
  quota: z.enum(["over", "near"]).optional().catch(undefined),
  sort: subscriptionSortSchema.optional().catch(undefined),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
});

export type SubscriptionsSearch = z.infer<typeof subscriptionsSearchSchema>;

/** The server-side filter a set of search params stands for. */
export function searchToFilter(
  search: SubscriptionsSearch,
): SubscriptionFilterInput {
  return {
    search: search.q?.trim() || undefined,
    status: search.status,
    effective: !search.stored,
    planId: search.plan,
    expiringWithinDays: search.expiring,
    quota: search.quota,
    sort: search.sort ?? "createdAt",
    sortDir: search.dir ?? "desc",
  };
}
