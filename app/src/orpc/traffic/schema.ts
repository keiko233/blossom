import { z } from "zod";

import { MS_PER_DAY, TRAFFIC_MAX_RANGE_DAYS } from "@/lib/traffic-analytics";

/**
 * Traffic analytics input schemas, shared by the server functions and the
 * URL search params of the analytics page.
 */

export const TRAFFIC_DIMENSIONS = ["user", "server", "node", "plan"] as const;
export type TrafficDimension = (typeof TRAFFIC_DIMENSIONS)[number];
export const trafficDimensionSchema = z.enum(TRAFFIC_DIMENSIONS);

export const TRAFFIC_BREAKDOWN_SORTS = [
  "total",
  "uplink",
  "downlink",
  "name",
] as const;
export const trafficBreakdownSortSchema = z.enum(TRAFFIC_BREAKDOWN_SORTS);
export type TrafficBreakdownSort = z.infer<typeof trafficBreakdownSortSchema>;

export const TRAFFIC_PAGE_SIZES = [10, 25, 50] as const;
export const DEFAULT_TRAFFIC_PAGE_SIZE = 10;

/** Hard cap on rows a breakdown CSV export returns. */
export const TRAFFIC_EXPORT_MAX_ROWS = 10_000;

const isoInstant = z.iso.datetime();
const entityId = z.string().trim().min(1).max(200);

const trafficFilterShape = {
  // ISO instants, `from` inclusive and `to` exclusive.
  from: isoInstant,
  to: isoInstant,
  serverId: entityId.optional(),
  nodeId: entityId.optional(),
  planId: entityId.optional(),
  userId: entityId.optional(),
};

/** `from < to` and at most `TRAFFIC_MAX_RANGE_DAYS` long. */
function hasValidRange(value: { from: string; to: string }): boolean {
  const span = Date.parse(value.to) - Date.parse(value.from);
  return span > 0 && span <= TRAFFIC_MAX_RANGE_DAYS * MS_PER_DAY;
}

const RANGE_ERROR = {
  message: "Range must be positive and at most 366 days",
  path: ["to"],
};

/** Range plus optional server / node / plan / user filters. */
export const trafficFilterSchema = z
  .object(trafficFilterShape)
  .refine(hasValidRange, RANGE_ERROR);

export type TrafficFilterInput = z.input<typeof trafficFilterSchema>;
export type TrafficFilter = z.infer<typeof trafficFilterSchema>;

export const getTrafficBreakdownSchema = z
  .object({
    ...trafficFilterShape,
    dimension: trafficDimensionSchema,
    sort: trafficBreakdownSortSchema.default("total"),
    sortDir: z.enum(["asc", "desc"]).default("desc"),
    page: z.number().int().min(1).default(1),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(DEFAULT_TRAFFIC_PAGE_SIZE),
  })
  .refine(hasValidRange, RANGE_ERROR);

export const TRAFFIC_EXPORT_KINDS = ["series", ...TRAFFIC_DIMENSIONS] as const;
export type TrafficExportKind = (typeof TRAFFIC_EXPORT_KINDS)[number];

export const exportTrafficCsvSchema = z
  .object({
    ...trafficFilterShape,
    kind: z.enum(TRAFFIC_EXPORT_KINDS),
  })
  .refine(hasValidRange, RANGE_ERROR);

export const searchTrafficUsersSchema = z.object({
  // Substring of name / email, or the exact user id.
  q: z.string().trim().max(200).optional(),
});
