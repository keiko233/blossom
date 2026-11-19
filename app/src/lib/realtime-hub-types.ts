import type {
  AgentWsAcmeDnsAckPayload,
  AgentWsAcmeIssuePayload,
  AgentWsConfigNotifyPayload,
  AgentWsUpdateTriggerPayload,
  AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";

import type { Server } from "@/db/proxy-schema";

import type { TelemetryKind, TelemetryResult } from "./agent-telemetry";
import type { LiveMetricSample } from "./live-metrics";

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
  /**
   * Completes an upgrade that negotiated the v2 subprotocol. The session is
   * started and welcomed in-band, so no welcome is computed at upgrade time.
   */
  acceptAgentV2(request: Request, server: Server): Promise<Response>;
  requestTelemetry(
    serverId: string,
    kind: TelemetryKind,
    connectedAt: string,
  ): Promise<TelemetryResult | null>;
  /** Inspection through the negotiated v1 or v2 agent session. */
  inspectTelemetry(
    serverId: string,
    connectedAt: string,
    sessionId: string | null,
  ): Promise<TelemetryResult | null>;
  notifyConfigChanged(
    serverId: string,
    payload: AgentWsConfigNotifyPayload,
  ): Promise<void>;
  notifyUpdateTrigger(
    serverId: string,
    payload: AgentWsUpdateTriggerPayload,
  ): Promise<void>;
  notifyAcmeIssue(
    serverId: string,
    payload: AgentWsAcmeIssuePayload,
  ): Promise<void>;
  notifyAcmeDnsAck(
    serverId: string,
    payload: AgentWsAcmeDnsAckPayload,
  ): Promise<void>;
}

export interface RealtimeBackplaneMessage {
  origin: string;
  serverId: string;
  frame: string;
  /** Set for v2 pushes, which only v2 sessions may receive. */
  protocol?: "v2";
  /** Admin PTY frames are routed to one side, not broadcast to agents. */
  ptyTarget?: "agent" | "browser";
  ptySessionId?: string;
  connectedAt?: string;
  agentDisconnected?: true;
  telemetryReply?: true;
  /** A live sample relayed so every instance's admin viewers can see it. */
  liveMetricSample?: LiveMetricSample;
  liveMetricSessionId?: string;
  /** A v2 inspection snapshot relayed to the instance holding the viewer. */
  agentSnapshot?: { requestId: string; snapshot: unknown };
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
export const AGENT_WS_INTERNAL_PROTOCOL = "x-blossom-agent-protocol";
export const AGENT_WS_INTERNAL_SESSION_ID = "x-blossom-agent-session-id";
