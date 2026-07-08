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
