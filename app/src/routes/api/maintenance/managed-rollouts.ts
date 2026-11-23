import { createFileRoute } from "@tanstack/react-router";

import { getServerEnv } from "@/lib/env";
import {
  authorizeMaintenanceRequest,
  NO_STORE_HEADERS,
} from "@/lib/maintenance-auth";
import { dispatchManagedRolloutThroughHub } from "@/lib/managed-rollout-dispatch";
import type { ManagedRolloutDispatchResult } from "@/lib/managed-rollout-runtime";
import {
  sweepManagedRollouts,
  type ManagedRolloutFollowUp,
} from "@/lib/managed-rollout-runtime";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function boundedLimit(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_LIMIT)
    : DEFAULT_LIMIT;
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
  const denied = authorizeMaintenanceRequest(request, dependencies.token());
  if (denied) {
    return denied;
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
      { headers: NO_STORE_HEADERS },
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
    { headers: NO_STORE_HEADERS },
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
