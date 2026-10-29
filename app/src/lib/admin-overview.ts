import {
  type AgentStatusLike,
  deriveServerHealth,
  type ServerHealth,
} from "@/lib/agent-status";

/** Subscriptions expiring within this many days are flagged on the overview. */
export const EXPIRING_SOON_DAYS = 7;

/** Subscriptions at or above this percentage of their quota are flagged. */
export const QUOTA_WARNING_PERCENT = 90;

/** Cap on rows per attention list; the overview shows counts for the rest. */
export const OVERVIEW_LIST_LIMIT = 8;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Upper bound (inclusive) of the "expiring soon" window. */
export function getExpiringSoonCutoff(
  now = Date.now(),
  days = EXPIRING_SOON_DAYS,
): Date {
  return new Date(now + days * MS_PER_DAY);
}

/**
 * Whether an expiry date lands inside the "expiring soon" window: still in the
 * future (already-expired subscriptions are not "soon") and within `days`.
 */
export function isExpiringSoon(
  expiresAt: Date | string | number,
  now = Date.now(),
  days = EXPIRING_SOON_DAYS,
): boolean {
  const time = new Date(expiresAt).getTime();
  return time > now && time <= getExpiringSoonCutoff(now, days).getTime();
}

/**
 * Fraction of the quota consumed (may exceed 1 when over quota). Unlimited
 * quotas (`trafficQuotaBytes === 0`) have no ratio and return null.
 */
export function getQuotaUsageRatio(
  trafficQuotaBytes: number,
  trafficUsedBytes: number,
): number | null {
  if (trafficQuotaBytes <= 0) return null;
  return trafficUsedBytes / trafficQuotaBytes;
}

/** Whether usage reached the warning threshold; unlimited quotas never do. */
export function isNearQuota(
  trafficQuotaBytes: number,
  trafficUsedBytes: number,
  thresholdPercent = QUOTA_WARNING_PERCENT,
): boolean {
  const ratio = getQuotaUsageRatio(trafficQuotaBytes, trafficUsedBytes);
  return ratio !== null && ratio * 100 >= thresholdPercent;
}

export interface OverviewServerInput extends AgentStatusLike {
  id: string;
  name: string;
  address: string;
  lastErrorMessage: string | null;
}

export interface ServerAttentionItem {
  id: string;
  name: string;
  address: string;
  health: ServerHealth;
  /** Recorded changes the agent has not confirmed applied yet. */
  pendingConfigChanges: number;
  lastErrorMessage: string | null;
}

export interface ServerOverviewSummary {
  total: number;
  /** Servers whose agent is reachable and serving its applied config. */
  online: number;
  /** Servers needing attention, most severe first (not truncated). */
  attention: ServerAttentionItem[];
}

/** Health states an admin should act on; "disabled" is intentional. */
const ATTENTION_HEALTH: ReadonlySet<ServerHealth> = new Set([
  "agent_offline",
  "runtime_error",
  "config_error",
  "degraded",
]);

/** Lower sorts first. */
const HEALTH_SEVERITY: Record<ServerHealth, number> = {
  agent_offline: 0,
  runtime_error: 1,
  config_error: 2,
  degraded: 3,
  unknown: 4,
  online: 5,
  disabled: 6,
};

/**
 * Buckets servers into online / needs-attention using the shared agent
 * liveness rules. A disabled server is never flagged; an enabled one is
 * flagged when its health is a problem state or it has changes still awaiting
 * apply. Sorted by severity, then by pending-change count, then by name.
 */
export function summarizeServers(
  servers: readonly OverviewServerInput[],
  pendingByServer: ReadonlyMap<string, number>,
  now = Date.now(),
): ServerOverviewSummary {
  let online = 0;
  const attention: ServerAttentionItem[] = [];

  for (const server of servers) {
    const health = deriveServerHealth(server, now);
    if (health === "online") online += 1;
    if (health === "disabled") continue;

    const pendingConfigChanges = pendingByServer.get(server.id) ?? 0;
    if (!ATTENTION_HEALTH.has(health) && pendingConfigChanges === 0) continue;

    attention.push({
      id: server.id,
      name: server.name,
      address: server.address,
      health,
      pendingConfigChanges,
      lastErrorMessage: server.lastErrorMessage,
    });
  }

  attention.sort(
    (a, b) =>
      HEALTH_SEVERITY[a.health] - HEALTH_SEVERITY[b.health] ||
      b.pendingConfigChanges - a.pendingConfigChanges ||
      a.name.localeCompare(b.name),
  );

  return { total: servers.length, online, attention };
}
