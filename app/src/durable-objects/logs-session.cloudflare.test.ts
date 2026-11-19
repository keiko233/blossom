import {
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
  parseAgentWsV2Frame,
  type AgentWsV2AgentMessageType,
  type AgentWsV2PayloadOf,
} from "@blossom/contracts/agent-ws-v2";
import {
  parseAdminLogsServerFrame,
  type AgentWsV2LogRecord,
} from "@blossom/contracts/agent-ws-v2-logs";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import {
  closeLogSocketsForAgent,
  handleAgentLogFrame,
  handleLogsBrowserMessage,
  handleLogsConnect,
  readLogSocketAttachment,
  revalidateLogSockets,
  type LogsDoContext,
  type LogsRelayDependencies,
} from "./logs-session.cloudflare";

const T0 = Date.parse("2026-11-19T01:00:00.000Z");
const STARTED_AT = "2026-11-19T00:30:00.000Z";
const SERVER = "srv-1";
const AGENT_SESSION = "agent-session-1";

/**
 * Mimics a hibernatable WebSocket: attachments are persisted as copies, so a
 * reader only sees what was serialized, never a live in-memory object.
 */
class FakeSocket {
  tags: string[] = [];
  private attachment: unknown = null;
  sent: string[] = [];
  closed: Array<{ code: number; reason: string }> = [];
  throwOnSend = false;

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.attachment === null ? null : structuredClone(this.attachment);
  }

  send(frame: string): void {
    if (this.throwOnSend) {
      throw new Error("socket is closing");
    }
    this.sent.push(frame);
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }
}

interface FakeCtx extends LogsDoContext {
  sockets: FakeSocket[];
  alarm: number | null;
  setAlarm: Mock<(time: number) => Promise<void>>;
  deleteAlarm: Mock<() => Promise<void>>;
}

function fakeCtx(sockets: FakeSocket[] = []): FakeCtx {
  const ctx: FakeCtx = {
    sockets,
    alarm: null,
    setAlarm: vi.fn(async (time: number) => {
      ctx.alarm = time;
    }),
    deleteAlarm: vi.fn(async () => {
      ctx.alarm = null;
    }),
    getWebSockets(tag?: string) {
      return ctx.sockets.filter(
        (ws) => tag === undefined || ws.tags.includes(tag),
      ) as unknown as WebSocket[];
    },
    acceptWebSocket(ws: WebSocket, tags: string[] = []) {
      (ws as unknown as FakeSocket).tags = tags;
      ctx.sockets.push(ws as unknown as FakeSocket);
    },
    storage: {
      getAlarm: async () => ctx.alarm,
      setAlarm: (time: number) => ctx.setAlarm(time),
      deleteAlarm: () => ctx.deleteAlarm(),
    },
  };
  return ctx;
}

function agentSocket(sessionId = AGENT_SESSION, serverId = SERVER): FakeSocket {
  const ws = new FakeSocket();
  ws.tags = [serverId];
  ws.serializeAttachment({
    protocol: "v2",
    serverId,
    connectedAt: "2026-11-19T00:00:00.000Z",
    sessionId,
    welcomed: true,
  });
  return ws;
}

function dependencies(
  overrides: Partial<LogsRelayDependencies> = {},
): LogsRelayDependencies {
  return {
    now: () => T0,
    newId: (() => {
      let n = 0;
      return () => `agent-${++n}`;
    })(),
    recordAudit: vi.fn(async () => undefined),
    revalidate: vi.fn(async () => null),
    ...overrides,
  };
}

function connectRequest(overrides: Record<string, string> = {}): Request {
  return new Request(
    "https://example.com/internal/logs/connect?serverId=srv-1",
    {
      headers: {
        upgrade: "websocket",
        "x-blossom-agent-logs-server-id": SERVER,
        "x-blossom-agent-logs-session-id": AGENT_SESSION,
        "x-blossom-agent-logs-auth-session-id": "auth-session-1",
        "x-blossom-agent-logs-relay-id": "relay-1",
        "x-blossom-agent-logs-started-at": STARTED_AT,
        "x-blossom-agent-logs-actor": encodeURIComponent(
          JSON.stringify({ id: "admin-1", email: "admin@example.com" }),
        ),
        ...overrides,
      },
    },
  );
}

async function connect(ctx: FakeCtx, deps = dependencies()) {
  const response = await handleLogsConnect(ctx, connectRequest(), deps);
  const browser = ctx.sockets.at(-1) as FakeSocket;
  return { response, browser, deps };
}

function browserFrame(type: string, payload: object): string {
  return JSON.stringify({
    v: 2,
    type,
    ts: new Date(T0).toISOString(),
    payload,
  });
}

