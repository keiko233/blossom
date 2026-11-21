import {
  AGENT_WS_V2_LIMITS,
  AGENT_WS_V2_TELEMETRY_HISTORY_CAPABILITY,
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
  parseAgentWsV2Frame,
  type AgentWsV2ConfigAckPayload,
  type AgentWsV2HelloPayload,
  type AgentWsV2MessageType,
  type AgentWsV2PayloadOf,
  type AgentWsV2StatusPayload,
  type AgentWsV2TelemetrySamplePayload,
  type AgentWsV2TrafficReportPayload,
} from "@blossom/contracts/agent-ws-v2";
import type { LogPolicyAckPayload } from "@blossom/contracts/log-policy";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { Server } from "@/db/proxy-schema";
import { ManagedCompileError } from "@/orpc/proxy/managed-singbox";

import {
  encodeAgentWsV2ConfigNotify,
  openAgentWsV2Session,
  type AgentWsV2Peer,
  type AgentWsV2PtyFrame,
  type AgentWsV2Store,
  type OpenAgentWsV2SessionOptions,
} from "./agent-ws-v2-session";

const SERVER_ID = "srv-1";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const REVISION = `7:sha256:${"a".repeat(64)}`;
const NEXT_REVISION = `8:sha256:${"b".repeat(64)}`;
const SAME_SEQ_REVISION = `7:sha256:${"c".repeat(64)}`;
const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");
const PAST = new Date("2000-01-01T00:00:00.000Z");

const CURRENT_HELLO: AgentWsV2HelloPayload = {
  agentVersion: "0.4.0",
  agentBuildId: "build-1",
  capabilities: ["config-v3"],
  applied: null,
  certificateDeployments: [],
};

function server(overrides: Partial<Server> = {}): Server {
  return {
    id: SERVER_ID,
    name: "edge-1",
    enabled: true,
    desiredRevisionSeq: 7,
    desiredConfigRevision: REVISION,
    desiredInputsVersion: 0,
    desiredConfigValidUntil: FAR_FUTURE,
    heartbeatIntervalSeconds: 30,
    configPollIntervalSeconds: 60,
    desiredAgentVersion: null,
    desiredSingBoxVersion: "1.13.0",
    agentCapabilities: [],
    logPolicyRevision: 0,
    ...overrides,
  } as Server;
}

function makeStore(overrides: Partial<AgentWsV2Store> = {}) {
  const store = {
    loadCurrentServer: vi.fn(async () => server()),
    recordHello: vi.fn(async () => server()),
    promoteSession: vi.fn(async () => server()),
    recordStatus: vi.fn(async () => server()),
    recordConfigAck: vi.fn(async () => "applied" as const),
    recordUpdateStatus: vi.fn(async () => true),
    cacheDesiredRevision: vi.fn(async () => undefined),
    applyCertificateDeployments: vi.fn(async () => undefined),
    revalidateSession: vi.fn(async () => "ok" as const),
    applyTraffic: vi.fn(async () => ({
      status: "applied" as const,
      accepted: 1,
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
      desiredRevision: REVISION,
      document: { apiVersion: 3, desiredRevision: REVISION },
      validUntil: FAR_FUTURE,
    })),
    endSession: vi.fn(async () => undefined),
    ...overrides,
  };
  return store satisfies AgentWsV2Store & Record<string, unknown>;
}

function makePeer() {
  const sent: string[] = [];
  const peer = {
    sent,
    send: vi.fn((data: string) => {
      sent.push(data);
    }),
    close: vi.fn(),
  } satisfies AgentWsV2Peer & { sent: string[] };
  return peer;
}

/** Every frame the control plane sends must itself be valid v2 output. */
function received(peer: { sent: string[] }) {
  return peer.sent.map((text) => {
    const parsed = parseAgentWsV2Frame(text, "control-plane");
    if (!parsed.ok) throw new Error(`invalid outgoing frame: ${parsed.code}`);
    return parsed.message;
  });
}

function agentFrame<T extends AgentWsV2MessageType>(
  type: T,
  payload: AgentWsV2PayloadOf<T>,
  id?: string,
): string {
  return encodeAgentWsV2Frame(
    createAgentWsV2Frame(type, payload, {
      ...(id ? { id } : {}),
      ts: "2026-11-19T00:00:00.000Z",
    }),
  );
}

function open(
  store: AgentWsV2Store,
  peer: AgentWsV2Peer,
  sessionId = SESSION_ID,
) {
  return openAgentWsV2Session({
    serverId: SERVER_ID,
    sessionId,
    credential: { kind: "static", tokenHash: "hash-1" },
    peer,
    store,
  });
}

