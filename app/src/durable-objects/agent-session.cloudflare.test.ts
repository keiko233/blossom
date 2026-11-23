import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
  applyManagedProbeResult: vi.fn(async () => []),
  drizzle: vi.fn(() => ({ marker: "database" })),
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  env: { DATABASE_URL: "postgres://blossom.test/db" },
}));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: mocks.drizzle }));
vi.mock("@/lib/agent-ws-store", () => ({
  createAgentWsStore: vi.fn(),
  createAgentWsV2Store: () => mocks.store,
}));
vi.mock("@/lib/admin-metrics-authority", () => ({
  verifyAdminMetricsAuthority: vi.fn(async () => true),
}));
vi.mock("@/query/log-audit", () => ({
  recordLogRelayAudit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/managed-rollout-runtime", () => ({
  applyManagedHello: vi.fn(async () => []),
  applyManagedStatus: vi.fn(async () => []),
  applyManagedConfigAck: vi.fn(async () => []),
  applyManagedProbeResult: mocks.applyManagedProbeResult,
  dispatchManagedRolloutFollowUps: vi.fn(async () => undefined),
}));

import {
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
  type AgentWsV2MessageType,
  type AgentWsV2PayloadOf,
} from "@blossom/contracts/agent-ws-v2";

import {
  AGENT_WS_INTERNAL_CONNECTED_AT,
  AGENT_WS_INTERNAL_PROTOCOL,
  AGENT_WS_INTERNAL_SERVER_ID,
  AGENT_WS_INTERNAL_SESSION_ID,
} from "@/lib/realtime-hub-types";

import { AgentSessionDO } from "./agent-session.cloudflare";

const CONNECTED_AT = "2026-11-19T00:00:00.000Z";

class FakeSocket {
  tags: string[] = [];
  private attachment: unknown = null;
  sent: string[] = [];
  closed: Array<{ code: number; reason: string }> = [];

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.attachment === null ? null : structuredClone(this.attachment);
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }
}

function v2Socket(sessionId: string): FakeSocket {
  const ws = new FakeSocket();
  ws.tags = ["srv-1"];
  ws.serializeAttachment({
    protocol: "v2",
    serverId: "srv-1",
    connectedAt: CONNECTED_AT,
    sessionId,
    welcomed: true,
  });
  return ws;
}

function v1Socket(): FakeSocket {
  const ws = new FakeSocket();
  ws.tags = ["srv-1"];
  ws.serializeAttachment({
    protocol: "v1",
    serverId: "srv-1",
    connectedAt: CONNECTED_AT,
    welcome: {
      serverId: "srv-1",
      serverName: "edge-1",
      protocolVersion: 1,
      desiredRevisionSeq: 0,
      desiredRevision: "0:sha256:" + "a".repeat(64),
      pollIntervalSeconds: 60,
      heartbeatIntervalSeconds: 30,
    },
  });
  return ws;
}

function ptySocket(): FakeSocket {
  const ws = new FakeSocket();
  ws.tags = ["pty:srv-1"];
  ws.serializeAttachment({
    kind: "pty",
    serverId: "srv-1",
    connectedAt: CONNECTED_AT,
    agentProtocol: "v2",
    agentSessionId: "session-old",
    sessionId: "pty-1",
    authSessionId: "auth-1",
    actor: {
      id: "admin-1",
      email: null,
      impersonatedBy: null,
      ip: null,
      userAgent: null,
    },
    startedAt: CONNECTED_AT,
    cols: 80,
    rows: 24,
  });
  return ws;
}

/** Node has neither a 101 `Response` nor `WebSocketPair`; workerd provides both. */
class SwitchingProtocolsResponse extends Response {
  constructor(
    body: BodyInit | null,
    init?: ResponseInit & { webSocket?: unknown },
  ) {
    if (init?.status !== 101) {
      super(body, init);
      return;
    }
    super(body, { ...init, status: 200 });
    Object.defineProperty(this, "status", { value: 101 });
    Object.defineProperty(this, "webSocket", { value: init.webSocket });
  }
}

function fakeStorage() {
  const storage = {
    alarm: null as number | null,
    getAlarm: vi.fn(async () => storage.alarm),
    setAlarm: vi.fn(async (time: number) => {
      storage.alarm = time;
    }),
    deleteAlarm: vi.fn(async () => {
      storage.alarm = null;
    }),
  };
  return storage;
}

function contextWith(sockets: FakeSocket[]) {
  const storage = fakeStorage();
  return {
    sockets,
    getWebSockets(tag?: string) {
      return (tag === undefined
        ? sockets
        : sockets.filter((ws) =>
            ws.tags.includes(tag),
          )) as unknown as WebSocket[];
    },
    acceptWebSocket(ws: WebSocket, tags: string[] = []) {
      const socket = ws as unknown as FakeSocket;
      socket.tags = tags;
      sockets.push(socket);
    },
    storage,
  };
}

