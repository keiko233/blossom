import {
  createAgentWsFrame,
  encodeAgentWsFrame,
  parseAgentWsFrame,
  type AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";
import {
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
  parseAgentWsV2Frame,
} from "@blossom/contracts/agent-ws-v2";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Server } from "@/db/proxy-schema";

import type { AgentWsStore } from "./agent-ws-session";
import { NitroRealtimeHub } from "./realtime-hub";
import type {
  RealtimeBackplane,
  RealtimeBackplaneMessage,
} from "./realtime-hub-types";

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

function fakeV2Store() {
  const store = {
    startSession: vi.fn(async (_serverId: string, credential: any) => ({
      sessionId: "22222222-2222-4222-8222-222222222222",
      connectedAt: new Date(connectedAt),
      pending: false,
      expiresAt: null,
      credential,
    })),
    promoteSession: vi.fn(async () => server),
    loadCurrentServer: vi.fn(async () => null),
    recordHello: vi.fn(
      async () =>
        ({
          ...server,
          desiredRevisionSeq: 1,
          desiredConfigRevision: "1:sha256:rev",
          heartbeatIntervalSeconds: 30,
          desiredAgentVersion: null,
          desiredSingBoxVersion: null,
          agentCapabilities: [],
          logPolicyRevision: 0,
        }) as unknown as Server,
    ),
    recordStatus: vi.fn(async () => null),
    recordConfigAck: vi.fn(async () => "applied" as const),
    recordUpdateStatus: vi.fn(async () => true),
    cacheDesiredRevision: vi.fn(async () => undefined),
    applyCertificateDeployments: vi.fn(async () => undefined),
    revalidateSession: vi.fn(async () => "ok" as const),
    applyTraffic: vi.fn(async () => ({
      status: "applied" as const,
      accepted: 0,
      dropped: 0,
    })),
    handleAcmeDnsPresent: vi.fn(async () => true),
    handleAcmeDnsCleanup: vi.fn(async () => true),
    handleAcmeResult: vi.fn(async () => true),
    loadLogPolicy: vi.fn(async () => ({
      revision: 0,
      sources: [
        {
          source: "agent" as const,
          revision: 0,
          baseline: "default" as const,
          level: "default" as const,
          deadline: null,
        },
        {
          source: "sing-box" as const,
          revision: 0,
          baseline: "default" as const,
          level: "default" as const,
          deadline: null,
        },
      ],
    })),
    recordLogPolicyAck: vi.fn(async () => "recorded" as const),
    recordMetricHistory: vi.fn(async () => "written" as const),
    compile: vi.fn(async () => ({
      desiredRevision: "1:sha256:rev",
      document: {},
      validUntil: new Date("2099-01-01T00:00:00.000Z"),
    })),
    endSession: vi.fn(async () => undefined),
  };
  return store as any;
}

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

  it("relays v2 live metrics cross-instance and avoids unsubscribe collision", async () => {
    const deliverers = new Set<(message: RealtimeBackplaneMessage) => void>();
    const backplane: RealtimeBackplane = {
      subscribe: async (deliver) => {
        deliverers.add(deliver);
      },
      publish: async (message) => {
        for (const deliver of deliverers) deliver(message);
      },
    };

    const hubA = new NitroRealtimeHub({
      store: store(),
      v2Store: fakeV2Store(),
      backplane,
    });
    const hubB = new NitroRealtimeHub({
      store: store(),
      v2Store: fakeV2Store(),
      backplane,
    });

    const response = (await hubA.acceptAgentV2(
      new Request("http://localhost/api/agent/ws", {
        headers: { upgrade: "websocket" },
      }),
      server,
      { kind: "static", tokenHash: "hash-1" },
    )) as Response & {
      crossws: {
        open(peer: unknown): Promise<void>;
        message(peer: unknown, message: { text(): string }): Promise<void>;
      };
    };

    const sentToAgent: string[] = [];
    const peer = {
      id: "agent-peer",
      send: vi.fn((data: string) => sentToAgent.push(data)),
      close: vi.fn(),
    };
    await response.crossws.open(peer);
    await response.crossws.message(peer, {
      text: () =>
        encodeAgentWsV2Frame(
          createAgentWsV2Frame("hello", {
            agentVersion: "0.4.0",
            agentBuildId: "build-1",
            capabilities: ["telemetry-v1"],
            applied: null,
            certificateDeployments: [],
          }),
        ),
    });

    // Viewer connects to hubB (which has NO local agent socket)
    const viewerSamples: unknown[] = [];
    const stopViewerB = hubB.subscribeLiveMetrics(
      {
        serverId: "srv-1",
        connectedAt,
        sessionId: "22222222-2222-4222-8222-222222222222",
        protocol: "v2",
      },
      (sample) => {
        viewerSamples.push(sample);
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Agent on hubA sends a sample
    await response.crossws.message(peer, {
      text: () =>
        encodeAgentWsV2Frame(
          createAgentWsV2Frame("telemetry.sample", {
            subscriptionId: `live-${hubB["id"]}-22222222-2222-4222-8222-222222222222`,
            purpose: "live",
            sampledAt: "2026-11-19T00:00:01.000Z",
            cpuPercent: 12.5,
            memory: { used: 1000, total: 2000 },
            disk: { used: 5000, total: 10000 },
            environment: "systemd",
            networkScope: "agent",
            cgroupVersion: null,
            cpuLimit: null,
            memoryLimit: null,
            scopeKey: "global",
            network: {
              rxBytesPerSecond: 1000,
              txBytesPerSecond: 2000,
              windowMs: 1000,
            },
          }),
        ),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(viewerSamples).toHaveLength(1);
    expect(viewerSamples[0]).toMatchObject({
      cpuPercent: 12.5,
      networkRxBytesPerSecond: 1000,
      networkTxBytesPerSecond: 2000,
    });

    // Viewer unsubscribes on hubB
    stopViewerB();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Verify the unsubscription includes hubB's id in subscriptionId
    const unsubscribeFrame = sentToAgent.find((f) => {
      const parsed = parseAgentWsV2Frame(f, "control-plane");
      return parsed.ok && parsed.message.kind === "telemetry.unsubscribe";
    });
    expect(unsubscribeFrame).toBeDefined();
    const parsed = parseAgentWsV2Frame(unsubscribeFrame!, "control-plane");
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.kind === "telemetry.unsubscribe") {
      expect(parsed.message.payload.subscriptionId).toBe(
        `live-${hubB["id"]}-22222222-2222-4222-8222-222222222222`,
      );
    }
  });
});