describe("agent WebSocket v2 session handshake", () => {
  it("welcomes the agent with the cached identifier and does not compile", async () => {
    const store = makeStore();
    const peer = makePeer();
    const session = open(store, peer);

    await session.handleText(agentFrame("hello", CURRENT_HELLO, "hello-1"));

    expect(store.recordHello).toHaveBeenCalledWith(
      SERVER_ID,
      SESSION_ID,
      CURRENT_HELLO,
    );
    expect(store.compile).not.toHaveBeenCalled();
    expect(session.welcomed).toBe(true);
    expect(received(peer)).toEqual([
      {
        kind: "welcome",
        payload: expect.objectContaining({
          sessionId: SESSION_ID,
          serverId: SERVER_ID,
          serverName: "edge-1",
          desired: { desiredRevisionSeq: 7, desiredRevision: REVISION },
          updatePolicy: {
            desiredAgentVersion: null,
            desiredSingBoxVersion: "1.13.0",
          },
          statusIntervalSeconds: 30,
          limits: {
            maxFrameBytes: AGENT_WS_V2_LIMITS.maxFrameBytes,
            snapshotChunkBytes: AGENT_WS_V2_LIMITS.snapshotChunkBytes,
            maxSnapshotBytes: AGENT_WS_V2_LIMITS.maxSnapshotBytes,
          },
        }),
      },
    ]);
    expect(JSON.parse(peer.sent[0]!).id).toBe("hello-1");
  });

  it("promotes a pending identity on hello before recording it", async () => {
    const store = makeStore();
    const peer = makePeer();
    const credential = {
      kind: "oauth" as const,
      identityId: "identity-1",
      generation: 2,
      clientId: "agent_test",
      expiresAt: Math.floor(Date.now() / 1000) + 900,
      identityStatus: "pending" as const,
    };
    const session = openAgentWsV2Session({
      serverId: SERVER_ID,
      sessionId: SESSION_ID,
      credential,
      pending: true,
      peer,
      store,
    });

    await session.handleText(agentFrame("hello", CURRENT_HELLO));

    expect(store.promoteSession).toHaveBeenCalledWith(
      SERVER_ID,
      SESSION_ID,
      credential,
    );
    expect(store.recordHello).toHaveBeenCalled();
    expect(session.pending).toBe(false);
    expect(received(peer)[0]).toMatchObject({ kind: "welcome" });
  });

  it("stops an idle lease whose credential is no longer current", async () => {
    const store = makeStore({
      revalidateSession: vi.fn(async () => "replaced" as const),
    });
    const peer = makePeer();
    const session = open(store, peer);

    await session.revalidate();

    expect(peer.close).toHaveBeenCalledWith(4000, "session_replaced");
    expect(received(peer).at(-1)).toMatchObject({ kind: "error" });
  });

  it("compiles and caches the identifier when the cache is empty", async () => {
    const store = makeStore({
      recordHello: vi.fn(async () => server({ desiredConfigRevision: null })),
    });
    const peer = makePeer();
    await open(store, peer).handleText(agentFrame("hello", CURRENT_HELLO));

    expect(store.compile).toHaveBeenCalledTimes(1);
    expect(store.cacheDesiredRevision).toHaveBeenCalledWith(
      SERVER_ID,
      SESSION_ID,
      {
        desiredRevisionSeq: 7,
        desiredInputsVersion: 0,
        desiredRevision: REVISION,
        validUntil: FAR_FUTURE,
      },
    );
    expect(received(peer)[0]).toMatchObject({
      kind: "welcome",
      payload: { desired: { desiredRevision: REVISION } },
    });
  });

  it("advertises the log-policy revision only to a capable agent", async () => {
    const store = makeStore({
      recordHello: vi.fn(async () =>
        server({
          agentCapabilities: ["log-policy-v1"],
          logPolicyRevision: 3,
        }),
      ),
    });
    const peer = makePeer();
    await open(store, peer).handleText(
      agentFrame("hello", {
        ...CURRENT_HELLO,
        capabilities: ["log-policy-v1"],
      }),
    );
    expect(received(peer)[0]).toMatchObject({
      kind: "welcome",
      payload: { logPolicyRevision: 3 },
    });

    const legacy = makeStore();
    const legacyPeer = makePeer();
    await open(legacy, legacyPeer).handleText(
      agentFrame("hello", CURRENT_HELLO),
    );
    const legacyWelcome = received(legacyPeer)[0];
    expect(legacyWelcome?.kind).toBe("welcome");
    if (legacyWelcome?.kind === "welcome") {
      expect(legacyWelcome.payload).not.toHaveProperty("logPolicyRevision");
    }
  });

  it("ignores a stale cache whose sequence no longer matches", async () => {
    const store = makeStore({
      recordHello: vi.fn(async () =>
        server({
          desiredRevisionSeq: 8,
          desiredConfigRevision: REVISION,
        }),
      ),
    });
    const peer = makePeer();
    await open(store, peer).handleText(agentFrame("hello", CURRENT_HELLO));

    expect(store.compile).toHaveBeenCalledTimes(1);
  });

  it("stops a replaced session without welcoming it", async () => {
    const store = makeStore({ recordHello: vi.fn(async () => null) });
    const peer = makePeer();
    const session = open(store, peer);
    await session.handleText(agentFrame("hello", CURRENT_HELLO));

    expect(session.welcomed).toBe(false);
    expect(received(peer)).toEqual([
      {
        kind: "error",
        payload: expect.objectContaining({ code: "session_replaced" }),
      },
    ]);
    expect(peer.close).toHaveBeenCalledWith(4000, "session_replaced");
  });

  it("refuses a disabled server", async () => {
    const store = makeStore({
      recordHello: vi.fn(async () => server({ enabled: false })),
    });
    const peer = makePeer();
    await open(store, peer).handleText(agentFrame("hello", CURRENT_HELLO));

    expect(received(peer)).toEqual([
      {
        kind: "error",
        payload: expect.objectContaining({ code: "server_disabled" }),
      },
    ]);
    expect(peer.close).toHaveBeenCalledWith(4000, "server_disabled");
  });

  it("requires hello first and rejects a second hello", async () => {
    const store = makeStore();
    const peer = makePeer();
    const session = open(store, peer);

    await session.handleText(
      agentFrame("config.get", { requestId: "snap-1", reason: "initial" }),
    );
    expect(store.loadCurrentServer).not.toHaveBeenCalled();
    expect(received(peer)[0]).toMatchObject({
      kind: "error",
      payload: { code: "invalid_payload" },
    });

    await session.handleText(agentFrame("hello", CURRENT_HELLO));
    await session.handleText(agentFrame("hello", CURRENT_HELLO));
    expect(store.recordHello).toHaveBeenCalledTimes(1);
  });
});

