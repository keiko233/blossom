import { z } from "zod";

import {
  REDEEM_PAGE_SIZES,
  type RedeemBatchFilterInput,
  redeemBatchSortSchema,
  redeemBatchStatusSchema,
  redeemModeSchema,
} from "@/orpc/redeem/schema";

/**
 * URL search params of the redeem batches page. Defaults are left out of the
 * URL (undefined), and every field falls back to undefined on garbage input so
 * a hand-edited link never breaks the page.
 */
export const redeemSearchSchema = z.object({
  page: z.number().int().min(1).optional().catch(undefined),
  pageSize: z
    .number()
    .refine((value) => (REDEEM_PAGE_SIZES as readonly number[]).includes(value))
    .optional()
    .catch(undefined),
  // Numeric-looking queries are parsed as numbers by the router.
  q: z
    .union([z.string(), z.number()])
    .transform(String)
    .optional()
    .catch(undefined),
  plan: z.string().min(1).optional().catch(undefined),
  mode: redeemModeSchema.optional().catch(undefined),
  status: redeemBatchStatusSchema.optional().catch(undefined),
  sort: redeemBatchSortSchema.optional().catch(undefined),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
});

export type RedeemSearch = z.infer<typeof redeemSearchSchema>;

/** The server-side filter a set of search params stands for. */
export function searchToRedeemFilter(
  search: RedeemSearch,
): RedeemBatchFilterInput {
  return {
    search: search.q?.trim() || undefined,
    planId: search.plan,
    mode: search.mode,
    status: search.status,
    sort: search.sort ?? "createdAt",
    sortDir: search.dir ?? "desc",
  };
}

/**
 * URL search params of one batch's detail page: independent pagination for
 * the codes and redemptions tables, plus a code-prefix search.
 */
export const redeemDetailSearchSchema = z.object({
  codesPage: z.number().int().min(1).optional().catch(undefined),
  redemptionsPage: z.number().int().min(1).optional().catch(undefined),
  pageSize: z
    .number()
    .refine((value) => (REDEEM_PAGE_SIZES as readonly number[]).includes(value))
    .optional()
    .catch(undefined),
  q: z
    .union([z.string(), z.number()])
    .transform(String)
    .optional()
    .catch(undefined),
});

export type RedeemDetailSearch = z.infer<typeof redeemDetailSearchSchema>;
