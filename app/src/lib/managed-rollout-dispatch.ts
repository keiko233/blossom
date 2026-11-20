import type { AgentWsConfigNotifyPayload } from "@blossom/contracts/agent-ws";
import type { ManagedLinkProbeRequest } from "@blossom/contracts/managed-link-probe";

import type {
  ManagedRolloutDispatchPort,
  ManagedRolloutDispatchResult,
  ManagedRolloutFollowUp,
} from "./managed-rollout-runtime";
import { dispatchManagedRolloutFollowUps } from "./managed-rollout-runtime";
import type { RealtimeHub } from "./realtime-hub-types";

/** Binds the generic follow-up dispatcher to a per-server notification hub. */
export function managedRolloutHubPort(
  hub: RealtimeHub,
): ManagedRolloutDispatchPort {
  return {
    notifyConfigChanged: (
      serverId: string,
      payload: AgentWsConfigNotifyPayload,
    ) => hub.notifyConfigChanged(serverId, payload),
    sendLinkProbe: (
      serverId: string,
      sessionId: string,
      request: ManagedLinkProbeRequest,
    ) => hub.sendLinkProbe(serverId, sessionId, request),
  };
}

/**
 * Post-commit delivery for the admin actions and the bounded maintenance
 * route. The import stays lazy so a runtime resolves its own hub variant.
 */
export async function dispatchManagedRolloutThroughHub(
  followUps: readonly ManagedRolloutFollowUp[],
): Promise<ManagedRolloutDispatchResult> {
  const { getRealtimeHub } = await import("./realtime-hub");
  return dispatchManagedRolloutFollowUps(
    followUps,
    managedRolloutHubPort(getRealtimeHub()),
  );
}