describe("agent WebSocket v2 log policy", () => {
  it("answers a snapshot request from the fenced store", async () => {
    const store = makeStore({
      recordHello: vi.fn(async () =>
        server({ agentCapabilities: ["log-policy-v1"], logPolicyRevision: 3 }),
      ),
      loadLogPolicy: vi.fn(async () => ({
        revision: 3,
        sources: [
          {
            source: "agent" as const,
            revision: 2,
            baseline: "warn" as const,
            level: "warn" as const,
            deadline: null,
          },
          {
            source: "sing-box" as const,
            revision: 3,
            baseline: "info" as const,
            level: "debug" as const,
            deadline: "2026-11-19T00:15:00.000Z",
          },
        ],
      })),
    });
    const peer = makePeer();
    const session = open(store, peer);
    await session.handleText(
      agentFrame("hello", {
        ...CURRENT_HELLO,
        capabilities: ["log-policy-v1"],
      }),
    );
    await session.handleText(
      agentFrame("log.policy.get", { requestId: "log-get-1" }, "log-get-1"),
    );

    expect(store.loadLogPolicy).toHaveBeenCalledWith(SERVER_ID, SESSION_ID);
    expect(received(peer).at(-1)).toEqual({
      kind: "log.policy.snapshot",
      payload: {
        requestId: "log-get-1",
        revision: 3,
        sources: [
          {
            source: "agent",
            revision: 2,
            baseline: "warn",
            level: "warn",
            deadline: null,
          },
          {
            source: "sing-box",
            revision: 3,
            baseline: "info",
            level: "debug",
            deadline: "2026-11-19T00:15:00.000Z",
          },
        ],
      },
    });
  });

  it("records an acknowledgement and stops a replaced session", async () => {
    const ack: LogPolicyAckPayload = {
      source: "agent",
      sourceRevision: 2,
      requested: "warn",
      baseline: "info",
      effective: "warn",
      deadline: null,
      error: null,
      pending: false,
    };
    const store = makeStore({
      recordLogPolicyAck: vi.fn(async () => "recorded" as const),
    });
    const peer = makePeer();
    const session = open(store, peer);
    await session.handleText(agentFrame("hello", CURRENT_HELLO));
    await session.handleText(agentFrame("log.policy.ack", ack));
    expect(store.recordLogPolicyAck).toHaveBeenCalledWith(
      SERVER_ID,
      SESSION_ID,
      ack,
    );

    const replaced = makeStore({
      recordLogPolicyAck: vi.fn(async () => "replaced" as const),
    });
    const replacedPeer = makePeer();
    const replacedSession = open(replaced, replacedPeer);
    await replacedSession.handleText(agentFrame("hello", CURRENT_HELLO));
    await replacedSession.handleText(agentFrame("log.policy.ack", ack));
    expect(received(replacedPeer).at(-1)).toMatchObject({
      kind: "error",
      payload: { code: "session_replaced" },
    });
    expect(replacedPeer.close).toHaveBeenCalledWith(4000, "session_replaced");
  });
});

describe("agent WebSocket v2 identifier freshness", () => {
  it("recompiles once the cached identifier's deadline has passed", async () => {
    const store = makeStore({
      recordHello: vi.fn(async () => server({ desiredConfigValidUntil: PAST })),
    });
    const peer = makePeer();
    await open(store, peer).handleText(agentFrame("hello", CURRENT_HELLO));

    expect(store.compile).toHaveBeenCalledTimes(1);
    expect(store.cacheDesiredRevision).toHaveBeenCalledWith(
      SERVER_ID,
      SESSION_ID,
      expect.objectContaining({ desiredRevision: REVISION }),
    );
  });

  it("answers a status with the recompiled identifier once the cache has aged out", async () => {
    // A compiled input changed without moving the sequence and without a
    // notification. The status acknowledgement reports the new identifier once
    // the cached one is out of date.
    const store = makeStore({
      recordStatus: vi.fn(async () =>
        server({ desiredConfigValidUntil: PAST }),
      ),
      compile: vi.fn(async () => ({
        desiredRevision: SAME_SEQ_REVISION,
        document: { apiVersion: 3 },
        validUntil: FAR_FUTURE,
      })),
    });
    const peer = makePeer();
    const session = await welcomed(store, peer);
    await session.handleText(agentFrame("agent.status", STATUS, "status-1"));

    expect(received(peer).at(-1)).toMatchObject({
      kind: "agent.status.ack",
      payload: {
        desired: { desiredRevisionSeq: 7, desiredRevision: SAME_SEQ_REVISION },
      },
    });
  });

  it("keeps answering from the cache inside the deadline without compiling", async () => {
    const store = makeStore();
    const peer = makePeer();
    const session = await welcomed(store, peer);
    await session.handleText(agentFrame("agent.status", STATUS, "status-1"));

    expect(store.compile).not.toHaveBeenCalled();
    expect(received(peer).at(-1)).toMatchObject({
      kind: "agent.status.ack",
      payload: { desired: { desiredRevision: REVISION } },
    });
  });

  it("does not stop the session when the identifier cache write is refused", async () => {
    const store = makeStore({
      recordHello: vi.fn(async () => server({ desiredConfigRevision: null })),
      cacheDesiredRevision: vi.fn(async () => {
        throw new Error("write refused");
      }),
    });
    const peer = makePeer();
    await open(store, peer).handleText(agentFrame("hello", CURRENT_HELLO));

    expect(received(peer)[0]).toMatchObject({
      kind: "welcome",
      payload: { desired: { desiredRevision: REVISION } },
    });
    expect(peer.close).not.toHaveBeenCalled();
  });
});

