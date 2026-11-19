import {
  createAgentWsFrame,
  encodeAgentWsFrame,
  type AgentWsAcmeDnsAckPayload,
  type AgentWsAcmeIssuePayload,
  type AgentWsConfigNotifyPayload,
  type AgentWsUpdateTriggerPayload,
  type AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";
import { env } from "cloudflare:workers";

import type { Server } from "@/db/proxy-schema";
import {
  markAgentWsConnected,
  markAgentWsDisconnected,
  endAgentWsSession,
} from "@/query/agent";

import type { TelemetryKind, TelemetryResult } from "./agent-telemetry";
import { createAgentWsV2Store } from "./agent-ws-store";
import { encodeAgentWsV2ConfigNotify } from "./agent-ws-v2-session";
import type { AdminLogsAcceptContext } from "./logs-relay-types";
import {
  AGENT_LOGS_INTERNAL_ACTOR,
  AGENT_LOGS_INTERNAL_AUTH_SESSION_ID,
  AGENT_LOGS_INTERNAL_RELAY_ID,
  AGENT_LOGS_INTERNAL_SERVER_ID,
  AGENT_LOGS_INTERNAL_SESSION_ID,
  AGENT_LOGS_INTERNAL_STARTED_AT,
  AGENT_WS_INTERNAL_CONNECTED_AT,
  AGENT_WS_INTERNAL_PROTOCOL,
  AGENT_WS_INTERNAL_SERVER_ID,
  AGENT_WS_INTERNAL_SESSION_ID,
  AGENT_WS_INTERNAL_WELCOME,
  type RealtimeHub,
} from "./realtime-hub-types";

function requireAgentSessionBinding() {
  if (!env.AGENT_SESSION_DO) {
    throw new Error("AGENT_SESSION_DO binding is not configured");
  }
  return env.AGENT_SESSION_DO;
}

function durableObjectStub(serverId: string) {
  const binding = requireAgentSessionBinding();
  return binding.get(binding.idFromName(serverId));
}

export class CloudflareRealtimeHub implements RealtimeHub {
  async acceptAgent(
    request: Request,
    server: Server,
    welcome: AgentWsWelcomePayload,
  ): Promise<Response> {
    let connectedAt = new Date();
    try {
      connectedAt = await markAgentWsConnected(server.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`agent websocket connect metadata failed: ${message}`);
    }

    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    headers.set(AGENT_WS_INTERNAL_SERVER_ID, server.id);
    headers.set(AGENT_WS_INTERNAL_CONNECTED_AT, connectedAt.toISOString());
    headers.set(
      AGENT_WS_INTERNAL_WELCOME,
      encodeURIComponent(JSON.stringify(welcome)),
    );

    try {
      const response = await durableObjectStub(server.id).fetch(
        new Request(new URL("/internal/connect", request.url), {
          method: "GET",
          headers,
        }),
      );
      if (response.status !== 101) {
        await markAgentWsDisconnected(server.id, connectedAt).catch(() => {});
      }
      return response;
    } catch (error) {
      await markAgentWsDisconnected(server.id, connectedAt).catch(() => {});
      throw error;
    }
  }

  async acceptAgentV2(request: Request, server: Server): Promise<Response> {
    const started = await createAgentWsV2Store().startSession(
      server.id,
      server.agentTokenHash,
    );
    if (!started) {
      // The credential changed after the upgrade was authenticated.
      return new Response("Unauthorized", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }

    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    headers.set(AGENT_WS_INTERNAL_SERVER_ID, server.id);
    headers.set(
      AGENT_WS_INTERNAL_CONNECTED_AT,
      started.connectedAt.toISOString(),
    );
    headers.set(AGENT_WS_INTERNAL_PROTOCOL, "v2");
    headers.set(AGENT_WS_INTERNAL_SESSION_ID, started.sessionId);

    try {
      const response = await durableObjectStub(server.id).fetch(
        new Request(new URL("/internal/connect", request.url), {
          method: "GET",
          headers,
        }),
      );
      if (response.status !== 101) {
        await endAgentWsSession(server.id, started.sessionId).catch(() => {});
      }
      return response;
    } catch (error) {
      await endAgentWsSession(server.id, started.sessionId).catch(() => {});
      throw error;
    }
  }

  async acceptAdminLogs(
    request: Request,
    context: AdminLogsAcceptContext,
  ): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    headers.set(AGENT_LOGS_INTERNAL_SERVER_ID, context.serverId);
    headers.set(AGENT_LOGS_INTERNAL_SESSION_ID, context.agentSessionId);
    headers.set(AGENT_LOGS_INTERNAL_AUTH_SESSION_ID, context.authSessionId);
    headers.set(AGENT_LOGS_INTERNAL_RELAY_ID, context.relayId);
    headers.set(
      AGENT_LOGS_INTERNAL_STARTED_AT,
      context.startedAt.toISOString(),
    );
    headers.set(
      AGENT_LOGS_INTERNAL_ACTOR,
      encodeURIComponent(JSON.stringify(context.actor)),
    );
    return durableObjectStub(context.serverId).fetch(
      new Request(new URL("/internal/logs/connect", request.url), {
        method: "GET",
        headers,
      }),
    );
  }

  async requestTelemetry(
    serverId: string,
    kind: TelemetryKind,
    connectedAt: string,
  ): Promise<TelemetryResult | null> {
    try {
      const response = await durableObjectStub(serverId).fetch(
        new Request(
          `https://agent-session.internal/internal/telemetry?kind=${kind}&connectedAt=${encodeURIComponent(connectedAt)}`,
          { method: "POST" },
        ),
      );
      return response.status === 200
        ? ((await response.json()) as TelemetryResult)
        : null;
    } catch {
      return null;
    }
  }

  async notifyConfigChanged(
    serverId: string,
    payload: AgentWsConfigNotifyPayload,
  ): Promise<void> {
    await this.sendFrame(
      serverId,
      encodeAgentWsFrame(createAgentWsFrame("config.notify", payload)),
    );
    await this.sendFrame(
      serverId,
      encodeAgentWsV2ConfigNotify({
        desired: {
          desiredRevisionSeq: payload.desiredRevisionSeq,
          desiredRevision: payload.desiredRevision,
        },
        ...(payload.reason ? { reason: payload.reason } : {}),
      }),
      "v2",
    );
  }

  async notifyUpdateTrigger(
    serverId: string,
    payload: AgentWsUpdateTriggerPayload,
  ): Promise<void> {
    await this.sendFrame(
      serverId,
      encodeAgentWsFrame(createAgentWsFrame("update.trigger", payload)),
    );
  }

  async notifyAcmeIssue(
    serverId: string,
    payload: AgentWsAcmeIssuePayload,
  ): Promise<void> {
    await this.sendFrame(
      serverId,
      encodeAgentWsFrame(createAgentWsFrame("acme.issue", payload)),
    );
  }

  async notifyAcmeDnsAck(
    serverId: string,
    payload: AgentWsAcmeDnsAckPayload,
  ): Promise<void> {
    await this.sendFrame(
      serverId,
      encodeAgentWsFrame(createAgentWsFrame("acme.dns_ack", payload)),
    );
  }

  private async sendFrame(
    serverId: string,
    frame: string,
    protocol?: "v2",
  ): Promise<void> {
    try {
      const response = await durableObjectStub(serverId).fetch(
        new Request("https://agent-session.internal/internal/notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ frame, ...(protocol ? { protocol } : {}) }),
        }),
      );
      if (!response.ok) {
        throw new Error(
          `agent session notification returned ${response.status}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`agent websocket notification failed: ${message}`);
    }
  }
}

let hub: RealtimeHub | undefined;

export function getRealtimeHub(): RealtimeHub {
  return (hub ??= new CloudflareRealtimeHub());
}
