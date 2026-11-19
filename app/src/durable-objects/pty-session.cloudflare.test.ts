import { parseAgentWsFrame } from "@blossom/contracts/agent-ws";
import { parseAgentWsV2Frame } from "@blossom/contracts/agent-ws-v2";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import type { Database } from "@/db";

import {
  handleAgentV2PtyFrame,
  handlePtyBrowserMessage,
  handlePtyConnect,
  isPtySessionAuthorized,
  PTY_REVALIDATE_INTERVAL_MS,
  PTY_REVALIDATE_TIMEOUT_MS,
  type PtyAuthorizationCheck,
  type PtyDoContext,
  type PtySocketAttachment,
  revalidatePtySockets,
  schedulePtyRevalidation,
} from "./pty-session.cloudflare";

const NOW = new Date("2026-11-19T01:00:00.000Z");
const CONNECTED_AT = "2026-11-19T00:00:00.000Z";

/**
 * Mimics a hibernatable WebSocket: attachments are persisted as copies, so a
 * reader only ever sees what was serialized, never a live in-memory object.
 */
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

  frames() {
    return this.sent.map((text) => {
      const parsed = parseAgentWsFrame(text);
      if (!parsed.ok) {
        throw new Error("unparseable frame");
      }
      return parsed.frame;
    });
  }
}

interface FakeCtx extends PtyDoContext {
  sockets: FakeSocket[];
  alarm: number | null;
  setAlarm: Mock<(time: number) => Promise<void>>;
}