describe("agent WebSocket v2 current-session reads", () => {
  it("sends no snapshot to a session that is replaced during the compile", async () => {
    let currentChecks = 0;
    const store = makeStore({
      loadCurrentServer: vi.fn(async () => {
        currentChecks += 1;
        // Current when the request starts, replaced before the snapshot goes.
        return currentChecks === 1 ? server() : null;
      }),
    });
    const peer = makePeer();
    const session = await welcomed(store, peer);
    await session.handleText(
      agentFrame("config.get", { requestId: "snap-r", reason: "mismatch" }),
    );

    expect(received(peer).slice(1)).toEqual([
      {
        kind: "error",
        payload: expect.objectContaining({ code: "session_replaced" }),
      },
    ]);
    expect(peer.close).toHaveBeenCalledWith(4000, "session_replaced");
    expect(store.cacheDesiredRevision).not.toHaveBeenCalled();
  });

  it("compiles nothing and sends nothing for a session whose credential was rotated", async () => {
    const store = makeStore();
    const peer = makePeer();
    const session = await welcomed(store, peer);
    (store.loadCurrentServer as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
    await session.handleText(
      agentFrame("config.get", { requestId: "snap-x", reason: "initial" }),
    );

    expect(store.compile).not.toHaveBeenCalled();
    expect(received(peer).slice(1)).toEqual([
      {
        kind: "error",
        payload: expect.objectContaining({ code: "session_replaced" }),
      },
    ]);
    expect(peer.close).toHaveBeenCalledWith(4000, "session_replaced");
  });

  it("stops a disabled server before compiling a snapshot", async () => {
    const store = makeStore({
      loadCurrentServer: vi.fn(async () => server({ enabled: false })),
    });
    const peer = makePeer();
    const session = await welcomed(store, peer);
    await session.handleText(
      agentFrame("config.get", { requestId: "snap-d", reason: "notify" }),
    );

    expect(store.compile).not.toHaveBeenCalled();
    expect(received(peer).slice(1)).toEqual([
      {
        kind: "error",
        payload: expect.objectContaining({ code: "server_disabled" }),
      },
    ]);
    expect(peer.close).toHaveBeenCalledWith(4000, "server_disabled");
  });
});

describe("agent WebSocket v2 frame validation", () => {
  it("rejects control-plane frames from the agent without touching state", async () => {
    const store = makeStore();
    const peer = makePeer();
    await open(store, peer).handleText(
      encodeAgentWsV2Frame(
        createAgentWsV2Frame("welcome", {} as never, {
          ts: "2026-11-19T00:00:00.000Z",
        }),
      ),
    );

    expect(received(peer)).toEqual([
      {
        kind: "error",
        payload: expect.objectContaining({ code: "invalid_direction" }),
      },
    ]);
    expect(store.recordHello).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload with a protocol error", async () => {
    const store = makeStore();
    const peer = makePeer();
    await open(store, peer).handleText(
      JSON.stringify({
        v: 2,
        type: "hello",
        ts: "2026-11-19T00:00:00.000Z",
        payload: { agentVersion: "0.4.0" },
      }),
    );

    expect(received(peer)[0]).toMatchObject({
      kind: "error",
      payload: { code: "invalid_payload", type: "hello" },
    });
    expect(store.recordHello).not.toHaveBeenCalled();
  });

  it("reports an oversized frame and keeps the session open", async () => {
    const store = makeStore();
    const peer = makePeer();
    const session = open(store, peer);
    await session.handleText("x".repeat(AGENT_WS_V2_LIMITS.maxFrameBytes + 1));

    expect(received(peer)[0]).toMatchObject({
      kind: "error",
      payload: { code: "frame_too_large" },
    });
    expect(peer.close).not.toHaveBeenCalled();
  });

  it("ignores frames of an unknown type", async () => {
    const store = makeStore();
    const peer = makePeer();
    await open(store, peer).handleText(
      JSON.stringify({
        v: 2,
        type: "future.thing",
        ts: "2026-11-19T00:00:00.000Z",
        payload: {},
      }),
    );

    expect(peer.sent).toEqual([]);
  });
});

const METRIC_SAMPLE: AgentWsV2TelemetrySamplePayload = {
  subscriptionId: "history-session",
  purpose: "history",
  sampledAt: "2026-11-19T00:01:00.000Z",
  cpuPercent: 24.5,
  memory: { used: 512, total: 1024 },
  disk: { used: 100, total: 1000 },
  environment: "systemd",
  networkScope: "agent",
  cgroupVersion: null,
  cpuLimit: null,
  memoryLimit: null,
  scopeKey: "systemd|-|-|-|eth0",
  network: {
    txBytesPerSecond: 1024,
    rxBytesPerSecond: 2048,
    windowMs: 2000,
  },
};

describe("agent WebSocket v2 telemetry", () => {
  it("requests the independent history subscription after welcome", async () => {
    const store = makeStore();
    const peer = makePeer();
    const session = open(store, peer);
    await session.handleText(
      agentFrame("hello", {
        ...CURRENT_HELLO,
        capabilities: ["config-v3", AGENT_WS_V2_TELEMETRY_HISTORY_CAPABILITY],
      }),
    );

    expect(received(peer).map((message) => message.kind)).toEqual([
      "welcome",
      "telemetry.subscribe",
    ]);
    expect(received(peer).at(-1)).toMatchObject({
      kind: "telemetry.subscribe",
      payload: {
        purpose: "history",
        intervalMs: 60_000,
        subscriptionId: `history-${SESSION_ID}`,
      },
    });
  });

  it("records only history samples through the exact session fence", async () => {
    const onSample = vi.fn();
    const store = makeStore();
    const peer = makePeer();
    const session = openAgentWsV2Session({
      serverId: SERVER_ID,
      sessionId: SESSION_ID,
      credential: { kind: "static", tokenHash: "hash-1" },
      peer,
      store,
      onSample,
    });
    await session.handleText(agentFrame("hello", CURRENT_HELLO));

    await session.handleText(agentFrame("telemetry.sample", METRIC_SAMPLE));
    await session.handleText(
      agentFrame("telemetry.sample", {
        ...METRIC_SAMPLE,
        purpose: "live",
        subscriptionId: "live-session",
      }),
    );

    expect(onSample).toHaveBeenCalledTimes(2);
    expect(store.recordMetricHistory).toHaveBeenCalledTimes(1);
    expect(store.recordMetricHistory).toHaveBeenCalledWith(
      SERVER_ID,
      SESSION_ID,
      METRIC_SAMPLE,
    );
  });
});

const STATUS: AgentWsV2StatusPayload = {
  reason: "interval",
  runtimeState: "running",
  certificateDeployments: [],
};

async function welcomed(
  store: AgentWsV2Store,
  peer: AgentWsV2Peer,
  options: {
    onPtyFrame?: (frame: AgentWsV2PtyFrame) => boolean | Promise<boolean>;
  } = {},
) {
  const session = openAgentWsV2Session({
    serverId: SERVER_ID,
    sessionId: SESSION_ID,
    credential: { kind: "static", tokenHash: "hash-1" },
    peer,
    store,
    ...options,
  });
  await session.handleText(agentFrame("hello", CURRENT_HELLO));
  return session;
}

describe("agent WebSocket v2 status and configuration", () => {
  it("answers status with authoritative identifiers and the update policy", async () => {
    const store = makeStore({
      recordStatus: vi.fn(async () =>
        server({
          desiredRevisionSeq: 8,
          desiredConfigRevision: NEXT_REVISION,
          desiredAgentVersion: "0.4.1",
        }),
      ),
    });
    const peer = makePeer();
    const session = await welcomed(store, peer);
    const status: AgentWsV2StatusPayload = {
      reason: "interval",
      runtimeState: "running",
      certificateDeployments: [],
    };

    await session.handleText(agentFrame("agent.status", status, "status-1"));

    expect(store.recordStatus).toHaveBeenCalledWith(
      SERVER_ID,
      SESSION_ID,
      expect.objectContaining({ runtimeState: "running" }),
    );
    expect(received(peer).at(-1)).toEqual({
      kind: "agent.status.ack",
      payload: {
        desired: { desiredRevisionSeq: 8, desiredRevision: NEXT_REVISION },
        updatePolicy: {
          desiredAgentVersion: "0.4.1",
          desiredSingBoxVersion: "1.13.0",
        },
      },
    });
    expect(JSON.parse(peer.sent.at(-1)!).id).toBe("status-1");
  });

  it("stops a session whose status write is fenced out", async () => {
    const store = makeStore({ recordStatus: vi.fn(async () => null) });
    const peer = makePeer();
    const session = await welcomed(store, peer);

    await session.handleText(
      agentFrame("agent.status", {
        reason: "interval",
        certificateDeployments: [],
      }),
    );

    expect(peer.close).toHaveBeenCalledWith(4000, "session_replaced");
    expect(received(peer).at(-1)).toMatchObject({
      kind: "error",
      payload: { code: "session_replaced" },
    });
  });

  it("serves a snapshot in ordered chunks that verify against the digest", async () => {
    const body = {
      apiVersion: 3,
      desiredRevision: REVISION,
      pad: "x".repeat(200_000),
    };
    const expected = JSON.stringify(body);
    const store = makeStore({
      compile: vi.fn(async () => ({
        desiredRevision: REVISION,
        document: body,
        validUntil: FAR_FUTURE,
      })),
    });
    const peer = makePeer();
    const session = await welcomed(store, peer);

    await session.handleText(
      agentFrame("config.get", { requestId: "snap-1", reason: "initial" }),
    );

    const messages = received(peer).slice(1);
    const begin = messages[0]!;
    expect(begin.kind).toBe("config.snapshot.begin");
    if (begin.kind !== "config.snapshot.begin") throw new Error("unreachable");
    const chunks = messages.filter(
      (message) => message.kind === "config.snapshot.chunk",
    );
    expect(chunks).toHaveLength(begin.payload.chunkCount);
    expect(begin.payload).toMatchObject({
      requestId: "snap-1",
      desired: { desiredRevisionSeq: 7, desiredRevision: REVISION },
      totalBytes: Buffer.byteLength(expected),
      digest: createHash("sha256").update(expected).digest("hex"),
    });

    const assembled = Buffer.concat(
      chunks.map((message) => {
        if (message.kind !== "config.snapshot.chunk")
          throw new Error("unreachable");
        expect(message.payload.requestId).toBe("snap-1");
        return Buffer.from(message.payload.data, "base64");
      }),
    );
    expect(assembled.toString("utf8")).toBe(expected);
    expect(messages.at(-1)).toEqual({
      kind: "config.snapshot.end",
      payload: { requestId: "snap-1" },
    });
    expect(store.cacheDesiredRevision).toHaveBeenCalledWith(
      SERVER_ID,
      SESSION_ID,
      {
        desiredRevisionSeq: 7,
        desiredInputsVersion: 0,
        desiredRevision: REVISION,
        validUntil: FAR_FUTURE,
      },
    );
  });

  it("refuses an oversized compiled configuration explicitly", async () => {
    const store = makeStore({
      compile: vi.fn(async () => ({
        desiredRevision: REVISION,
        document: { pad: "x".repeat(AGENT_WS_V2_LIMITS.maxSnapshotBytes) },
        validUntil: FAR_FUTURE,
      })),
    });
    const peer = makePeer();
    const session = await welcomed(store, peer);

    await session.handleText(
      agentFrame("config.get", { requestId: "snap-2", reason: "mismatch" }),
    );

    expect(received(peer).slice(1)).toEqual([
      {
        kind: "config.snapshot.error",
        payload: expect.objectContaining({
          requestId: "snap-2",
          code: "snapshot_too_large",
        }),
      },
    ]);
    expect(store.cacheDesiredRevision).not.toHaveBeenCalled();
  });

  it("fails closed when a managed server's agent did not negotiate the capability", async () => {
    const fallback = `7:sha256:${"f".repeat(64)}`;
    const store = makeStore({
      loadCurrentServer: vi.fn(async () =>
        server({ desiredConfigRevision: null, desiredConfigValidUntil: null }),
      ),
      recordHello: vi.fn(async () =>
        server({ desiredConfigRevision: null, desiredConfigValidUntil: null }),
      ),
      compile: vi.fn(async () => {
        throw new ManagedCompileError(
          "unsupported_agent",
          "the connected agent did not advertise the managed capability",
          fallback,
          7,
        );
      }),
    });
    const peer = makePeer();
    const session = await welcomed(store, peer);

    const welcome = received(peer)[0];
    expect(welcome).toMatchObject({
      kind: "welcome",
      payload: {
        desired: {
          desiredRevisionSeq: 7,
          desiredRevision: fallback,
        },
      },
    });

    await session.handleText(
      agentFrame("config.get", {
        requestId: "snap-managed",
        reason: "mismatch",
      }),
    );

    expect(received(peer).slice(1)).toEqual([
      {
        kind: "config.snapshot.error",
        payload: expect.objectContaining({
          requestId: "snap-managed",
          code: "unavailable",
          message: expect.stringContaining("managed capability"),
        }),
      },
    ]);
    expect(store.compile).toHaveBeenCalledWith(expect.anything(), {
      agentCapabilities: ["config-v3"],
    });
    expect(store.cacheDesiredRevision).not.toHaveBeenCalled();
  });

  it("drops an older snapshot that a newer request has superseded", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const store = makeStore({
      compile: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          await firstGate;
          return {
            desiredRevision: REVISION,
            document: { n: 1 },
            validUntil: FAR_FUTURE,
          };
        }
        return {
          desiredRevision: SAME_SEQ_REVISION,
          document: { n: 2 },
          validUntil: FAR_FUTURE,
        };
      }),
    });
    const peer = makePeer();
    const session = await welcomed(store, peer);

    const first = session.handleText(
      agentFrame("config.get", { requestId: "old", reason: "notify" }),
    );
    await session.handleText(
      agentFrame("config.get", { requestId: "new", reason: "mismatch" }),
    );
    releaseFirst();
    await first;

    const requestIds = received(peer)
      .slice(1)
      .flatMap((message) =>
        message.kind === "unknown" || !("requestId" in message.payload)
          ? []
          : [message.payload.requestId],
      );
    expect(new Set(requestIds)).toEqual(new Set(["new"]));
  });
});