function connectRequest(): Request {
  return new Request("https://agent-session.internal/internal/connect", {
    headers: {
      upgrade: "websocket",
      [AGENT_WS_INTERNAL_SERVER_ID]: "srv-1",
      [AGENT_WS_INTERNAL_CONNECTED_AT]: CONNECTED_AT,
      [AGENT_WS_INTERNAL_PROTOCOL]: "v2",
      [AGENT_WS_INTERNAL_SESSION_ID]: "session-new",
    },
  });
}

describe("AgentSessionDO v2 replacement", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "WebSocketPair",
      class {
        constructor() {
          return [new FakeSocket(), new FakeSocket()];
        }
      },
    );
    vi.stubGlobal("Response", SwitchingProtocolsResponse);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ends the previous v2 socket and its terminal on a new handshake", async () => {
    const previous = v2Socket("session-old");
    const pty = ptySocket();
    const ctx = contextWith([previous, pty]);
    const session = new AgentSessionDO(ctx as never, {} as never);

    const response = await session.fetch(connectRequest());

    expect(response.status).toBe(101);
    expect(response.headers.get("sec-websocket-protocol")).toBe(
      "blossom-agent.v2",
    );
    expect(previous.sent).toHaveLength(1);
    expect(JSON.parse(previous.sent[0]!)).toMatchObject({
      v: 2,
      type: "error",
      payload: { code: "session_replaced" },
    });
    expect(previous.closed).toEqual([
      { code: 4000, reason: "session_replaced" },
    ]);
    expect(previous.deserializeAttachment()).toMatchObject({
      protocol: "v2",
      superseded: true,
    });
    expect(pty.closed).toEqual([]);
  });

  it("delivers an exact-session v2 probe only to that socket", async () => {
    const first = v2Socket("session-a");
    const second = v2Socket("session-b");
    const ctx = contextWith([first, second]);
    const session = new AgentSessionDO(ctx as never, {} as never);

    const response = await session.fetch(
      new Request("https://agent-session.internal/internal/notify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          frame: '{"v":2}',
          protocol: "v2",
          agentSessionId: "session-b",
        }),
      }),
    );

    expect(response.status).toBe(204);
    expect(first.sent).toEqual([]);
    expect(second.sent).toEqual(['{"v":2}']);
  });

  it("leaves v1 and terminal sockets untouched", async () => {
    const v1 = v1Socket();
    const pty = ptySocket();
    const ctx = contextWith([v1, pty]);
    const session = new AgentSessionDO(ctx as never, {} as never);

    await session.fetch(connectRequest());

    expect(v1.closed).toEqual([]);
    expect(v1.sent).toEqual([]);
    expect(pty.closed).toEqual([]);
    expect(pty.sent).toEqual([]);
  });
});

const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");
const REVISION = `7:sha256:${"a".repeat(64)}`;

function serverRow() {
  return {
    id: "srv-1",
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
  };
}

function resetStore() {
  mocks.store = {
    loadCurrentServer: vi.fn(async () => serverRow()),
    recordHello: vi.fn(async () => serverRow()),
    revalidateSession: vi.fn(async () => "ok"),
    cacheDesiredRevision: vi.fn(async () => undefined),
    applyCertificateDeployments: vi.fn(async () => undefined),
    compile: vi.fn(async () => ({
      desiredRevision: REVISION,
      document: { apiVersion: 3, desiredRevision: REVISION },
      validUntil: FAR_FUTURE,
    })),
    endSession: vi.fn(async () => undefined),
  };
}

function agentFrame<T extends AgentWsV2MessageType>(
  type: T,
  payload: AgentWsV2PayloadOf<T>,
): string {
  return encodeAgentWsV2Frame(
    createAgentWsV2Frame(type, payload, { ts: "2026-11-19T00:00:00.000Z" }),
  );
}

const HELLO = {
  agentVersion: "0.4.0",
  agentBuildId: "build-1",
  capabilities: [
    "config-v3",
    "managed-networking-v1",
    "managed-link-probe-v1",
    "unrelated-capability",
  ],
  applied: null,
  certificateDeployments: [],
};

const PROBE_RESULT = {
  probeId: "probe-1",
  rolloutId: "rollout-1",
  stageOrdinal: 2,
  linkId: "link-1",
  outcome: "succeeded" as const,
  applied: {
    desiredRevisionSeq: 8,
    managedFingerprint: `sha256:${"a".repeat(64)}`,
  },
  latencyMs: 12,
  completedAt: "2026-11-20T00:00:05.000Z",
};

