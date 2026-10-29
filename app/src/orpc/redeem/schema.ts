import { z } from "zod";

import {
  REDEEM_BATCH_STATUSES,
  REDEEM_CODES_PER_REQUEST_MAX,
  REDEEM_MODES,
} from "@/lib/redeem-batch";

/**
 * Redeem-code input schemas. Dates cross the server-function boundary as
 * `Date` (like announcements); `null` means "none" for the nullable fields.
 */

export const REDEEM_PAGE_SIZES = [10, 20, 50, 100] as const;

/** Hard cap on rows a redemptions CSV export returns. */
export const REDEEM_EXPORT_MAX_ROWS = 10_000;

export const redeemModeSchema = z.enum(REDEEM_MODES);
export const redeemBatchStatusSchema = z.enum(REDEEM_BATCH_STATUSES);
export const redeemBatchSortSchema = z.enum(["createdAt", "name", "expiresAt"]);

const nameSchema = z.string().trim().min(1).max(200);
const noteSchema = z
  .string()
  .trim()
  .max(2000)
  .nullable()
  .transform((value) => value || null);
const durationDaysSchema = z.number().int().min(1).max(3650).nullable();
const perUserLimitSchema = z.number().int().min(1).max(1000);
const codeCountSchema = z
  .number()
  .int()
  .min(1)
  .max(REDEEM_CODES_PER_REQUEST_MAX);

export const redeemBatchIdSchema = z.object({ id: z.string().min(1) });

export const createRedeemBatchSchema = z.object({
  name: nameSchema,
  planId: z.string().min(1),
  mode: redeemModeSchema.default("new"),
  // null = the plan's own duration.
  durationDays: durationDaysSchema.default(null),
  codeCount: codeCountSchema,
  maxRedemptionsPerCode: z.number().int().min(1).max(100_000).default(1),
  perUserLimit: perUserLimitSchema.default(1),
  expiresAt: z.date().nullable().default(null),
  note: noteSchema.default(null),
});

export const addRedeemCodesSchema = z.object({
  batchId: z.string().min(1),
  count: codeCountSchema,
});

/**
 * Plan, mode and duration are immutable once any code was redeemed; the server
 * rejects a changed value then (an unchanged one is ignored). The per-code use
 * count is never editable: it defines the batch's total capacity.
 */
export const updateRedeemBatchSchema = z.object({
  id: z.string().min(1),
  name: nameSchema.optional(),
  note: noteSchema.optional(),
  expiresAt: z.date().nullable().optional(),
  disabled: z.boolean().optional(),
  perUserLimit: perUserLimitSchema.optional(),
  planId: z.string().min(1).optional(),
  mode: redeemModeSchema.optional(),
  durationDays: durationDaysSchema.optional(),
});

export const updateRedeemCodeSchema = z.object({
  id: z.string().min(1),
  disabled: z.boolean(),
});

export const redeemBatchFilterSchema = z.object({
  // Matches the batch name or note (substring, case-insensitive).
  search: z.string().trim().max(200).optional(),
  planId: z.string().min(1).optional(),
  mode: redeemModeSchema.optional(),
  status: redeemBatchStatusSchema.optional(),
  sort: redeemBatchSortSchema.default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export const listRedeemBatchesSchema = redeemBatchFilterSchema.extend({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

export const listRedeemCodesSchema = z.object({
  batchId: z.string().min(1),
  // Matches the code prefix (case-insensitive).
  search: z.string().trim().max(50).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

export const listRedeemRedemptionsSchema = z.object({
  batchId: z.string().min(1),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

export const exportRedemptionsSchema = z.object({
  batchId: z.string().min(1),
});

/** What a user types into the redeem form. */
export const REDEEM_INPUT_MAX_LENGTH = 100;
export const redeemCodeInputSchema = z.object({
  code: z.string().min(1).max(REDEEM_INPUT_MAX_LENGTH),
});

export type RedeemBatchFilter = z.infer<typeof redeemBatchFilterSchema>;
export type RedeemBatchFilterInput = z.input<typeof redeemBatchFilterSchema>;
export type CreateRedeemBatchInput = z.input<typeof createRedeemBatchSchema>;
export type UpdateRedeemBatchInput = z.input<typeof updateRedeemBatchSchema>;