function fakeCtx(sockets: FakeSocket[] = []): FakeCtx {
  const ctx: FakeCtx = {
    sockets,
    alarm: null,
    setAlarm: vi.fn(async (time: number) => {
      ctx.alarm = time;
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
    },
  };
  return ctx;
}

function agentSocket(): FakeSocket {
  const ws = new FakeSocket();
  ws.tags = ["srv-1"];
  ws.serializeAttachment({
    serverId: "srv-1",
    connectedAt: CONNECTED_AT,
    welcome: {},
  });
  return ws;
}

function v2AgentSocket(sessionId = "agent-session-1"): FakeSocket {
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

function shellAttachment(
  overrides: Partial<PtySocketAttachment> = {},
): PtySocketAttachment {
  return {
    kind: "pty",
    serverId: "srv-1",
    connectedAt: CONNECTED_AT,
    agentProtocol: "v1",
    agentSessionId: null,
    sessionId: "pty-1",
    authSessionId: "auth-session-1",
    actor: {
      id: "admin-1",
      email: "admin@example.com",
      impersonatedBy: null,
      ip: null,
      userAgent: null,
    },
    startedAt: "2026-11-19T00:30:00.000Z",
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

function shellSocket(attachment = shellAttachment()): FakeSocket {
  const ws = new FakeSocket();
  ws.tags = ["pty:srv-1"];
  ws.serializeAttachment(attachment);
  return ws;
}

function recorder() {
  return vi.fn(async () => undefined);
}

describe("PTY storage alarm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms one alarm for the first shell and keeps it for later shells", async () => {
    const ctx = fakeCtx();
    await schedulePtyRevalidation(ctx);
    expect(ctx.alarm).toBe(NOW.getTime() + PTY_REVALIDATE_INTERVAL_MS);

    vi.setSystemTime(new Date(NOW.getTime() + 10_000));
    await schedulePtyRevalidation(ctx);
    expect(ctx.setAlarm).toHaveBeenCalledTimes(1);
    expect(ctx.alarm).toBe(NOW.getTime() + PTY_REVALIDATE_INTERVAL_MS);
  });

  it("re-checks a silent shell from the alarm alone and re-arms while it stays open", async () => {
    const agent = agentSocket();
    const shell = shellSocket();
    const ctx = fakeCtx([agent, shell]);
    const check = vi.fn<PtyAuthorizationCheck>(async () => true);
    const recordClose = recorder();

    await revalidatePtySockets(ctx, recordClose, check);

    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "pty-1" }),
    );
    expect(shell.closed).toEqual([]);
    expect(shell.sent).toEqual([]);
    expect(recordClose).not.toHaveBeenCalled();
    expect(ctx.alarm).toBe(NOW.getTime() + PTY_REVALIDATE_INTERVAL_MS);
  });

  it("closes a shell whose admin session was revoked and stops the agent's shell", async () => {
    const agent = agentSocket();
    const shell = shellSocket();
    const ctx = fakeCtx([agent, shell]);
    const recordClose = recorder();

    await revalidatePtySockets(ctx, recordClose, async () => false);

    expect(shell.closed).toEqual([
      { code: 1008, reason: "authorization_revoked" },
    ]);
    expect(shell.frames().map((frame) => frame.type)).toEqual(["pty.exit"]);
    expect(shell.frames()[0]?.payload).toMatchObject({
      sessionId: "pty-1",
      reason: "authorization_revoked",
    });
    expect(agent.frames().map((frame) => frame.type)).toEqual(["pty.close"]);
    expect(agent.frames()[0]?.payload).toEqual({ sessionId: "pty-1" });

    expect(recordClose).toHaveBeenCalledTimes(1);
    const [closed, reason, outcome] = recordClose.mock.calls[0] as unknown as [
      PtySocketAttachment,
      string,
      unknown,
    ];
    expect(reason).toBe("authorization_revoked");
    expect(outcome).toEqual({});
    expect(closed.closeAudited).toBe(true);
  });

  it("keeps cookies and bearer credentials out of the persisted attachment and the audit call", async () => {
    const shell = shellSocket();
    const ctx = fakeCtx([agentSocket(), shell]);
    const recordClose = recorder();

    await revalidatePtySockets(ctx, recordClose, async () => false);

    // Only lifecycle fields are stored: no cookie, bearer or token material.
    const lifecycleKeys = [
      "actor",
      "agentProtocol",
      "agentSessionId",
      "authSessionId",
      "closeAudited",
      "closeReason",
      "cols",
      "connectedAt",
      "kind",
      "rows",
      "serverId",
      "sessionId",
      "startedAt",
    ];
    expect(Object.keys(shell.deserializeAttachment() as object).sort()).toEqual(
      lifecycleKeys,
    );
    const [audited] = recordClose.mock.calls[0] as unknown as [
      PtySocketAttachment,
    ];
    expect(Object.keys(audited).sort()).toEqual(lifecycleKeys);
  });

  it("fails closed when the re-check throws", async () => {
    const shell = shellSocket();
    const ctx = fakeCtx([agentSocket(), shell]);
    const recordClose = recorder();

    await revalidatePtySockets(ctx, recordClose, async () => {
      throw new Error("database unreachable");
    });

    expect(shell.closed).toEqual([
      { code: 1008, reason: "authorization_revoked" },
    ]);
    expect(recordClose).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the re-check never answers", async () => {
    const shell = shellSocket();
    const ctx = fakeCtx([agentSocket(), shell]);
    const recordClose = recorder();

    const sweep = revalidatePtySockets(
      ctx,
      recordClose,
      () => new Promise<boolean>(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(PTY_REVALIDATE_TIMEOUT_MS);
    await sweep;

    expect(shell.closed).toEqual([
      { code: 1008, reason: "authorization_revoked" },
    ]);
  });

  it("closes a shell without asking the database when its agent socket is gone", async () => {
    const shell = shellSocket();
    const ctx = fakeCtx([shell]);
    const check = vi.fn<PtyAuthorizationCheck>(async () => true);
    const recordClose = recorder();

    await revalidatePtySockets(ctx, recordClose, check);

    expect(check).not.toHaveBeenCalled();
    expect(shell.closed).toEqual([
      { code: 1008, reason: "authorization_revoked" },
    ]);
  });

  it("re-arms the alarm before any check runs", async () => {
    const shell = shellSocket();
    const ctx = fakeCtx([agentSocket(), shell]);
    const check = vi.fn<PtyAuthorizationCheck>(async () => {
      throw new Error("boom");
    });

    await revalidatePtySockets(ctx, recorder(), check);

    expect(ctx.setAlarm.mock.invocationCallOrder[0]).toBeLessThan(
      check.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("does nothing once every shell is closed, so the object can hibernate", async () => {
    const ctx = fakeCtx([agentSocket(), shellSocket()]);
    const check = vi.fn<PtyAuthorizationCheck>(async () => false);
    await revalidatePtySockets(ctx, recorder(), check);
    ctx.setAlarm.mockClear();
    check.mockClear();

    await revalidatePtySockets(ctx, recorder(), check);

    expect(ctx.setAlarm).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("still checks a shell after hibernation, using only its persisted attachment", async () => {
    const agent = agentSocket();
    const shell = shellSocket();
    const before = fakeCtx([agent, shell]);
    await revalidatePtySockets(before, recorder(), async () => true);

    // A fresh object rebuilds its sockets from storage alone.
    const restored = (ws: FakeSocket) => {
      const copy = new FakeSocket();
      copy.tags = [...ws.tags];
      copy.serializeAttachment(ws.deserializeAttachment());
      return copy;
    };
    const after = fakeCtx([restored(agent), restored(shell)]);
    const check = vi.fn<PtyAuthorizationCheck>(async () => false);
    const recordClose = recorder();

    await revalidatePtySockets(after, recordClose, check);

    expect(check).toHaveBeenCalledTimes(1);
    expect(recordClose).toHaveBeenCalledTimes(1);
  });

  it("closes a PTY socket that predates the session-row attachment", async () => {
    const legacy = new FakeSocket();
    legacy.tags = ["pty:srv-1"];
    legacy.serializeAttachment({
      ...shellAttachment(),
      authSessionId: undefined,
    });
    const ctx = fakeCtx([agentSocket(), legacy]);
    const check = vi.fn<PtyAuthorizationCheck>(async () => true);

    await revalidatePtySockets(ctx, recorder(), check);

    expect(check).not.toHaveBeenCalled();
    expect(legacy.closed).toEqual([
      { code: 1008, reason: "authorization_revoked" },
    ]);
  });

  it("drops browser input that arrives after the shell was closed", async () => {
    const agent = agentSocket();
    const closedAttachment = shellAttachment({
      closeAudited: true,
      closeReason: "authorization_revoked",
    });
    const shell = shellSocket(closedAttachment);
    const ctx = fakeCtx([agent, shell]);

    await handlePtyBrowserMessage(
      ctx,
      shell as unknown as WebSocket,
      closedAttachment,
      JSON.stringify({ type: "pty.data", payload: { sessionId: "pty-1" } }),
      recorder(),
    );

    expect(agent.sent).toEqual([]);
  });
});

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
    super(body, { status: 200 });
    Object.defineProperty(this, "status", { value: 101 });
    Object.defineProperty(this, "webSocket", { value: init.webSocket });
  }
}

describe("PTY connect", () => {
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

  const connectRequest = (overrides: Record<string, string> = {}): Request =>
    new Request("https://example.com/internal/pty/connect?serverId=srv-1", {
      headers: {
        upgrade: "websocket",
        "x-blossom-pty-session": "pty-1",
        "x-blossom-pty-connected-at": CONNECTED_AT,
        "x-blossom-pty-protocol": "v1",
        "x-blossom-pty-started-at": "2026-11-19T00:30:00.000Z",
        "x-blossom-pty-auth-session": "auth-session-1",
        "x-blossom-pty-actor": encodeURIComponent(
          JSON.stringify({ id: "admin-1", email: "admin@example.com" }),
        ),
        "x-blossom-pty-cols": "100",
        "x-blossom-pty-rows": "30",
        ...overrides,
      },
    });

  it("rejects a connect without the session row id before accepting a socket", async () => {
    const ctx = fakeCtx();
    const actor = encodeURIComponent(
      JSON.stringify({ id: "admin-1", email: "admin@example.com" }),
    );
    const response = await handlePtyConnect(
      ctx,
      new Request("https://example.com/internal/pty/connect?serverId=srv-1", {
        headers: {
          upgrade: "websocket",
          "x-blossom-pty-session": "pty-1",
          "x-blossom-pty-connected-at": CONNECTED_AT,
          "x-blossom-pty-started-at": "2026-11-19T00:30:00.000Z",
          "x-blossom-pty-actor": actor,
        },
      }),
      recorder(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_terminal_session",
    });
    expect(ctx.sockets).toEqual([]);
    expect(ctx.setAlarm).not.toHaveBeenCalled();
  });

  it("opens the shell on the agent with the clamped geometry, after the browser socket is registered", async () => {
    const agent = agentSocket();
    const ctx = fakeCtx([agent]);
    const socketsAtSend: number[] = [];
    agent.send = (frame: string) => {
      socketsAtSend.push(ctx.sockets.length);
      agent.sent.push(frame);
    };
    const recordClose = recorder();

    const response = await handlePtyConnect(ctx, connectRequest(), recordClose);

    expect(response.status).toBe(101);
    expect(socketsAtSend).toEqual([2]);
    expect(agent.frames().map((frame) => frame.type)).toEqual(["pty.open"]);
    expect(agent.frames()[0]?.payload).toEqual({
      sessionId: "pty-1",
      cols: 100,
      rows: 30,
    });
    const shell = ctx.sockets[1] as unknown as FakeSocket;
    expect(shell.tags).toEqual(["pty:srv-1"]);
    expect(shell.sent).toEqual([]);
    expect(shell.closed).toEqual([]);
    expect(recordClose).not.toHaveBeenCalled();
  });

  it("closes the browser as agent_disconnected and audits it when the agent refuses pty.open", async () => {
    const agent = agentSocket();
    agent.send = () => {
      throw new Error("agent socket is closing");
    };
    const ctx = fakeCtx([agent]);
    const recordClose = recorder();

    const response = await handlePtyConnect(ctx, connectRequest(), recordClose);

    expect(response.status).toBe(101);
    expect(agent.sent).toEqual([]);
    const shell = ctx.sockets[1] as unknown as FakeSocket;
    expect(shell.frames().map((frame) => frame.type)).toEqual(["pty.exit"]);
    expect(shell.frames()[0]?.payload).toMatchObject({
      sessionId: "pty-1",
      reason: "agent_disconnected",
    });
    expect(shell.closed).toEqual([
      { code: 1011, reason: "agent_disconnected" },
    ]);
    expect(recordClose).toHaveBeenCalledTimes(1);
    const [closed, reason] = recordClose.mock.calls[0] as unknown as [
      PtySocketAttachment,
      string,
    ];
    expect(reason).toBe("agent_disconnected");
    expect(closed.closeAudited).toBe(true);
  });

  it("closes the browser when the agent disappears while the alarm is armed", async () => {
    const agent = agentSocket();
    const ctx = fakeCtx([agent]);
    ctx.setAlarm.mockImplementationOnce(async (time: number) => {
      ctx.alarm = time;
      ctx.sockets.splice(ctx.sockets.indexOf(agent), 1);
    });
    const recordClose = recorder();

    const response = await handlePtyConnect(ctx, connectRequest(), recordClose);

    expect(response.status).toBe(101);
    expect(agent.sent).toEqual([]);
    expect(recordClose).toHaveBeenCalledTimes(1);
    const [, reason] = recordClose.mock.calls[0] as unknown as [
      PtySocketAttachment,
      string,
    ];
    expect(reason).toBe("agent_disconnected");
  });
});

describe("PTY v2 framing", () => {
  it("routes agent v2 output to the browser as a v1 frame", async () => {
    const agent = v2AgentSocket();
    const shell = shellSocket(
      shellAttachment({
        agentProtocol: "v2",
        agentSessionId: "agent-session-1",
      }),
    );
    const ctx = fakeCtx([agent, shell]);
    const recordClose = recorder();

    await expect(
      handleAgentV2PtyFrame(
        ctx,
        "srv-1",
        "agent-session-1",
        {
          type: "pty.data",
          payload: { sessionId: "pty-1", data: "prompt$ " },
        },
        recordClose,
      ),
    ).resolves.toBe(true);

    expect(shell.frames().map((frame) => frame.type)).toEqual(["pty.data"]);
    expect(shell.frames()[0]?.payload).toMatchObject({
      sessionId: "pty-1",
      data: "prompt$ ",
    });
  });

  it("converts browser input to v2 and ignores a replaced agent session", async () => {
    const agent = v2AgentSocket("agent-session-1");
    const shell = shellSocket(
      shellAttachment({
        agentProtocol: "v2",
        agentSessionId: "agent-session-1",
      }),
    );
    const ctx = fakeCtx([agent, shell]);
    const recordClose = recorder();

    await handlePtyBrowserMessage(
      ctx,
      shell as unknown as WebSocket,
      shellAttachment({
        agentProtocol: "v2",
        agentSessionId: "agent-session-1",
      }),
      JSON.stringify({
        v: 1,
        type: "pty.data",
        ts: CONNECTED_AT,
        payload: { sessionId: "pty-1", data: "ls\n" },
      }),
      recordClose,
    );

    const sent = agent.sent[0]!;
    expect(parseAgentWsV2Frame(sent, "control-plane")).toMatchObject({
      ok: true,
      message: {
        kind: "pty.data",
        payload: { sessionId: "pty-1", data: "ls\n" },
      },
    });

    const replaced = await handleAgentV2PtyFrame(
      ctx,
      "srv-1",
      "agent-session-2",
      {
        type: "pty.data",
        payload: { sessionId: "pty-1", data: "stale" },
      },
      recordClose,
    );
    expect(replaced).toBe(false);
    expect(shell.frames()).toHaveLength(0);
  });
});

describe("isPtySessionAuthorized", () => {
  /** A select chain that resolves to `rows`, recording the session id it filters on. */
  function fakeDatabase(rows: unknown[]) {
    const chain = {
      select: () => chain,
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: async () => rows,
    };
    return chain as unknown as Database;
  }

  const healthy = {
    sessionUserId: "admin-1",
    sessionExpiresAt: new Date("2026-11-20T00:00:00.000Z"),
    role: "admin",
    enabled: true,
    transportMode: "ws",
    wsConnectedAt: new Date(CONNECTED_AT),
    agentCapabilities: ["pty-v1"],
  };

  it("keeps the shell when the joined rows still satisfy the Node relay's rules", async () => {
    await expect(
      isPtySessionAuthorized(fakeDatabase([healthy]), shellAttachment(), NOW),
    ).resolves.toBe(true);
  });

  it("revokes when the session row no longer exists", async () => {
    await expect(
      isPtySessionAuthorized(fakeDatabase([]), shellAttachment(), NOW),
    ).resolves.toBe(false);
  });

  it("revokes when the role was lost or the server is disabled", async () => {
    await expect(
      isPtySessionAuthorized(
        fakeDatabase([{ ...healthy, role: "user" }]),
        shellAttachment(),
        NOW,
      ),
    ).resolves.toBe(false);
    await expect(
      isPtySessionAuthorized(
        fakeDatabase([{ ...healthy, enabled: false }]),
        shellAttachment(),
        NOW,
      ),
    ).resolves.toBe(false);
  });
});
