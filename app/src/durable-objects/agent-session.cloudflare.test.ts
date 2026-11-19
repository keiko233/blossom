import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  env: {},
}));

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

function contextWith(sockets: FakeSocket[]) {
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
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => undefined,
    },
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