describe("agent WebSocket v2 acknowledgements and traffic", () => {
  const ack: AgentWsV2ConfigAckPayload = {
    requestId: "snap-1",
    desired: { desiredRevisionSeq: 7, desiredRevision: REVISION },
    outcome: "applied",
  };

  it("records a configuration acknowledgement fenced by the session", async () => {
    const store = makeStore();
    const peer = makePeer();
    const session = await welcomed(store, peer);

    await session.handleText(agentFrame("config.ack", ack));

    expect(store.recordConfigAck).toHaveBeenCalledWith(
      SERVER_ID,
      SESSION_ID,
      ack,
    );
    expect(peer.sent).toHaveLength(1);
  });

  it("stops a session whose acknowledgement arrives after replacement", async () => {
    const store = makeStore({
      recordConfigAck: vi.fn(async () => "replaced" as const),
    });
    const peer = makePeer();
    const session = await welcomed(store, peer);

    await session.handleText(agentFrame("config.ack", ack));

    expect(peer.close).toHaveBeenCalledWith(4000, "session_replaced");
  });

  const report: AgentWsV2TrafficReportPayload = {
    reportId: "report-0001",
    entries: [{ subscriptionId: "sub-1", uplinkBytes: 1, downlinkBytes: 2 }],
  };

  it.each([
    ["applied", "applied"],
    ["duplicate", "duplicate"],
  ] as const)(
    "acknowledges a %s report with its counts",
    async (status, result) => {
      const store = makeStore({
        applyTraffic: vi.fn(async () => ({ status, accepted: 1, dropped: 0 })),
      });
      const peer = makePeer();
      const session = await welcomed(store, peer);

      await session.handleText(agentFrame("traffic.report", report));

      expect(store.applyTraffic).toHaveBeenCalledWith(
        SERVER_ID,
        SESSION_ID,
        report,
      );
      expect(received(peer).at(-1)).toEqual({
        kind: "traffic.ack",
        payload: { reportId: "report-0001", result, accepted: 1, dropped: 0 },
      });
    },
  );

  it("quarantines a conflicting replay with an explicit ack", async () => {
    const store = makeStore({
      applyTraffic: vi.fn(async () => ({
        status: "conflict" as const,
        message: "different content",
      })),
    });
    const peer = makePeer();
    const session = await welcomed(store, peer);

    await session.handleText(agentFrame("traffic.report", report));

    expect(received(peer).at(-1)).toEqual({
      kind: "traffic.ack",
      payload: {
        reportId: "report-0001",
        result: "conflict",
        error: "different content",
      },
    });
  });

  it("sends no acknowledgement for a fenced report and stops the session", async () => {
    const store = makeStore({
      applyTraffic: vi.fn(async () => ({ status: "replaced" as const })),
    });
    const peer = makePeer();
    const session = await welcomed(store, peer);

    await session.handleText(agentFrame("traffic.report", report));

    expect(received(peer).map((message) => message.kind)).toEqual([
      "welcome",
      "error",
    ]);
    expect(peer.close).toHaveBeenCalledWith(4000, "session_replaced");
  });
});

