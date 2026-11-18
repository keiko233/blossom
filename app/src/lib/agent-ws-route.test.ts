import type { AgentWsWelcomePayload } from "@blossom/contracts/agent-ws";
import { describe, expect, it, vi } from "vitest";

import type { Server } from "@/db/proxy-schema";
import { hashAgentToken } from "@/lib/agent-token";

import {
  authenticateAgentWsRequest,
  handleAgentWsRequest,
} from "./agent-ws-route";
import type { RealtimeHub } from "./realtime-hub-types";

const server = {
  id: "srv-1",
  name: "edge",
  enabled: true,
} as Server;

const welcome: AgentWsWelcomePayload = {
  serverId: "srv-1",
  serverName: "edge",
  protocolVersion: 1,
  desiredRevisionSeq: 4,
  desiredRevision: "4:sha256:rev",
  pollIntervalSeconds: 60,
  heartbeatIntervalSeconds: 30,
};

function request(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/agent/ws", { headers });
}

function makeHub() {
  return {
    acceptAgent: vi.fn(
      async () =>
        new Response(null, {
          status: 426,
          headers: { Upgrade: "websocket" },
        }),
    ),
    notifyConfigChanged: vi.fn(async () => undefined),
    notifyUpdateTrigger: vi.fn(async () => undefined),
  } satisfies RealtimeHub;
}

describe("agent WebSocket route", () => {
  it("rejects missing and invalid bearer tokens before the upgrade", async () => {
    expect(await authenticateAgentWsRequest(request())).toBeNull();

    const lookup = vi.fn(async () => null);
    const authenticated = await authenticateAgentWsRequest(
      request({ authorization: "Bearer not-a-real-token" }),
      lookup,
    );
    expect(authenticated).toBeNull();
    expect(lookup).toHaveBeenCalledWith(hashAgentToken("not-a-real-token"));
  });

  it("rejects disabled servers and returns 401", async () => {
    const disabled = { ...server, enabled: false } as Server;
    const lookup = vi.fn(async () => disabled);
    expect(
      await authenticateAgentWsRequest(
        request({ authorization: "Bearer fake-token" }),
        lookup,
      ),
    ).toBeNull();

    const hub = makeHub();
    const response = await handleAgentWsRequest(
      request({ authorization: "Bearer fake-token", upgrade: "websocket" }),
      {
        authenticate: async () => null,
        buildWelcome: async () => welcome,
        hub,
      },
    );
    expect(response.status).toBe(401);
    expect(
      (response as Response & { crossws?: unknown }).crossws,
    ).toBeDefined();
    expect(hub.acceptAgent).not.toHaveBeenCalled();
  });

  it("authenticates before handing the upgrade to the hub", async () => {
    const hub = makeHub();
    const buildWelcome = vi.fn(async () => welcome);
    const upgradeRequest = request({
      authorization: "Bearer fake-token",
      upgrade: "websocket",
    });

    const response = await handleAgentWsRequest(upgradeRequest, {
      authenticate: async () => server,
      buildWelcome,
      hub,
    });

    expect(response.status).toBe(426);
    expect(buildWelcome).toHaveBeenCalledWith(server);
    expect(hub.acceptAgent).toHaveBeenCalledWith(
      upgradeRequest,
      server,
      welcome,
    );
  });

  it("returns 426 for a valid plain HTTP request and 503 on hub failure", async () => {
    const hub = makeHub();
    const plain = await handleAgentWsRequest(request(), {
      authenticate: async () => server,
      buildWelcome: async () => welcome,
      hub,
    });
    expect(plain.status).toBe(426);
    expect(hub.acceptAgent).not.toHaveBeenCalled();

    hub.acceptAgent.mockRejectedValueOnce(new Error("DO unavailable"));
    const failed = await handleAgentWsRequest(
      request({ upgrade: "websocket" }),
      {
        authenticate: async () => server,
        buildWelcome: async () => welcome,
        hub,
      },
    );
    expect(failed.status).toBe(503);
  });
});
