import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";

import { getServerEnv } from "@/lib/env";
import { dispatchManagedRolloutThroughHub } from "@/lib/managed-rollout-dispatch";
import type { ManagedRolloutDispatchResult } from "@/lib/managed-rollout-runtime";
import {
  sweepManagedRollouts,
  type ManagedRolloutFollowUp,
} from "@/lib/managed-rollout-runtime";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

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

function boundedLimit(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_LIMIT)
    : DEFAULT_LIMIT;
}

function headers(): HeadersInit {
  return { "cache-control": "no-store" };
}

/**
 * Scheduler-only, bounded managed-rollout sweep. There is deliberately no
 * admin cookie path: the maintenance token is independent of user sessions.
 * The caller chooses only how many active rollouts to inspect, never a stage,
 * server or sequence. Stalled state is derived from persisted deadlines, so
 * this route is not required for truthful status while every agent is offline;
 * it only advances deadlines and delivers post-commit follow-ups.
 */
export interface ManagedRolloutMaintenanceDependencies {
  token(): string | undefined;
  sweep(options: { limit: number; now: Date }): Promise<{
    activationDisabled: boolean;
    scanned: number;
    followUps: ManagedRolloutFollowUp[];
    errors: number;
  }>;
  dispatch(
    followUps: readonly ManagedRolloutFollowUp[],
  ): Promise<ManagedRolloutDispatchResult>;
}

const defaultDependencies: ManagedRolloutMaintenanceDependencies = {
  token: () => getServerEnv().MAINTENANCE_TOKEN,
  sweep: (options) =>
    sweepManagedRollouts({ limit: options.limit, now: options.now }),
  dispatch: (followUps) => dispatchManagedRolloutThroughHub(followUps),
};

export async function handleManagedRolloutMaintenance(
  request: Request,
  dependencies: ManagedRolloutMaintenanceDependencies = defaultDependencies,
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
  const limit = boundedLimit(new URL(request.url).searchParams.get("limit"));
  const swept = await dependencies.sweep({ limit, now: new Date() });
  if (swept.activationDisabled) {
    return Response.json(
      {
        activationDisabled: true,
        scanned: 0,
        errors: 0,
        notified: 0,
        probes: 0,
        limit,
      },
      { headers: headers() },
    );
  }
  const delivery = await dependencies.dispatch(swept.followUps);
  return Response.json(
    {
      activationDisabled: false,
      scanned: swept.scanned,
      errors: swept.errors,
      notified: delivery.notifiedServerIds.length,
      probes: delivery.probeIds.length,
      limit,
    },
    { headers: headers() },
  );
}

export const Route = createFileRoute("/api/maintenance/managed-rollouts")({
  server: {
    handlers: {
      POST: ({ request }) => handleManagedRolloutMaintenance(request),
      // Vercel Cron sends GET; external schedulers may use either. The token
      // check is identical, and the work is bounded per invocation.
      GET: ({ request }) => handleManagedRolloutMaintenance(request),
    },
  },
});