describe("agent WebSocket v2 pushes and teardown", () => {
  it("restores welcomed state for a rebuilt session without re-welcoming", async () => {
    const store = makeStore();
    const peer = makePeer();
    const session = openAgentWsV2Session({
      serverId: SERVER_ID,
      sessionId: SESSION_ID,
      credential: { kind: "static", tokenHash: "hash-1" },
      peer,
      store,
      welcomed: true,
    });

    expect(session.welcomed).toBe(true);
    await session.handleText(
      agentFrame("config.get", { requestId: "snap-1", reason: "notify" }),
    );
    expect(received(peer)[0]).toMatchObject({
      kind: "config.snapshot.begin",
    });
  });

  it("encodes a config.notify frame that the agent can decode", () => {
    const notify = {
      desired: { desiredRevisionSeq: 8, desiredRevision: NEXT_REVISION },
      reason: "node updated",
    };
    const parsed = parseAgentWsV2Frame(
      encodeAgentWsV2ConfigNotify(notify),
      "control-plane",
    );
    expect(parsed).toMatchObject({
      ok: true,
      message: { kind: "config.notify", payload: notify },
    });
  });

  it("ends the session by its fence exactly once on close", async () => {
    const store = makeStore();
    const peer = makePeer();
    const session = await welcomed(store, peer);

    await session.close();
    await session.close();

    expect(store.endSession).toHaveBeenCalledTimes(2);
    expect(store.endSession).toHaveBeenCalledWith(SERVER_ID, SESSION_ID);
  });

  it("ignores frames after the session has been stopped", async () => {
    const store = makeStore({ recordHello: vi.fn(async () => null) });
    const peer = makePeer();
    const session = open(store, peer);
    await session.handleText(agentFrame("hello", CURRENT_HELLO));
    const count = peer.sent.length;

    await session.handleText(
      agentFrame("config.get", { requestId: "late", reason: "notify" }),
    );

    expect(peer.sent).toHaveLength(count);
    expect(store.loadCurrentServer).not.toHaveBeenCalled();
  });
});