function record(seq: number, text = `line ${seq}`): AgentWsV2LogRecord {
  return {
    seq,
    time: new Date(T0 + seq * 1000).toISOString(),
    source: "agent",
    level: "info",
    processGeneration: 0,
    text,
    truncated: false,
  };
}

function agentBatch(subscriptionId: string, records: AgentWsV2LogRecord[]) {
  return encodeAgentWsV2Frame(
    createAgentWsV2Frame(
      "logs.batch",
      {
        subscriptionId,
        next: { generation: "1", seq: records.at(-1)?.seq ?? 0 },
        hasMore: false,
        records,
      },
      { ts: new Date(T0).toISOString() },
    ),
  );
}

function agentFrame<T extends AgentWsV2AgentMessageType>(
  type: T,
  payload: AgentWsV2PayloadOf<T>,
): string {
  return encodeAgentWsV2Frame(
    createAgentWsV2Frame(type as never, payload as never, {
      ts: new Date(T0).toISOString(),
    }),
  );
}

function agentSent(socket: FakeSocket): {
  type: string;
  payload: Record<string, unknown>;
} {
  const parsed = parseAgentWsV2Frame(socket.sent.at(-1)!, "control-plane");
  if (!parsed.ok) {
    throw new Error(`unparseable agent frame: ${parsed.code}`);
  }
  if (parsed.message.kind === "unknown") {
    throw new Error("unexpected unknown agent frame");
  }
  return {
    type: parsed.message.kind,
    payload: parsed.message.payload as Record<string, unknown>,
  };
}

function browserSent(socket: FakeSocket): {
  type: string;
  payload: Record<string, unknown>;
} {
  const parsed = parseAdminLogsServerFrame(socket.sent.at(-1)!);
  if (!parsed.ok) {
    throw new Error(`unparseable browser frame: ${parsed.code}`);
  }
  return {
    type: parsed.frame.type,
    payload: parsed.frame.payload as Record<string, unknown>,
  };
}

/** Node has neither a 101 `Response` nor `WebSocketPair`; workerd has both. */
class SwitchingProtocolsResponse extends Response {
  constructor(
    body: BodyInit | null,
    init?: ResponseInit & { webSocket?: unknown },
  ) {
    if (init?.status !== 101) {
      super(body, init);
      return;
    }
    super(body, { status: 200 });
    Object.defineProperty(this, "status", { value: 101 });
    Object.defineProperty(this, "webSocket", { value: init.webSocket });
  }
}

function subscribeFrame(): string {
  return browserFrame("logs.subscribe", {
    subscriptionId: "tab-1",
    filter: {},
    resume: null,
    limit: 200,
  });
}

