import { parseAgentWsFrame } from "@blossom/contracts/agent-ws";
import {
  AGENT_WS_V2_SUBPROTOCOL,
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
  parseAgentWsV2Frame,
  type AgentWsV2AgentMessageType,
  type AgentWsV2PayloadOf,
} from "@blossom/contracts/agent-ws-v2";
import { describe, expect, it, vi } from "vitest";

import type { Server } from "@/db/proxy-schema";
import type {
  AgentSessionCredential,
  AgentWsV2SessionStart,
} from "@/query/agent";

import type { AgentWsStore } from "./agent-ws-session";
import type { AgentWsV2HubStore } from "./agent-ws-store";
import type { AgentWsV2Store } from "./agent-ws-v2-session";
import { NitroRealtimeHub } from "./realtime-hub";
import type {
  RealtimeBackplane,
  RealtimeBackplaneMessage,
} from "./realtime-hub-types";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const REVISION = `7:sha256:${"a".repeat(64)}`;
const NEXT = `8:sha256:${"b".repeat(64)}`;
const CREDENTIAL: AgentSessionCredential = {
  kind: "static",
  tokenHash: "hash-1",
};

const server = {
  id: "srv-1",
  name: "edge",
  enabled: true,
  agentTokenHash: "hash-1",
  agentCapabilities: [],
  logPolicyRevision: 0,
} as unknown as Server;

type Hooks = {
  upgrade(request: Request): { protocol: string };
  open(peer: FakePeer): Promise<void>;
  message(peer: FakePeer, message: { text(): string }): Promise<void>;
  close(peer: FakePeer): Promise<void>;
};

