import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";

import { getServerEnv } from "@/lib/env";
import { pruneServerMetricHistory } from "@/query/server-metric-store";

const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_BATCHES = 10;
const MAX_BATCH_SIZE = 5_000;
const MAX_BATCHES = 100;

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bounded(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
}

function headers(): HeadersInit {
  return { "cache-control": "no-store" };
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
  const expected = dependencies.token();
  if (!expected) {
    return Response.json(
      { error: "maintenance_disabled" },
      { status: 503, headers: headers() },
    );
  }
  const token = bearer(request);
  if (!token || !sameSecret(token, expected)) {
    return new Response(null, { status: 401, headers: headers() });
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
    { headers: headers() },
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
