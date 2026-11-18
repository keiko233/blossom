import type {
  AgentWsConfigNotifyPayload,
  AgentWsUpdateTriggerPayload,
  AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";

import type { Server } from "@/db/proxy-schema";

import type { TelemetryKind, TelemetryResult } from "./agent-telemetry";

export interface RealtimeHub {
  /**
   * Completes an already-authenticated agent upgrade. Nitro returns the 426
   * response carrying crossws hooks; Cloudflare returns the DO's 101 response.
   */
  acceptAgent(
    request: Request,
    server: Server,
    welcome: AgentWsWelcomePayload,
  ): Promise<Response>;
  requestTelemetry(
    serverId: string,
    kind: TelemetryKind,
    connectedAt: string,
  ): Promise<TelemetryResult | null>;
  notifyConfigChanged(
    serverId: string,
    payload: AgentWsConfigNotifyPayload,
  ): Promise<void>;
  notifyUpdateTrigger(
    serverId: string,
    payload: AgentWsUpdateTriggerPayload,
  ): Promise<void>;
}

export interface RealtimeBackplaneMessage {
  origin: string;
  serverId: string;
  frame: string;
  /** Admin PTY frames are routed to one side, not broadcast to agents. */
  ptyTarget?: "agent" | "browser";
  ptySessionId?: string;
  connectedAt?: string;
  agentDisconnected?: true;
  telemetryReply?: true;
}

export interface RealtimeBackplane {
  subscribe(
    deliver: (message: RealtimeBackplaneMessage) => void,
  ): Promise<void>;
  publish(message: RealtimeBackplaneMessage): Promise<void>;
}

export const REALTIME_BACKPLANE_CHANNEL = "blossom:agent-ws:v1";

export const AGENT_WS_INTERNAL_SERVER_ID = "x-blossom-agent-server-id";
export const AGENT_WS_INTERNAL_CONNECTED_AT = "x-blossom-agent-connected-at";
export const AGENT_WS_INTERNAL_WELCOME = "x-blossom-agent-welcome";
