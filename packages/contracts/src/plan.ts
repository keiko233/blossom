import { z } from "zod";

/**
 * Plan and subscription input schemas. Prices are cents and traffic is bytes —
 * the admin UI converts from display units (currency major units / GB) before
 * submitting.
 */

const planMetaSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional(),
  priceCents: z.number().int().min(0),
  durationDays: z.number().int().min(1),
  trafficBytes: z.number().int().min(0),
  // 0 means unlimited devices.
  deviceLimit: z.number().int().min(0).default(0),
  visible: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  // Full binding list; create/update replace the plan_group rows with it.
  groupIds: z.array(z.string().min(1)).default([]),
});

export const createPlanSchema = planMetaSchema;

export const updatePlanSchema = planMetaSchema.partial().extend({
  id: z.string().min(1),
});

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

export const planIdSchema = z.object({ id: z.string().min(1) });

// --- Subscriptions -----------------------------------------------------------

export const subscriptionStatusSchema = z.enum([
  "active",
  "expired",
  "cancelled",
]);

export const createSubscriptionSchema = z.object({
  userId: z.string().min(1),
  planId: z.string().min(1),
  // ISO string across the server-fn boundary; defaults to now.
  startedAt: z.iso.datetime().optional(),
});

export const updateSubscriptionSchema = z.object({
  id: z.string().min(1),
  status: subscriptionStatusSchema.optional(),
  expiresAt: z.iso.datetime().optional(),
  trafficUsedBytes: z.number().int().min(0).optional(),
});

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;

export const subscriptionIdSchema = z.object({ id: z.string().min(1) });

// --- Admin subscription hub --------------------------------------------------

export const SUBSCRIPTION_PAGE_SIZES = [10, 20, 50, 100] as const;

/** Largest id list a single bulk request may carry. */
export const BULK_SUBSCRIPTION_MAX_IDS = 500;

/** Hard cap on rows a CSV export returns. */
export const SUBSCRIPTION_EXPORT_MAX_ROWS = 10_000;

export const subscriptionSortSchema = z.enum([
  "createdAt",
  "expiresAt",
  "usage",
]);

/**
 * Filters shared by the list and the CSV export. `status` filters the
 * *effective* status unless `effective` is false (then the stored column).
 */
export const subscriptionFilterSchema = z.object({
  // Matches user name/email, or the subscription id (substring, case-insensitive).
  search: z.string().trim().max(200).optional(),
  status: subscriptionStatusSchema.optional(),
  // Effective: active-but-past-expiry counts as expired.
  effective: z.boolean().default(true),
  planId: z.string().min(1).optional(),
  // Active subscriptions whose expiry falls within the next N days.
  expiringWithinDays: z.number().int().min(1).max(3650).optional(),
  // over: quota exhausted; near: at or above the quota warning threshold.
  quota: z.enum(["over", "near"]).optional(),
  sort: subscriptionSortSchema.default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export const listSubscriptionsSchema = subscriptionFilterSchema.extend({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

export type SubscriptionFilter = z.infer<typeof subscriptionFilterSchema>;
export type SubscriptionFilterInput = z.input<typeof subscriptionFilterSchema>;
export type ListSubscriptionsInput = z.input<typeof listSubscriptionsSchema>;

export const bulkSubscriptionActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("extend"),
    days: z.number().int().min(1).max(3650),
    // "expiry": from the current expiry, or from now if already expired.
    base: z.enum(["expiry", "now"]).default("expiry"),
  }),
  z.object({ type: z.literal("resetTraffic") }),
  z.object({
    type: z.literal("setStatus"),
    status: z.enum(["active", "cancelled"]),
  }),
  z.object({
    type: z.literal("changePlan"),
    planId: z.string().min(1),
    // Re-copy the new plan's quota and device limit onto each subscription.
    resnapshot: z.boolean().default(false),
  }),
  z.object({ type: z.literal("delete") }),
]);

export const bulkSubscriptionSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(BULK_SUBSCRIPTION_MAX_IDS),
  action: bulkSubscriptionActionSchema,
});

export type BulkSubscriptionAction = z.infer<
  typeof bulkSubscriptionActionSchema
>;
export type BulkSubscriptionActionInput = z.input<
  typeof bulkSubscriptionActionSchema
>;
export type BulkSubscriptionInput = z.input<typeof bulkSubscriptionSchema>;

export interface BulkSubscriptionResult {
  succeeded: number;
  failed: { id: string; message: string }[];
}