function unwelcomedV2Socket(): FakeSocket {
  const ws = new FakeSocket();
  ws.tags = ["srv-1"];
  ws.serializeAttachment({
    protocol: "v2",
    serverId: "srv-1",
    connectedAt: CONNECTED_AT,
    sessionId: "session-1",
    welcomed: false,
    pending: false,
    credentialKind: "static",
    expiresAt: null,
  });
  return ws;
}

describe("AgentSessionDO v2 frames across hibernation", () => {
  beforeEach(() => {
    resetStore();
    mocks.drizzle.mockClear();
    mocks.applyManagedProbeResult.mockClear();
  });

  it("keeps the negotiated capabilities for managed compiles and probe results", async () => {
    const ws = unwelcomedV2Socket();
    const session = new AgentSessionDO(contextWith([ws]) as never, {} as never);

    await session.webSocketMessage(ws as never, agentFrame("hello", HELLO));
    expect(ws.deserializeAttachment()).toMatchObject({
      welcomed: true,
      // Only the capabilities a later frame consults fit the 2 KiB attachment.
      capabilities: ["managed-networking-v1", "managed-link-probe-v1"],
    });

    await session.webSocketMessage(
      ws as never,
      agentFrame("config.get", { requestId: "snap-1", reason: "notify" }),
    );
    expect(mocks.store.compile).toHaveBeenLastCalledWith(expect.anything(), {
      agentCapabilities: ["managed-networking-v1", "managed-link-probe-v1"],
    });
    expect(ws.deserializeAttachment()).toMatchObject({
      snapshotGeneration: 1,
    });

    await session.webSocketMessage(
      ws as never,
      agentFrame("link_probe.result", PROBE_RESULT),
    );
    expect(mocks.applyManagedProbeResult).toHaveBeenCalledTimes(1);
  });

  it("reuses one database pool and skips the lease check for a data frame", async () => {
    const ws = unwelcomedV2Socket();
    const session = new AgentSessionDO(contextWith([ws]) as never, {} as never);
    await session.webSocketMessage(ws as never, agentFrame("hello", HELLO));
    const leaseChecks = mocks.store.revalidateSession!.mock.calls.length;

    const sample = agentFrame("telemetry.sample", {
      subscriptionId: "live-session-1",
      purpose: "live",
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
    });
    await session.webSocketMessage(ws as never, sample);
    await session.webSocketMessage(ws as never, sample);

    expect(mocks.store.revalidateSession).toHaveBeenCalledTimes(leaseChecks);
    expect(mocks.drizzle).toHaveBeenCalledTimes(1);
  });
});

