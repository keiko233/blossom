import { createFileRoute } from "@tanstack/react-router";

import { getServerEnv } from "@/lib/env";
import {
  authorizeMaintenanceRequest,
  NO_STORE_HEADERS,
} from "@/lib/maintenance-auth";
import { pruneServerMetricHistory } from "@/query/server-metric-store";

const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_BATCHES = 10;
const MAX_BATCH_SIZE = 5_000;
const MAX_BATCHES = 100;

function bounded(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
}

/**
 * Scheduler-only, bounded retention cleanup. There is deliberately no admin
 * browser path: the token is independent of user sessions. The caller chooses
 * only how many bounded batches to run, never the cutoff.
 */
export interface ServerMetricMaintenanceDependencies {
  token(): string | undefined;
  prune(options: {
    now: number;
    batchSize: number;
    maxBatches: number;
  }): Promise<number>;
}

const defaultDependencies: ServerMetricMaintenanceDependencies = {
  token: () => getServerEnv().MAINTENANCE_TOKEN,
  prune: (options) => pruneServerMetricHistory(options),
};

export async function handleServerMetricMaintenance(
  request: Request,
  dependencies: ServerMetricMaintenanceDependencies = defaultDependencies,
): Promise<Response> {
  const denied = authorizeMaintenanceRequest(request, dependencies.token());
  if (denied) {
    return denied;
  }
  const url = new URL(request.url);
  const batchSize = bounded(
    url.searchParams.get("batchSize"),
    DEFAULT_BATCH_SIZE,
    MAX_BATCH_SIZE,
  );
  const maxBatches = bounded(
    url.searchParams.get("maxBatches"),
    DEFAULT_MAX_BATCHES,
    MAX_BATCHES,
  );
  const removed = await dependencies.prune({
    now: Date.now(),
    batchSize,
    maxBatches,
  });
  return Response.json(
    { removed, batchSize, maxBatches },
    { headers: NO_STORE_HEADERS },
  );
}

export const Route = createFileRoute("/api/maintenance/server-metrics")({
  server: {
    handlers: {
      POST: ({ request }) => handleServerMetricMaintenance(request),
      // Vercel Cron sends GET; external schedulers may use either. The token
      // check is identical, and the work is bounded per invocation.
      GET: ({ request }) => handleServerMetricMaintenance(request),
    },
  },
});
