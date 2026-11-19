import {
  createAgentWsFrame,
  encodeAgentWsFrame,
  type AgentWsAcmeDnsAckPayload,
  type AgentWsAcmeIssuePayload,
  type AgentWsConfigNotifyPayload,
  type AgentWsUpdateTriggerPayload,
  type AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";
import {
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
} from "@blossom/contracts/agent-ws-v2";
import { env } from "cloudflare:workers";

import type { Server } from "@/db/proxy-schema";
import type { AgentSessionCredential } from "@/query/agent";
import {
  markAgentWsConnected,
  markAgentWsDisconnected,
  endAgentWsSession,
} from "@/query/agent";

import type { TelemetryKind, TelemetryResult } from "./agent-telemetry";
import { createAgentWsV2Store } from "./agent-ws-store";
import { encodeAgentWsV2ConfigNotify } from "./agent-ws-v2-session";
import {
  AGENT_WS_INTERNAL_CONNECTED_AT,
  AGENT_WS_INTERNAL_CREDENTIAL_KIND,
  AGENT_WS_INTERNAL_IDENTITY_GENERATION,
  AGENT_WS_INTERNAL_IDENTITY_ID,
  AGENT_WS_INTERNAL_PROTOCOL,
  AGENT_WS_INTERNAL_SERVER_ID,
  AGENT_WS_INTERNAL_SESSION_EXPIRES_AT,
  AGENT_WS_INTERNAL_SESSION_ID,
  AGENT_WS_INTERNAL_SESSION_PENDING,
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
    let sessionId: string | null = null;
    try {
      const started = await markAgentWsConnected(server.id);
      connectedAt = started.connectedAt;
      sessionId = started.sessionId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`agent websocket connect metadata failed: ${message}`);
    }

    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    headers.set(AGENT_WS_INTERNAL_SERVER_ID, server.id);
    headers.set(AGENT_WS_INTERNAL_CONNECTED_AT, connectedAt.toISOString());
    if (sessionId) {
      headers.set(AGENT_WS_INTERNAL_SESSION_ID, sessionId);
    }
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
        if (sessionId) {
          await markAgentWsDisconnected(server.id, sessionId).catch(
            () => {},
          );
        }
      }
      return response;
    } catch (error) {
      if (sessionId) {
        await markAgentWsDisconnected(server.id, sessionId).catch(() => {});
      }
      throw error;
    }
  }

  async acceptAgentV2(
    request: Request,
    server: Server,
    credential: AgentSessionCredential,
  ): Promise<Response> {
    const started = await createAgentWsV2Store().startSession(
      server.id,
      credential,
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
    headers.set(AGENT_WS_INTERNAL_CREDENTIAL_KIND, credential.kind);
    headers.set(AGENT_WS_INTERNAL_SESSION_PENDING, started.pending ? "1" : "0");
    if (credential.kind === "oauth") {
      headers.set(AGENT_WS_INTERNAL_IDENTITY_ID, credential.identityId);
      headers.set(
        AGENT_WS_INTERNAL_IDENTITY_GENERATION,
        String(credential.generation),
      );
      headers.set(
        AGENT_WS_INTERNAL_SESSION_EXPIRES_AT,
        String(credential.expiresAt),
      );
    }

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
    await this.sendFrame(
      serverId,
      encodeAgentWsV2Frame(createAgentWsV2Frame("update.trigger", payload)),
      "v2",
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
    await this.sendFrame(
      serverId,
      encodeAgentWsV2Frame(createAgentWsV2Frame("acme.issue", payload)),
      "v2",
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
    await this.sendFrame(
      serverId,
      encodeAgentWsV2Frame(createAgentWsV2Frame("acme.dns_ack", payload)),
      "v2",
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
