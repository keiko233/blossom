import {
  createAgentWsFrame,
  encodeAgentWsFrame,
  parseAgentWsFrame,
  type AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Server } from "@/db/proxy-schema";

import type { AgentWsStore } from "./agent-ws-session";
import { NitroRealtimeHub } from "./realtime-hub";

const connectedAt = "2026-11-19T00:00:00.000Z";
const server = { id: "srv-1", name: "edge", enabled: true } as Server;
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
    markConnected: vi.fn(async () => ({
      connectedAt: new Date(connectedAt),
      sessionId: "v1-session",
    })),
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

afterEach(() => {
  vi.useRealTimers();
});

describe("NitroRealtimeHub live metric coalescing", () => {
  it("runs one v1 sampler per server for every viewer", async () => {
    vi.useFakeTimers();
    const hub = new NitroRealtimeHub({ store: store() });
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
      };
    };
    const sent: string[] = [];
    const peer = {
      id: "peer-1",
      send: vi.fn((data: string) => sent.push(data)),
      close: vi.fn(),
    };
    await response.crossws.open(peer);
    await response.crossws.message(peer, {
      text: () =>
        encodeAgentWsFrame(
          createAgentWsFrame("hello", {
            agentVersion: "0.4.0",
            capabilities: ["telemetry-v1"],
          }),
        ),
    });

    const first = vi.fn();
    const second = vi.fn();
    const context = {
      serverId: "srv-1",
      connectedAt,
      sessionId: null,
      protocol: "v1" as const,
    };
    const stopFirst = hub.subscribeLiveMetrics(context, first);
    const stopSecond = hub.subscribeLiveMetrics(context, second);

    await vi.advanceTimersByTimeAsync(2_000);
    const subscriptions = () =>
      sent.filter((frame) => {
        const parsed = parseAgentWsFrame(frame);
        return parsed.ok && parsed.frame.type === "telemetry.subscribe";
      });
    expect(subscriptions()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(subscriptions()).toHaveLength(2);

    stopFirst();
    stopSecond();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(subscriptions()).toHaveLength(2);
  });
});
