import type {
  AgentWsAcmeDnsAckPayload,
  AgentWsAcmeIssuePayload,
  AgentWsConfigNotifyPayload,
  AgentWsUpdateTriggerPayload,
  AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";
import type { LogPolicyNotifyPayload } from "@blossom/contracts/log-policy";

import type { Server } from "@/db/proxy-schema";

import type { TelemetryKind, TelemetryResult } from "./agent-telemetry";
import type { AdminLogsAcceptContext } from "./logs-relay-types";

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
  /**
   * Completes an already-authenticated, same-origin admin log upgrade. The
   * context names the server and the current v2 agent session the relay binds
   * to; both runtimes deliver agent log frames only for that session.
   */
  acceptAdminLogs(
    request: Request,
    context: AdminLogsAcceptContext,
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
  notifyAcmeIssue(
    serverId: string,
    payload: AgentWsAcmeIssuePayload,
  ): Promise<void>;
  notifyAcmeDnsAck(
    serverId: string,
    payload: AgentWsAcmeDnsAckPayload,
  ): Promise<void>;
  /** v2-only push. A v1 session never receives log policy frames. */
  notifyLogPolicy(
    serverId: string,
    payload: LogPolicyNotifyPayload,
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
  /** Admin log frames cross instances by session, never by browser id. */
  logTarget?: "agent" | "browser";
  logSessionId?: string;
  /** A newer agent session replaced every relay bound to an older one. */
  logSuperseded?: true;
  /** The agent session that relays are bound to has disconnected. */
  logAgentGone?: true;
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
export const AGENT_WS_INTERNAL_PROTOCOL = "x-blossom-agent-protocol";
export const AGENT_WS_INTERNAL_SESSION_ID = "x-blossom-agent-session-id";
export const AGENT_LOGS_INTERNAL_SERVER_ID = "x-blossom-agent-logs-server-id";
export const AGENT_LOGS_INTERNAL_SESSION_ID = "x-blossom-agent-logs-session-id";
export const AGENT_LOGS_INTERNAL_AUTH_SESSION_ID =
  "x-blossom-agent-logs-auth-session-id";
export const AGENT_LOGS_INTERNAL_RELAY_ID = "x-blossom-agent-logs-relay-id";
export const AGENT_LOGS_INTERNAL_ACTOR = "x-blossom-agent-logs-actor";
export const AGENT_LOGS_INTERNAL_STARTED_AT = "x-blossom-agent-logs-started-at";
