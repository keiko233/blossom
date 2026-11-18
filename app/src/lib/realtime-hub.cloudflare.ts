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
import { markAgentWsConnected, markAgentWsDisconnected } from "@/query/agent";

import {
  AGENT_WS_INTERNAL_CONNECTED_AT,
  AGENT_WS_INTERNAL_SERVER_ID,
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

  async notifyConfigChanged(
    serverId: string,
    payload: AgentWsConfigNotifyPayload,
  ): Promise<void> {
    await this.sendFrame(
      serverId,
      encodeAgentWsFrame(createAgentWsFrame("config.notify", payload)),
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

  private async sendFrame(serverId: string, frame: string): Promise<void> {
    try {
      const response = await durableObjectStub(serverId).fetch(
        new Request("https://agent-session.internal/internal/notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ frame }),
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
