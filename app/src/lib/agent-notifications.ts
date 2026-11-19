import type {
  AgentWsAcmeDnsAckPayload,
  AgentWsAcmeIssuePayload,
  AgentWsConfigNotifyPayload,
  AgentWsUpdateTriggerPayload,
} from "@blossom/contracts/agent-ws";
import type { LogPolicyNotifyPayload } from "@blossom/contracts/log-policy";

import type { Server } from "@/db/proxy-schema";

import type { RealtimeHub } from "./realtime-hub-types";

export interface AgentNotificationDependencies {
  loadServer(serverId: string): Promise<Server | null>;
  loadDesiredRevision(server: Server): Promise<string>;
  /**
   * Clears the server's cached v2 configuration identifier. The push below may
   * never arrive, so the next v2 status exchange must recompile instead of
   * trusting a cache that predates this change.
   */
  invalidateDesiredRevision?(serverId: string): Promise<void>;
  hub: Pick<
    RealtimeHub,
    "acceptAgent" | "notifyConfigChanged" | "notifyUpdateTrigger"
  >;
}

const defaultDependencies: AgentNotificationDependencies = {
  loadServer: async (serverId) => {
    const [{ db }, { eq }, { server }] = await Promise.all([
      import("@/db"),
      import("drizzle-orm"),
      import("@/db/proxy-schema"),
    ]);
    const [row] = await db.select().from(server).where(eq(server.id, serverId));
    return row ?? null;
  },
  loadDesiredRevision: async (row) => {
    const { buildAgentDesiredState } =
      await import("@/orpc/proxy/agent-desired-state");
    return (await buildAgentDesiredState(row)).desiredRevision;
  },
  invalidateDesiredRevision: async (serverId) => {
    const { invalidateDesiredConfigRevisions } = await import("@/query/agent");
    await invalidateDesiredConfigRevisions([serverId]);
  },
  hub: {
    acceptAgent: async (...args) =>
      (await import("@/lib/realtime-hub"))
        .getRealtimeHub()
        .acceptAgent(...args),
    notifyConfigChanged: async (...args) =>
      (await import("@/lib/realtime-hub"))
        .getRealtimeHub()
        .notifyConfigChanged(...args),
    notifyUpdateTrigger: async (...args) =>
      (await import("@/lib/realtime-hub"))
        .getRealtimeHub()
        .notifyUpdateTrigger(...args),
  },
};

function logFailure(operation: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`agent notification ${operation} failed: ${message}`);
}

/**
 * Best-effort push after a publish-gate mutation has committed. Failures,
 * including an unavailable socket/DO/Redis, are logged and never propagated
 * back into the SQL mutation.
 */
export async function notifyAgentConfigChanged(
  serverIds: readonly string[],
  reason?: string,
  dependencies: AgentNotificationDependencies = defaultDependencies,
): Promise<void> {
  for (const serverId of new Set(serverIds)) {
    try {
      await dependencies.invalidateDesiredRevision?.(serverId);
      const row = await dependencies.loadServer(serverId);
      if (!row) {
        continue;
      }
      const payload: AgentWsConfigNotifyPayload = {
        desiredRevisionSeq: row.desiredRevisionSeq,
        desiredRevision: await dependencies.loadDesiredRevision(row),
        ...(reason ? { reason } : {}),
      };
      await dependencies.hub.notifyConfigChanged(serverId, payload);
    } catch (error) {
      logFailure("config.notify", error);
    }
  }
}

export async function notifyAgentUpdateTrigger(
  serverId: string,
  payload: AgentWsUpdateTriggerPayload,
  hub?: Pick<RealtimeHub, "notifyUpdateTrigger">,
): Promise<void> {
  try {
    const targetHub =
      hub ?? (await import("@/lib/realtime-hub")).getRealtimeHub();
    await targetHub.notifyUpdateTrigger(serverId, payload);
  } catch (error) {
    logFailure("update.trigger", error);
  }
}

export async function notifyAgentAcmeIssue(
  serverId: string,
  payload: AgentWsAcmeIssuePayload,
  hub?: RealtimeHub,
): Promise<void> {
  try {
    const targetHub =
      hub ?? (await import("@/lib/realtime-hub")).getRealtimeHub();
    await targetHub.notifyAcmeIssue(serverId, payload);
  } catch (error) {
    logFailure("acme.issue", error);
  }
}

export async function notifyAgentAcmeDnsAck(
  serverId: string,
  payload: AgentWsAcmeDnsAckPayload,
): Promise<void> {
  try {
    const targetHub = (await import("@/lib/realtime-hub")).getRealtimeHub();
    await targetHub.notifyAcmeDnsAck(serverId, payload);
  } catch (error) {
    logFailure("acme.dns_ack", error);
  }
}

/**
 * Best-effort log-policy push after the compare-and-swap committed. A missing
 * v2 session is fine: `welcome` and every `agent.status.ack` carry the
 * server-wide revision, and the agent fetches a snapshot when it differs.
 */
export async function notifyAgentLogPolicyChanged(
  serverId: string,
  revision: number,
  source?: "agent" | "sing-box",
  hub?: Pick<RealtimeHub, "notifyLogPolicy">,
): Promise<void> {
  try {
    const targetHub =
      hub ?? (await import("@/lib/realtime-hub")).getRealtimeHub();
    const payload: LogPolicyNotifyPayload = {
      revision,
      ...(source ? { source } : {}),
      reason: "log policy changed",
    };
    await targetHub.notifyLogPolicy(serverId, payload);
  } catch (error) {
    logFailure("log.policy.notify", error);
  }
}
