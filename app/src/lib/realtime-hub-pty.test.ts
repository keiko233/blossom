import {
  createAgentWsFrame,
  encodeAgentWsFrame,
  parseAgentWsFrame,
  type AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";
import { describe, expect, it, vi } from "vitest";

import type { Server } from "@/db/proxy-schema";

import type { AgentWsStore } from "./agent-ws-session";
import { NitroRealtimeHub } from "./realtime-hub";
import type { RealtimeBackplane } from "./realtime-hub-types";

const server = { id: "srv-1", name: "edge", enabled: true } as Server;
const connectedAt = "2026-11-19T00:00:00.000Z";
const welcome: AgentWsWelcomePayload = {
  serverId: "srv-1",
  serverName: "edge",
  protocolVersion: 1,
  desiredRevisionSeq: 1,
  desiredRevision: "1:sha256:rev",
  pollIntervalSeconds: 60,
  heartbeatIntervalSeconds: 30,
};

function store(): AgentWsStore {
  return {
    markConnected: vi.fn(async () => new Date(connectedAt)),
    markDisconnected: vi.fn(async () => undefined),
    recordHello: vi.fn(async () => undefined),
    recordConfigAck: vi.fn(async () => undefined),
    recordUpdateStatus: vi.fn(async () => undefined),
    applyCertificateDeployments: vi.fn(async () => undefined),
    handleAcmeDnsPresent: vi.fn(async () => undefined),
    handleAcmeDnsCleanup: vi.fn(async () => undefined),
    handleAcmeResult: vi.fn(async () => undefined),
  };
}

function backplane(): RealtimeBackplane {
  return {
    subscribe: vi.fn(async () => undefined),
    publish: vi.fn(async () => undefined),
  };
}

describe("NitroRealtimeHub PTY relay", () => {
  it("routes admin frames to the agent and agent frames back to the relay", async () => {
    const hub = new NitroRealtimeHub({
      store: store(),
      backplane: backplane(),
    });
    const response = (await hub.acceptAgent(
      new Request("http://localhost/api/agent/ws", {
        headers: { upgrade: "websocket" },
      }),
      server,
      welcome,
    )) as Response & {
      crossws: {
        open(peer: unknown): Promise<void>;
        message(peer: unknown, message: { text(): string }): Promise<void>;
        close(peer: unknown, details: object): Promise<void>;
      };
    };
    const sent: string[] = [];
    const peer = {
      id: "peer-1",
      send: vi.fn((data: string) => sent.push(data)),
      close: vi.fn(),
    };
    await response.crossws.open(peer);

    expect(await hub.hasAgentConnection("srv-1", connectedAt)).toBe(true);

    const handler = vi.fn();
    const unregister = hub.registerPtyRelay(
      "srv-1",
      connectedAt,
      "pty-1",
      handler,
    );

    expect(
      await hub.sendPtyFrame(
        "srv-1",
        connectedAt,
        "pty-1",
        encodeAgentWsFrame(
          createAgentWsFrame("pty.open", {
            sessionId: "pty-1",
            cols: 80,
            rows: 24,
          }),
        ),
      ),
    ).toBe(true);
    const open = parseAgentWsFrame(sent.at(-1)!);
    expect(open.ok && open.message.kind).toBe("reserved");

    const reply = encodeAgentWsFrame(
      createAgentWsFrame("pty.data", {
        sessionId: "pty-1",
        data: "hello",
      }),
    );
    await response.crossws.message(peer, { text: () => reply });
    expect(handler).toHaveBeenCalledWith({
      type: "frame",
      frame: expect.any(String),
    });
    const forwarded = handler.mock.calls[0]![0].frame as string;
    const parsed = parseAgentWsFrame(forwarded);
    expect(parsed.ok && parsed.message.kind).toBe("reserved");

    unregister();
    await response.crossws.close(peer, {});
  });

  it("closes local relays when the agent disconnects", async () => {
    const hub = new NitroRealtimeHub({
      store: store(),
      backplane: backplane(),
    });
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
    const peer = {
      id: "peer-1",
      send: vi.fn(),
      close: vi.fn(),
    };
    await response.crossws.open(peer);
    const handler = vi.fn();
    hub.registerPtyRelay("srv-1", connectedAt, "pty-1", handler);

    await response.crossws.close(peer, {});
    expect(handler).toHaveBeenCalledWith({ type: "agent_disconnected" });
  });
});