describe("admin log Durable Object relay", () => {
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

  it("refuses to bind without a welcomed v2 agent session", async () => {
    const ctx = fakeCtx();
    const response = await handleLogsConnect(
      ctx,
      connectRequest(),
      dependencies(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "agent_unavailable" });
    expect(ctx.sockets).toEqual([]);
    expect(ctx.setAlarm).not.toHaveBeenCalled();
  });

  it("accepts a relay and keeps its state in the attachment", async () => {
    const ctx = fakeCtx([agentSocket()]);
    const { response, browser } = await connect(ctx);

    expect(response.status).toBe(101);
    expect(browser.tags).toEqual([`logs:${SERVER}`]);
    const attachment = readLogSocketAttachment(browser as unknown as WebSocket);
    expect(attachment).toMatchObject({
      kind: "logs",
      serverId: SERVER,
      agentSessionId: AGENT_SESSION,
      authSessionId: "auth-session-1",
      relayId: "relay-1",
      state: expect.objectContaining({
        relayId: "relay-1",
        serverId: SERVER,
        sessionId: AGENT_SESSION,
        closed: false,
      }),
    });
    expect(ctx.alarm).toBe(T0 + 30_000);
  });

  it("maps browser ids to agent ids and back", async () => {
    const ctx = fakeCtx([agentSocket()]);
    const { browser, deps } = await connect(ctx);
    await handleLogsBrowserMessage(
      ctx,
      browser as unknown as WebSocket,
      readLogSocketAttachment(browser as unknown as WebSocket)!,
      subscribeFrame(),
      deps,
    );
    const agent = ctx.sockets[0]!;
    expect(agentSent(agent)).toMatchObject({
      type: "logs.subscribe",
      payload: expect.objectContaining({ subscriptionId: "agent-1" }),
    });

    await handleAgentLogFrame(
      ctx,
      SERVER,
      AGENT_SESSION,
      agentBatch("agent-1", [record(1)]),
      deps,
    );

    expect(browserSent(browser)).toMatchObject({
      type: "logs.batch",
      payload: expect.objectContaining({ subscriptionId: "tab-1" }),
    });
  });

  it("ignores frames from another agent session and another subscription", async () => {
    const ctx = fakeCtx([agentSocket()]);
    const { browser, deps } = await connect(ctx);
    const attachment = readLogSocketAttachment(
      browser as unknown as WebSocket,
    )!;
    await handleLogsBrowserMessage(
      ctx,
      browser as unknown as WebSocket,
      attachment,
      browserFrame("logs.subscribe", {
        subscriptionId: "tab-1",
        filter: {},
        resume: null,
        limit: 200,
      }),
      deps,
    );
    const before = browser.sent.length;

    await handleAgentLogFrame(
      ctx,
      SERVER,
      "another-session",
      agentBatch("agent-1", [record(1)]),
      deps,
    );
    await handleAgentLogFrame(
      ctx,
      SERVER,
      AGENT_SESSION,
      agentBatch("agent-2", [record(1)]),
      deps,
    );

    expect(browser.sent).toHaveLength(before);
  });

  it("reports a dropped range when the browser falls behind", async () => {
    const ctx = fakeCtx([agentSocket()]);
    const { browser, deps } = await connect(ctx);
    await handleLogsBrowserMessage(
      ctx,
      browser as unknown as WebSocket,
      readLogSocketAttachment(browser as unknown as WebSocket)!,
      browserFrame("logs.subscribe", {
        subscriptionId: "tab-1",
        filter: {},
        resume: null,
        limit: 200,
      }),
      deps,
    );
    const records = Array.from({ length: 200 }, (_, index) =>
      record(index + 1, "\n".repeat(4_096)),
    );

    await handleAgentLogFrame(
      ctx,
      SERVER,
      AGENT_SESSION,
      agentBatch("agent-1", records),
      deps,
    );

    expect(browserSent(browser)).toMatchObject({
      type: "logs.gap",
      payload: { gap: { reason: "dropped", fromSeq: 1, toSeq: 200 } },
    });
  });

  it("cancels a slow search and drops its late reply", async () => {
    const ctx = fakeCtx([agentSocket()]);
    const { browser, deps } = await connect(ctx);
    const ws = browser as unknown as WebSocket;
    await handleLogsBrowserMessage(
      ctx,
      ws,
      readLogSocketAttachment(ws)!,
      browserFrame("logs.search", {
        requestId: "req-1",
        query: { text: "needle" },
        cursor: null,
        limit: 20,
      }),
      deps,
    );
    const agent = ctx.sockets[0]!;
    const agentId = agentSent(agent).payload.requestId as string;

    await handleLogsBrowserMessage(
      ctx,
      ws,
      readLogSocketAttachment(ws)!,
      browserFrame("logs.search.cancel", { requestId: "req-1" }),
      deps,
    );
    expect(agentSent(agent)).toMatchObject({
      type: "logs.search.cancel",
      payload: { requestId: agentId },
    });

    const before = browser.sent.length;
    await handleAgentLogFrame(
      ctx,
      SERVER,
      AGENT_SESSION,
      agentFrame("logs.search.result", {
        requestId: agentId,
        generation: "1",
        pinnedSeq: 2,
        matches: [record(1)],
        next: null,
        coverage: { gap: null, searchableFrom: null, searchableTo: null },
      }),
      deps,
    );
    expect(browser.sent).toHaveLength(before);
  });

  it("keeps a second search while the first result audit is still writing", async () => {
    const ctx = fakeCtx([agentSocket()]);
    let releaseAudit: () => void = () => undefined;
    const auditGate = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    let markAuditStarted: () => void = () => undefined;
    const auditStarted = new Promise<void>((resolve) => {
      markAuditStarted = resolve;
    });
    const deps = dependencies({
      recordAudit: vi.fn(async () => {
        markAuditStarted();
        await auditGate;
      }),
    });
    const { browser } = await connect(ctx, deps);
    const ws = browser as unknown as WebSocket;
    const agent = ctx.sockets[0]!;

    await handleLogsBrowserMessage(
      ctx,
      ws,
      readLogSocketAttachment(ws)!,
      browserFrame("logs.search", {
        requestId: "req-1",
        query: { text: "first" },
        cursor: null,
        limit: 20,
      }),
      deps,
    );
    const first = agentSent(agent);
    const firstAgentId = first.payload.requestId as string;

    const firstResult = handleAgentLogFrame(
      ctx,
      SERVER,
      AGENT_SESSION,
      agentFrame("logs.search.result", {
        requestId: firstAgentId,
        generation: "1",
        pinnedSeq: 2,
        matches: [record(1)],
        next: null,
        coverage: { gap: null, searchableFrom: null, searchableTo: null },
      }),
      deps,
    );
    await auditStarted;

    const secondSearch = handleLogsBrowserMessage(
      ctx,
      ws,
      readLogSocketAttachment(ws)!,
      browserFrame("logs.search", {
        requestId: "req-2",
        query: { text: "second" },
        cursor: null,
        limit: 20,
      }),
      deps,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseAudit();
    await Promise.all([firstResult, secondSearch]);

    const searches = agent.sent.flatMap((text) => {
      const parsed = parseAgentWsV2Frame(text, "control-plane");
      return parsed.ok && parsed.message.kind === "logs.search"
        ? [parsed.message.payload.requestId]
        : [];
    });
    expect(searches).toHaveLength(2);
    const secondAgentId = searches[1]!;
    await handleAgentLogFrame(
      ctx,
      SERVER,
      AGENT_SESSION,
      agentFrame("logs.search.result", {
        requestId: secondAgentId,
        generation: "1",
        pinnedSeq: 2,
        matches: [record(2)],
        next: null,
        coverage: { gap: null, searchableFrom: null, searchableTo: null },
      }),
      deps,
    );
    expect(browserSent(browser)).toMatchObject({
      type: "logs.search.result",
      payload: { requestId: "req-2" },
    });
  });

  it("closes on a failed alarm authority check and tells the agent to stop", async () => {
    const ctx = fakeCtx([agentSocket()]);
    let now = T0;
    const deps = dependencies({
      now: () => now,
      revalidate: vi.fn(async () => "forbidden" as const),
    });
    const { browser } = await connect(ctx, deps);
    const ws = browser as unknown as WebSocket;
    await handleLogsBrowserMessage(
      ctx,
      ws,
      readLogSocketAttachment(ws)!,
      browserFrame("logs.subscribe", {
        subscriptionId: "tab-1",
        filter: {},
        resume: null,
        limit: 200,
      }),
      deps,
    );

    now = T0 + 30_000;
    await revalidateLogSockets(ctx, deps);

    expect(browser.closed).toEqual([{ code: 4001, reason: "forbidden" }]);
    expect(agentSent(ctx.sockets[0]!)).toMatchObject({
      type: "logs.unsubscribe",
    });
    expect(deps.recordAudit).toHaveBeenCalledWith(
      SERVER,
      expect.objectContaining({ id: "admin-1" }),
      expect.objectContaining({
        action: "server.logs_close",
        reason: "forbidden",
      }),
    );
  });

  it("closes an offline relay without messaging the missing agent", async () => {
    const ctx = fakeCtx([agentSocket()]);
    const { browser, deps } = await connect(ctx);
    const ws = browser as unknown as WebSocket;
    await handleLogsBrowserMessage(
      ctx,
      ws,
      readLogSocketAttachment(ws)!,
      browserFrame("logs.subscribe", {
        subscriptionId: "tab-1",
        filter: {},
        resume: null,
        limit: 200,
      }),
      deps,
    );
    const agent = ctx.sockets[0]!;
    const sent = agent.sent.length;

    await closeLogSocketsForAgent(
      ctx,
      SERVER,
      AGENT_SESSION,
      "agent_disconnected",
      deps,
    );

    expect(browser.closed).toEqual([
      { code: 4004, reason: "agent_disconnected" },
    ]);
    expect(agent.sent).toHaveLength(sent);
    expect(ctx.alarm).toBeNull();
  });

  it("closes an older relay when a newer session is admitted", async () => {
    const ctx = fakeCtx([agentSocket()]);
    const { browser, deps } = await connect(ctx);

    await closeLogSocketsForAgent(
      ctx,
      SERVER,
      "agent-session-2",
      "session_replaced",
      deps,
    );

    expect(browser.closed).toEqual([
      { code: 4003, reason: "session_replaced" },
    ]);
  });

  it("rehydrates the subscription from the attachment after hibernation", async () => {
    const ctx = fakeCtx([agentSocket()]);
    const { browser, deps } = await connect(ctx);
    const ws = browser as unknown as WebSocket;
    await handleLogsBrowserMessage(
      ctx,
      ws,
      readLogSocketAttachment(ws)!,
      browserFrame("logs.subscribe", {
        subscriptionId: "tab-1",
        filter: {},
        resume: null,
        limit: 200,
      }),
      deps,
    );

    const rehydrated = readLogSocketAttachment(ws)!;
    expect(rehydrated.state.subscription).toEqual({
      clientId: "tab-1",
      agentId: "agent-1",
    });
    await handleAgentLogFrame(
      ctx,
      SERVER,
      AGENT_SESSION,
      agentBatch("agent-1", [record(7)]),
      deps,
    );
    expect(browserSent(browser)).toMatchObject({
      type: "logs.batch",
      payload: expect.objectContaining({ subscriptionId: "tab-1" }),
    });
  });
});