describe("agent WebSocket v2 operations parity", () => {
  it("records update.status and stops a replaced session", async () => {
    const store = makeStore({
      recordUpdateStatus: vi.fn(async () => false),
    });
    const peer = makePeer();
    const session = await welcomed(store, peer);

    await session.handleText(
      agentFrame("update.status", {
        agent: { state: "applying", targetVersion: "0.4.1" },
      }),
    );

    expect(store.recordUpdateStatus).toHaveBeenCalledWith(
      SERVER_ID,
      SESSION_ID,
      expect.objectContaining({ agent: expect.any(Object) }),
    );
    expect(received(peer).at(-1)).toMatchObject({
      kind: "error",
      payload: { code: "session_replaced" },
    });
    expect(peer.close).toHaveBeenCalledWith(4000, "session_replaced");
  });

  it("passes ACME and terminal results through the fenced store", async () => {
    const store = makeStore();
    const onPtyFrame = vi.fn(() => true);
    const peer = makePeer();
    const session = await welcomed(store, peer, { onPtyFrame });

    await session.handleText(
      agentFrame("acme.dns_present", {
        jobId: "job-1",
        fqdn: "_acme-challenge.example.com",
        txtValue: "digest",
      }),
    );
    expect(store.handleAcmeDnsPresent).toHaveBeenCalledWith(
      SERVER_ID,
      SESSION_ID,
      expect.objectContaining({ jobId: "job-1" }),
    );

    await session.handleText(
      agentFrame("acme.result", {
        jobId: "job-1",
        certificatePem: "certificate",
        privateKeyPem: "key",
      }),
    );
    expect(store.handleAcmeResult).toHaveBeenCalledWith(
      SERVER_ID,
      SESSION_ID,
      expect.objectContaining({ jobId: "job-1" }),
    );

    await session.handleText(
      agentFrame("pty.data", { sessionId: "pty-1", data: "ls\r\n" }),
    );
    expect(onPtyFrame).toHaveBeenCalledWith({
      type: "pty.data",
      payload: { sessionId: "pty-1", data: "ls\r\n" },
    });
  });

  it("closes an orphaned shell when no relay holds its session", async () => {
    const store = makeStore();
    const peer = makePeer();
    const session = await welcomed(store, peer, {
      onPtyFrame: () => false,
    });

    await session.handleText(
      agentFrame("pty.data", { sessionId: "pty-1", data: "ls" }),
    );

    expect(received(peer).at(-1)).toMatchObject({
      kind: "pty.close",
      payload: { sessionId: "pty-1" },
    });
  });

  it("rejects a control-plane operation sent by an agent", async () => {
    const store = makeStore();
    const peer = makePeer();
    const session = await welcomed(store, peer);

    await session.handleText(
      agentFrame("update.trigger", {
        target: "agent",
        force: false,
      }),
    );

    expect(received(peer).at(-1)).toMatchObject({
      kind: "error",
      payload: { code: "invalid_direction", type: "update.trigger" },
    });
  });
});

