import type {
  AgentWsConfigNotifyPayload,
  AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";
import { parseAgentWsFrame } from "@blossom/contracts/agent-ws";
import { describe, expect, it, vi } from "vitest";

import type { Server } from "@/db/proxy-schema";

import type { AgentWsStore } from "./agent-ws-session";
import { NitroRealtimeHub, withRuntimeReconnectHint } from "./realtime-hub";
import type { RealtimeBackplane } from "./realtime-hub-types";

const server = {
  id: "srv-1",
  name: "edge",
  enabled: true,
} as Server;

const welcome: AgentWsWelcomePayload = {
  serverId: "srv-1",
  serverName: "edge",
  protocolVersion: 1,
  desiredRevisionSeq: 3,
  desiredRevision: "3:sha256:rev",
  pollIntervalSeconds: 60,
  heartbeatIntervalSeconds: 30,
};

function fakeStore(): AgentWsStore {
  return {
    markConnected: vi.fn(async () => new Date("2026-11-19T00:00:00.000Z")),
    markDisconnected: vi.fn(async () => undefined),
    recordHello: vi.fn(async () => undefined),
    recordConfigAck: vi.fn(async () => undefined),
    recordUpdateStatus: vi.fn(async () => undefined),
    applyCertificateDeployments: vi.fn(async () => undefined),
  };
}

function fakeBackplane() {
  const deliverers: Array<
    (message: { origin: string; serverId: string; frame: string }) => void
  > = [];
  return {
    subscribe: vi.fn(async (deliver: (typeof deliverers)[number]) => {
      deliverers.push(deliver);
    }),
    publish: vi.fn(async () => undefined),
  } satisfies RealtimeBackplane;
}

describe("NitroRealtimeHub", () => {
  it("adds the proactive reconnect hint only on Vercel", () => {
    expect(withRuntimeReconnectHint(welcome, { vercel: true })).toEqual({
      ...welcome,
      reconnectBeforeSeconds: 240,
    });
    expect(withRuntimeReconnectHint(welcome, { vercel: false })).toEqual(
      welcome,
    );
  });

  it("attaches crossws hooks and routes config notifications to the peer", async () => {
    const store = fakeStore();
    const backplane = fakeBackplane();
    const hub = new NitroRealtimeHub({ store, backplane });
    const response = (await hub.acceptAgent(
      new Request("http://localhost/api/agent/ws", {
        headers: { upgrade: "websocket" },
      }),
      server,
      welcome,
    )) as Response & {
      crossws: {
        open(peer: unknown): Promise<void>;
        close(peer: unknown, details: object): Promise<void>;
      };
    };
    expect(response.status).toBe(426);
    expect(response.crossws).toBeDefined();

    const sent: string[] = [];
    const peer = {
      id: "peer-1",
      send: vi.fn((data: string) => {
        sent.push(data);
      }),
      close: vi.fn(),
    };
    await response.crossws.open(peer);
    expect(store.markConnected).toHaveBeenCalledWith("srv-1");

    const payload: AgentWsConfigNotifyPayload = {
      desiredRevisionSeq: 4,
      desiredRevision: "4:sha256:next",
      reason: "node updated",
    };
    await hub.notifyConfigChanged("srv-1", payload);
    const frame = parseAgentWsFrame(sent.at(-1)!);
    expect(frame.ok).toBe(true);
    if (frame.ok) {
      expect(frame.message).toEqual({ kind: "config.notify", payload });
    }
    expect(backplane.publish).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", frame: sent.at(-1) }),
    );

    await response.crossws.close(peer, {});
    expect(store.markDisconnected).toHaveBeenCalledWith(
      "srv-1",
      new Date("2026-11-19T00:00:00.000Z"),
    );
  });
});
