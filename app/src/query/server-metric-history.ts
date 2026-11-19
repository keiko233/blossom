import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { ensureAdmin } from "@/lib/ensure-admin";
import { SERVER_METRIC_RANGES } from "@/lib/server-metric-history";
import { loadServerMetricHistory } from "@/query/server-metric-store";

/** TanStack Query key for the Overview host history charts. */
export const SERVER_METRIC_HISTORY_QUERY_KEY = [
  "admin",
  "server-metric-history",
] as const;

const serverMetricHistoryInputSchema = z.object({
  serverId: z.string().min(1).max(128),
  range: z.enum(SERVER_METRIC_RANGES),
});

/** Admin-only read of one server's host history for the Overview charts. */
export const getServerMetricHistory = createServerFn({ method: "GET" })
  .validator(serverMetricHistoryInputSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return loadServerMetricHistory(data.serverId, data.range);
  });
