import { z } from "zod";

import {
  DEFAULT_TRAFFIC_PRESET,
  daysToRange,
  parseUtcDay,
  presetToRange,
  TRAFFIC_PRESETS,
  type TrafficRange,
} from "@/lib/traffic-analytics";
import {
  TRAFFIC_PAGE_SIZES,
  type TrafficFilterInput,
  trafficBreakdownSortSchema,
  trafficDimensionSchema,
} from "@/orpc/traffic/schema";

/** A UTC calendar day as typed into `<input type="date">`. */
const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => parseUtcDay(value) !== undefined);

// Numeric-looking ids are parsed as numbers by the router.
const text = z
  .union([z.string(), z.number()])
  .transform(String)
  .optional()
  .catch(undefined);

/**
 * URL search params of the traffic page. Defaults are left out of the URL
 * (undefined), and every field falls back to undefined on garbage input so a
 * hand-edited link never breaks the page. `from` / `to` (UTC days) win over
 * the `range` preset.
 */
export const trafficSearchSchema = z.object({
  range: z.enum(TRAFFIC_PRESETS).optional().catch(undefined),
  from: dayString.optional().catch(undefined),
  to: dayString.optional().catch(undefined),
  server: text,
  node: text,
  plan: text,
  user: text,
  by: trafficDimensionSchema.optional().catch(undefined),
  page: z.number().int().min(1).optional().catch(undefined),
  pageSize: z
    .number()
    .refine((value) =>
      (TRAFFIC_PAGE_SIZES as readonly number[]).includes(value),
    )
    .optional()
    .catch(undefined),
  sort: trafficBreakdownSortSchema.optional().catch(undefined),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
});

export type TrafficSearch = z.infer<typeof trafficSearchSchema>;

/** The range the search params stand for at `nowMs`. */
export function searchToTrafficRange(
  search: Pick<TrafficSearch, "range" | "from" | "to">,
  nowMs: number,
): TrafficRange {
  return (
    daysToRange(search.from, search.to, nowMs) ??
    presetToRange(search.range ?? DEFAULT_TRAFFIC_PRESET, nowMs)
  );
}

const clean = (value: string | undefined): string | undefined =>
  value?.trim() || undefined;

/** The server-side filter (range plus entity filters) of the search params. */
export function searchToTrafficFilter(
  search: TrafficSearch,
  range: TrafficRange,
): TrafficFilterInput {
  return {
    from: new Date(range.from).toISOString(),
    to: new Date(range.to).toISOString(),
    serverId: clean(search.server),
    nodeId: clean(search.node),
    planId: clean(search.plan),
    userId: clean(search.user),
  };
}