interface FakePeer {
  id: string;
  sent: string[];
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

function makePeer(id: string): FakePeer {
  const sent: string[] = [];
  return {
    id,
    sent,
    send: (data) => {
      sent.push(data);
    },
    close: vi.fn(),
  };
}

function agentFrame<T extends AgentWsV2AgentMessageType>(
  type: T,
  payload: AgentWsV2PayloadOf<T>,
): { text(): string } {
  const text = encodeAgentWsV2Frame(
    createAgentWsV2Frame(type, payload, { ts: "2026-11-19T00:00:00.000Z" }),
  );
  return { text: () => text };
}

function sentTypes(peer: FakePeer): string[] {
  return peer.sent.map((text) => {
    const parsed = parseAgentWsV2Frame(text, "control-plane");
    if (!parsed.ok) throw new Error(`invalid frame: ${parsed.code}`);
    return parsed.message.kind;
  });
}

function fakeV2Store() {
  const store = {
    startSession: vi.fn(
      async (
        _serverId: string,
        credential: AgentWsV2SessionStart["credential"],
      ): Promise<AgentWsV2SessionStart | null> => ({
        sessionId: SESSION_ID,
        connectedAt: new Date("2026-11-19T00:00:00.000Z"),
        pending: false,
        expiresAt: null,
        credential,
      }),
    ),
    promoteSession: vi.fn(async () => server),
    loadCurrentServer: vi.fn(async () => null),
    recordHello: vi.fn(
      async () =>
        ({
          ...server,
          desiredRevisionSeq: 7,
          desiredConfigRevision: REVISION,
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
    compile: vi.fn(async () => ({
      desiredRevision: REVISION,
      document: {},
      validUntil: new Date("2099-01-01T00:00:00.000Z"),
    })),
    endSession: vi.fn(async () => undefined),
  };
  return store satisfies AgentWsV2HubStore & AgentWsV2Store;
}

function fakeV1Store(): AgentWsStore {
  return {
    markConnected: vi.fn(async () => ({
      connectedAt: new Date(),
      sessionId: "session-1",
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

function makeHub() {
  let deliver: ((message: RealtimeBackplaneMessage) => void) | undefined;
  const backplane = {
    subscribe: vi.fn(async (fn: typeof deliver) => {
      deliver = fn;
    }),
    publish: vi.fn(async () => undefined),
  } satisfies RealtimeBackplane;
  const v2Store = fakeV2Store();
  const hub = new NitroRealtimeHub({
    backplane,
    store: fakeV1Store(),
    v2Store,
  });
  return {
    hub,
    backplane,
    v2Store,
    deliverRemote: (message: RealtimeBackplaneMessage) => deliver?.(message),
  };
}

async function acceptV2(hub: NitroRealtimeHub): Promise<Hooks> {
  const response = await hub.acceptAgentV2(
    new Request("http://localhost/api/agent/ws", {
      headers: { upgrade: "websocket" },
    }),
    server,
    CREDENTIAL,
  );
  return (response as Response & { crossws: Hooks }).crossws;
}

describe("NitroRealtimeHub v2 sessions", () => {
  it("echoes the v2 subprotocol on the upgrade", async () => {
    const { hub } = makeHub();
    const hooks = await acceptV2(hub);
    expect(hooks.upgrade(new Request("http://localhost/api/agent/ws"))).toEqual(
      { protocol: AGENT_WS_V2_SUBPROTOCOL },
    );
  });

  it("closes an upgrade whose credential changed before its session started", async () => {
    const { hub, v2Store } = makeHub();
    v2Store.startSession.mockResolvedValueOnce(null);
    const hooks = await acceptV2(hub);
    const peer = makePeer("p-rotated");

    await hooks.open(peer);
    await hooks.message(
      peer,
      agentFrame("hello", {
        agentVersion: "0.4.0",
        agentBuildId: "build-1",
        capabilities: [],
        applied: null,
        certificateDeployments: [],
      }),
    );

    expect(peer.close).toHaveBeenCalledWith(1008, "credential changed");
    expect(peer.sent).toEqual([]);
    expect(v2Store.recordHello).not.toHaveBeenCalled();
  });

  it("starts a fenced session on open and welcomes it on hello", async () => {
    const { hub, v2Store } = makeHub();
    const hooks = await acceptV2(hub);
    const peer = makePeer("p1");

    await hooks.open(peer);
    expect(v2Store.startSession).toHaveBeenCalledWith("srv-1", CREDENTIAL);
    expect(peer.sent).toEqual([]);

    await hooks.message(
      peer,
      agentFrame("hello", {
        agentVersion: "0.4.0",
        agentBuildId: "build-1",
        capabilities: [],
        applied: null,
        certificateDeployments: [],
      }),
    );
    expect(sentTypes(peer)).toEqual(["welcome"]);
    expect(v2Store.recordHello).toHaveBeenCalledWith(
      "srv-1",
      SESSION_ID,
      expect.objectContaining({ agentVersion: "0.4.0" }),
    );
  });

  it("pushes config.notify only to welcomed v2 sessions and publishes it for other instances", async () => {
    const { hub, backplane } = makeHub();
    const hooks = await acceptV2(hub);
    const welcomed = makePeer("welcomed");
    const pending = makePeer("pending");
    await hooks.open(pending);
    await hooks.open(welcomed);
    await hooks.message(
      welcomed,
      agentFrame("hello", {
        agentVersion: "0.4.0",
        agentBuildId: "build-1",
        capabilities: [],
        applied: null,
        certificateDeployments: [],
      }),
    );

    await hub.notifyConfigChanged("srv-1", {
      desiredRevisionSeq: 8,
      desiredRevision: NEXT,
      reason: "node updated",
    });

    expect(sentTypes(welcomed)).toEqual(["welcome", "config.notify"]);
    expect(sentTypes(pending)).toEqual([]);
    // The cross-instance relay starts once the backplane is subscribed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backplane.publish).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", protocol: "v2" }),
    );
  });

  it("keeps v1 frames off v2 sessions", async () => {
    const { hub } = makeHub();
    const hooks = await acceptV2(hub);
    const peer = makePeer("v2");
    await hooks.open(peer);

    await hub.notifyUpdateTrigger("srv-1", { target: "agent", force: false });

    expect(peer.sent).toEqual([]);
  });

  it("pushes update and ACME operations with the v2 envelope", async () => {
    const { hub } = makeHub();
    const hooks = await acceptV2(hub);
    const peer = makePeer("p1");
    await hooks.open(peer);
    await hooks.message(
      peer,
      agentFrame("hello", {
        agentVersion: "0.4.0",
        agentBuildId: "build-1",
        capabilities: ["ws-v2", "acme-v1"],
        applied: null,
        certificateDeployments: [],
      }),
    );

    await hub.notifyUpdateTrigger("srv-1", {
      target: "agent",
      desiredAgentVersion: "latest",
      force: true,
    });
    await hub.notifyAcmeIssue("srv-1", {
      jobId: "job-1",
      certificateId: "cert-1",
      generation: 2,
      domains: ["example.com"],
      acmeProvider: "letsencrypt",
      acmeStaging: false,
      challengeType: "dns-01",
    });

    expect(sentTypes(peer).slice(-2)).toEqual(["update.trigger", "acme.issue"]);
  });

  it("relays terminal frames between a v1 browser frame and the v2 session", async () => {
    const { hub } = makeHub();
    const hooks = await acceptV2(hub);
    const peer = makePeer("p1");
    await hooks.open(peer);
    await hooks.message(
      peer,
      agentFrame("hello", {
        agentVersion: "0.4.0",
        agentBuildId: "build-1",
        capabilities: ["ws-v2", "pty-v2"],
        applied: null,
        certificateDeployments: [],
      }),
    );

    const handler = vi.fn();
    const target = {
      protocol: "v2" as const,
      connectedAt: "2026-11-19T00:00:00.000Z",
      agentSessionId: SESSION_ID,
    };
    expect(await hub.hasAgentConnection("srv-1", target)).toBe(true);
    hub.registerPtyRelay("srv-1", target, "pty-1", handler);

    expect(
      await hub.sendPtyFrame(
        "srv-1",
        target,
        "pty-1",
        JSON.stringify({
          v: 1,
          type: "pty.open",
          ts: "2026-11-19T00:00:00.000Z",
          payload: { sessionId: "pty-1", cols: 80, rows: 24 },
        }),
      ),
    ).toBe(true);
    expect(sentTypes(peer).at(-1)).toBe("pty.open");

    await hooks.message(
      peer,
      agentFrame("pty.data", { sessionId: "pty-1", data: "prompt$ " }),
    );
    expect(handler).toHaveBeenCalledWith({
      type: "frame",
      frame: expect.any(String),
    });
    const firstCall = handler.mock.calls[0] as [{ frame: string }] | undefined;
    expect(firstCall).toBeDefined();
    const forwarded = parseAgentWsFrame(firstCall![0].frame);
    expect(forwarded).toMatchObject({
      ok: true,
      message: { kind: "reserved" },
    });
  });

  it("pushes log policy only to welcomed v2 sessions", async () => {
    const { hub, backplane } = makeHub();
    const hooks = await acceptV2(hub);
    const welcomed = makePeer("welcomed");
    const pending = makePeer("pending");
    await hooks.open(welcomed);
    await hooks.open(pending);
    await hooks.message(
      welcomed,
      agentFrame("hello", {
        agentVersion: "0.4.0",
        agentBuildId: "build-1",
        capabilities: ["log-policy-v1"],
        applied: null,
        certificateDeployments: [],
      }),
    );

    await hub.notifyLogPolicy("srv-1", {
      revision: 3,
      source: "agent",
      reason: "log policy changed",
    });

    expect(sentTypes(welcomed)).toEqual(["welcome", "log.policy.notify"]);
    expect(sentTypes(pending)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backplane.publish).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", protocol: "v2" }),
    );
  });

  it("delivers a remote v2 push only to welcomed local sessions", async () => {
    const { hub, deliverRemote } = makeHub();
    const hooks = await acceptV2(hub);
    const peer = makePeer("p1");
    await hooks.open(peer);
    await hooks.message(
      peer,
      agentFrame("hello", {
        agentVersion: "0.4.0",
        agentBuildId: "build-1",
        capabilities: [],
        applied: null,
        certificateDeployments: [],
      }),
    );
    // Subscribing starts when the first session opens.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const frame = encodeAgentWsV2Frame(
      createAgentWsV2Frame(
        "config.notify",
        { desired: { desiredRevisionSeq: 8, desiredRevision: NEXT } },
        { ts: "2026-11-19T00:00:00.000Z" },
      ),
    );
    deliverRemote({
      origin: "other-instance",
      serverId: "srv-1",
      frame,
      protocol: "v2",
    });
    // Delivery waits for the session promise to resolve.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentTypes(peer)).toEqual(["welcome", "config.notify"]);
  });

  it("ends the fenced session when the socket closes", async () => {
    const { hub, v2Store } = makeHub();
    const hooks = await acceptV2(hub);
    const peer = makePeer("p1");
    await hooks.open(peer);

    await hooks.close(peer);

    expect(v2Store.endSession).toHaveBeenCalledWith("srv-1", SESSION_ID);
  });
});
