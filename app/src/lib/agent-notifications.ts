import type {
  AgentWsConfigNotifyPayload,
  AgentWsUpdateTriggerPayload,
} from "@blossom/contracts/agent-ws";

import type { Server } from "@/db/proxy-schema";

import type { RealtimeHub } from "./realtime-hub-types";

export interface AgentNotificationDependencies {
  loadServer(serverId: string): Promise<Server | null>;
  loadDesiredRevision(server: Server): Promise<string>;
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