describe("managed rollout v2 ingress", () => {
  const PROBE_CAPABILITY = "managed-link-probe-v1";
  const FP = `sha256:${"a".repeat(64)}`;
  const CAPABLE_HELLO: AgentWsV2HelloPayload = {
    ...CURRENT_HELLO,
    capabilities: ["config-v3", "managed-networking-v1", PROBE_CAPABILITY],
    applied: { desiredRevisionSeq: 8, desiredRevision: NEXT_REVISION },
  };
  const PROBE_RESULT = {
    probeId: "probe-1",
    rolloutId: "rollout-1",
    stageOrdinal: 2,
    linkId: "link-1",
    outcome: "succeeded" as const,
    applied: { desiredRevisionSeq: 8, managedFingerprint: FP },
    latencyMs: 12,
    completedAt: "2026-11-20T00:00:05.000Z",
  };

  function managed(
    store: AgentWsV2Store,
    peer: AgentWsV2Peer,
    options: Partial<
      Pick<
        OpenAgentWsV2SessionOptions,
        | "onManagedHello"
        | "onManagedStatus"
        | "onManagedConfigAck"
        | "onManagedProbeResult"
      >
    > = {},
  ) {
    return openAgentWsV2Session({
      serverId: SERVER_ID,
      sessionId: SESSION_ID,
      credential: { kind: "static", tokenHash: "hash-1" },
      peer,
      store,
      ...options,
    });
  }

  it("reports hello, status, applied and failed acks to the managed adapter", async () => {
    const store = makeStore({
      recordConfigAck: vi.fn(async (_serverId, _sessionId, ack) =>
        ack.outcome === "failed" ? ("failed" as const) : ("applied" as const),
      ),
    });
    const peer = makePeer();
    const hello = vi.fn();
    const status = vi.fn();
    const ack = vi.fn();
    const session = managed(store, peer, {
      onManagedHello: hello,
      onManagedStatus: status,
      onManagedConfigAck: ack,
    });

    await session.handleText(agentFrame("hello", CAPABLE_HELLO));
    expect(hello).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: SERVER_ID,
        sessionId: SESSION_ID,
        applied: CAPABLE_HELLO.applied,
        capabilities: CAPABLE_HELLO.capabilities,
      }),
    );

    await session.handleText(
      agentFrame("agent.status", {
        reason: "interval",
        certificateDeployments: [],
      }),
    );
    expect(status).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      sessionId: SESSION_ID,
    });

    const appliedAck: AgentWsV2ConfigAckPayload = {
      desired: { desiredRevisionSeq: 8, desiredRevision: NEXT_REVISION },
      outcome: "applied",
    };
    await session.handleText(agentFrame("config.ack", appliedAck));
    expect(ack).toHaveBeenLastCalledWith(
      expect.objectContaining({ ack: appliedAck, outcome: "applied" }),
    );

    const failedAck: AgentWsV2ConfigAckPayload = {
      desired: {
        desiredRevisionSeq: 9,
        desiredRevision: `9:sha256:${"d".repeat(64)}`,
      },
      outcome: "failed",
      stage: "apply",
      error: "candidate rejected",
    };
    await session.handleText(agentFrame("config.ack", failedAck));
    expect(ack).toHaveBeenLastCalledWith(
      expect.objectContaining({ ack: failedAck, outcome: "failed" }),
    );
  });

  it("does not report a stale or replaced acknowledgement", async () => {
    const peer = makePeer();
    const ack = vi.fn();
    const staleStore = makeStore({
      recordConfigAck: vi.fn(async () => "stale" as const),
    });
    const stale = managed(staleStore, peer, { onManagedConfigAck: ack });
    await stale.handleText(agentFrame("hello", CURRENT_HELLO));
    await stale.handleText(
      agentFrame("config.ack", {
        desired: { desiredRevisionSeq: 7, desiredRevision: REVISION },
        outcome: "applied",
      }),
    );
    expect(ack).not.toHaveBeenCalled();

    const replacedPeer = makePeer();
    const replacedStore = makeStore({
      recordConfigAck: vi.fn(async () => "replaced" as const),
    });
    const replaced = managed(replacedStore, replacedPeer, {
      onManagedConfigAck: ack,
    });
    await replaced.handleText(agentFrame("hello", CURRENT_HELLO));
    await replaced.handleText(
      agentFrame("config.ack", {
        desired: { desiredRevisionSeq: 8, desiredRevision: NEXT_REVISION },
        outcome: "applied",
      }),
    );
    expect(ack).not.toHaveBeenCalled();
  });

  it("accepts a probe result only from a session that advertised the capability", async () => {
    const capablePeer = makePeer();
    const onProbe = vi.fn();
    const probeSession = openAgentWsV2Session({
      serverId: SERVER_ID,
      sessionId: SESSION_ID,
      credential: { kind: "static", tokenHash: "hash-1" },
      peer: capablePeer,
      store: makeStore(),
      onManagedProbeResult: onProbe,
    });
    await probeSession.handleText(agentFrame("hello", CAPABLE_HELLO));
    await probeSession.handleText(
      agentFrame("link_probe.result", PROBE_RESULT),
    );
    expect(onProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: SERVER_ID,
        sessionId: SESSION_ID,
        result: PROBE_RESULT,
      }),
    );

    const incapablePeer = makePeer();
    const incapableProbe = vi.fn();
    const incapable = openAgentWsV2Session({
      serverId: SERVER_ID,
      sessionId: SESSION_ID,
      credential: { kind: "static", tokenHash: "hash-1" },
      peer: incapablePeer,
      store: makeStore(),
      onManagedProbeResult: incapableProbe,
    });
    await incapable.handleText(agentFrame("hello", CURRENT_HELLO));
    await incapable.handleText(agentFrame("link_probe.result", PROBE_RESULT));
    expect(incapableProbe).not.toHaveBeenCalled();
  });
});