describe("AgentSessionDO alarm coordination", () => {
  const NOW = new Date("2026-11-19T01:00:00.000Z");

  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal(
      "WebSocketPair",
      class {
        constructor() {
          return [new FakeSocket(), new FakeSocket()];
        }
      },
    );
    vi.stubGlobal("Response", SwitchingProtocolsResponse);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function logsRequest(sessionId: string): Request {
    return new Request("https://agent-session.internal/internal/logs/connect", {
      headers: {
        upgrade: "websocket",
        "x-blossom-agent-logs-server-id": "srv-1",
        "x-blossom-agent-logs-session-id": sessionId,
        "x-blossom-agent-logs-auth-session-id": "auth-session-1",
        "x-blossom-agent-logs-relay-id": "relay-1",
        "x-blossom-agent-logs-started-at": NOW.toISOString(),
        "x-blossom-agent-logs-actor": encodeURIComponent(
          JSON.stringify({ id: "admin-1", email: "admin@example.com" }),
        ),
      },
    });
  }

  /** A log relay admitted against a v2 agent, which is then removed. */
  async function connectLogs(
    ctx: ReturnType<typeof contextWith>,
    session: AgentSessionDO,
    agent: FakeSocket,
  ): Promise<FakeSocket> {
    const response = await session.fetch(logsRequest("session-old"));
    expect(response.status).toBe(101);
    expect(ctx.sockets).toContain(agent);
    return ctx.sockets.at(-1)!;
  }

  it("keeps the PTY re-check alarm when the last log viewer closes", async () => {
    const agent = v2Socket("session-old");
    const pty = ptySocket();
    const ctx = contextWith([agent, pty]);
    const session = new AgentSessionDO(ctx as never, {} as never);
    const logs = await connectLogs(ctx, session, agent);
    // The agent is gone, so only the shell still needs the alarm.
    ctx.sockets.splice(ctx.sockets.indexOf(agent), 1);

    await session.webSocketClose(logs as never, 1000, "", true);

    expect(ctx.storage.deleteAlarm).not.toHaveBeenCalled();
    expect(ctx.storage.alarm).not.toBeNull();
  });

  it("keeps the v2 lease alarm when the last log viewer closes", async () => {
    const agent = v2Socket("session-old");
    const ctx = contextWith([agent]);
    const session = new AgentSessionDO(ctx as never, {} as never);
    const logs = await connectLogs(ctx, session, agent);

    await session.webSocketClose(logs as never, 1000, "", true);

    expect(ctx.storage.deleteAlarm).not.toHaveBeenCalled();
    expect(ctx.storage.alarm).toBe(NOW.getTime() + 30_000);
  });

  it("removes the alarm only when no subsystem needs one", async () => {
    const agent = v2Socket("session-old");
    const ctx = contextWith([agent]);
    const session = new AgentSessionDO(ctx as never, {} as never);
    const logs = await connectLogs(ctx, session, agent);
    ctx.sockets.splice(ctx.sockets.indexOf(agent), 1);

    await session.webSocketClose(logs as never, 1000, "", true);

    expect(ctx.storage.deleteAlarm).toHaveBeenCalledTimes(1);
    expect(ctx.storage.alarm).toBeNull();
  });

  it("does not push an earlier log deadline out when a v2 frame arrives", async () => {
    const ws = unwelcomedV2Socket();
    const ctx = contextWith([ws]);
    const logDeadline = NOW.getTime() + 10_000;
    ctx.storage.alarm = logDeadline;
    const session = new AgentSessionDO(ctx as never, {} as never);

    await session.webSocketMessage(ws as never, agentFrame("hello", HELLO));

    expect(ctx.storage.alarm).toBe(logDeadline);
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
  });

  it("pulls a later alarm forward to the earliest deadline", async () => {
    const ws = unwelcomedV2Socket();
    const ctx = contextWith([ws]);
    ctx.storage.alarm = NOW.getTime() + 600_000;
    const session = new AgentSessionDO(ctx as never, {} as never);

    await session.webSocketMessage(ws as never, agentFrame("hello", HELLO));

    expect(ctx.storage.alarm).toBe(NOW.getTime() + 30_000);
  });
});

describe("AgentSessionDO live metrics", () => {
  beforeEach(() => {
    resetStore();
    vi.stubGlobal(
      "WebSocketPair",
      class {
        constructor() {
          return [new FakeSocket(), new FakeSocket()];
        }
      },
    );
    vi.stubGlobal("Response", SwitchingProtocolsResponse);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unsubscribes the agent when the last viewer closes", async () => {
    const agent = v2Socket("session-1");
    const ctx = contextWith([agent]);
    const session = new AgentSessionDO(ctx as never, {} as never);

    const response = await session.fetch(
      new Request(
        "https://agent-session.internal/internal/admin-metrics/connect?serverId=srv-1",
        {
          headers: {
            upgrade: "websocket",
            "x-blossom-metrics-connected-at": CONNECTED_AT,
            "x-blossom-metrics-admin-session": "admin-session-1",
            "x-blossom-metrics-user": "admin-1",
            "x-blossom-metrics-protocol": "v2",
            "x-blossom-metrics-session-id": "session-1",
          },
        },
      ),
    );
    expect(response.status).toBe(101);
    const viewer = ctx.sockets.at(-1)!;
    await vi.waitFor(() =>
      expect(agent.sent.map((frame) => JSON.parse(frame).type)).toContain(
        "telemetry.subscribe",
      ),
    );

    await session.webSocketClose(viewer as never, 1000, "", true);

    const unsubscribe = agent.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === "telemetry.unsubscribe");
    expect(unsubscribe?.payload).toEqual({ subscriptionId: "live-session-1" });
  });

  it("serves a v2 snapshot request from the Worker through the agent socket", async () => {
    const agent = v2Socket("session-1");
    const ctx = contextWith([agent]);
    const session = new AgentSessionDO(ctx as never, {} as never);

    const pending = session.fetch(
      new Request(
        `https://agent-session.internal/internal/telemetry?kind=snapshot&connectedAt=${encodeURIComponent(CONNECTED_AT)}&sessionId=session-1`,
        { method: "POST" },
      ),
    );
    await vi.waitFor(() => expect(agent.sent).toHaveLength(1));
    const inspect = JSON.parse(agent.sent[0]!);
    expect(inspect.type).toBe("telemetry.inspect");
    await session.webSocketMessage(
      agent as never,
      agentFrame("telemetry.snapshot", {
        requestId: inspect.payload.requestId,
        partial: false,
        listeners: [{ protocol: "tcp", address: "0.0.0.0", port: 443 }],
        interfaces: [],
      }),
    );

    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "snapshot",
      data: { listeners: [{ port: 443 }] },
    });
  });
});
