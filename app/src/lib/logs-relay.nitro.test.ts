import {
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
  parseAgentWsV2Frame,
} from "@blossom/contracts/agent-ws-v2";
import {
  parseAdminLogsServerFrame,
  type AgentWsV2LogRecord,
} from "@blossom/contracts/agent-ws-v2-logs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LogAuthorityServer, LogAuthorityStore } from "./logs-authority";
import type { LogRelayAuditRecord } from "./logs-relay";
import type { AdminLogsAcceptContext } from "./logs-relay-types";
import { NitroAdminLogRelay, type AdminLogRelayPort } from "./logs-relay.nitro";

const T0 = Date.parse("2026-11-19T00:00:00.000Z");
const SESSION = "agent-session-1";

function context(): AdminLogsAcceptContext {
  return {
    serverId: "srv-1",
    serverName: "edge",
    agentSessionId: SESSION,
    authSessionId: "auth-session-1",
    relayId: "relay-1",
    actor: {
      id: "admin-1",
      email: "admin@example.com",
      impersonatedBy: null,
      ip: null,
      userAgent: null,
    },
    startedAt: new Date(T0),
  };
}

function server(
  overrides: Partial<LogAuthorityServer> = {},
): LogAuthorityServer {
  return {
    id: "srv-1",
    name: "edge",
    enabled: true,
    transportMode: "ws",
    wsSessionId: SESSION,
    agentCapabilities: ["logs-tail-v1", "logs-search-v1"],
    ...overrides,
  };
}

function authority(row = server()): LogAuthorityStore {
  return {
    loadAdminSession: vi.fn(async () => ({ userId: "admin-1", role: "admin" })),
    loadServer: vi.fn(async () => ({ ...row })),
  };
}

interface FakePort extends AdminLogRelayPort {
  browser: string[];
  agent: string[];
  closes: { code: number; reason: string }[];
  agentOnline: boolean;
}

function port(): FakePort {
  const fake: FakePort = {
    browser: [],
    agent: [],
    closes: [],
    agentOnline: true,
    sendToBrowser(frame) {
      fake.browser.push(frame);
    },
    sendToAgent(frame) {
      if (!fake.agentOnline) {
        return false;
      }
      fake.agent.push(frame);
      return true;
    },
    close(code, reason) {
      fake.closes.push({ code, reason });
    },
  };
  return fake;
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

function tailBatch(
  subscriptionId: string,
  records: AgentWsV2LogRecord[],
  nextSeq = records.at(-1)?.seq ?? 0,
): string {
  return encodeAgentWsV2Frame(
    createAgentWsV2Frame(
      "logs.batch",
      {
        subscriptionId,
        next: { generation: "1", seq: nextSeq },
        hasMore: false,
        records,
      },
      { ts: new Date(T0).toISOString() },
    ),
  );
}

function subscribe(relay: NitroAdminLogRelay): void {
  relay.handleBrowser(
    browserFrame("logs.subscribe", {
      subscriptionId: "tab-1",
      filter: {},
      resume: null,
      limit: 200,
    }),
  );
}

function lastAgentFrame(port: FakePort): {
  type: string;
  payload: Record<string, unknown>;
} {
  const parsed = parseAgentWsV2Frame(port.agent.at(-1)!, "control-plane");
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

function lastBrowserFrame(port: FakePort): {
  type: string;
  payload: Record<string, unknown>;
} {
  const parsed = parseAdminLogsServerFrame(port.browser.at(-1)!);
  if (!parsed.ok) {
    throw new Error(`unparseable browser frame: ${parsed.code}`);
  }
  return {
    type: parsed.frame.type,
    payload: parsed.frame.payload as Record<string, unknown>,
  };
}

function harness(options: { authority?: LogAuthorityStore } = {}) {
  const now = { value: T0 };
  const logPort = port();
  const audits: LogRelayAuditRecord[] = [];
  const relay = new NitroAdminLogRelay({
    context: context(),
    port: logPort,
    authority: options.authority ?? authority(),
    audit: async (entry) => {
      audits.push(entry);
    },
    now: () => now.value,
    newId: (() => {
      let n = 0;
      return () => `agent-${++n}`;
    })(),
  });
  relay.start();
  return { relay, port: logPort, audits, now };
}

describe("NitroAdminLogRelay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps a browser subscription to a relay-generated agent id", () => {
    const h = harness();
    subscribe(h.relay);

    expect(h.port.agent).toHaveLength(1);
    expect(lastAgentFrame(h.port)).toMatchObject({
      type: "logs.subscribe",
      payload: expect.objectContaining({
        subscriptionId: "agent-1",
        limit: 200,
      }),
    });
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: "server.logs_subscribe",
        input: { resumed: false },
      }),
    ]);
  });

  it("returns tail batches under the browser's subscription id", () => {
    const h = harness();
    subscribe(h.relay);
    const agentId = lastAgentFrame(h.port).payload.subscriptionId as string;

    h.relay.handleAgentFrame(tailBatch(agentId, [record(1), record(2)]));

    expect(lastBrowserFrame(h.port)).toMatchObject({
      type: "logs.batch",
      payload: expect.objectContaining({
        subscriptionId: "tab-1",
        next: { generation: "1", seq: 2 },
      }),
    });
  });

  it("drops an oversized tail batch and reports the dropped range", () => {
    const h = harness();
    subscribe(h.relay);
    const agentId = lastAgentFrame(h.port).payload.subscriptionId as string;
    const records = Array.from({ length: 200 }, (_, index) =>
      record(index + 1, "\n".repeat(4_096)),
    );

    h.relay.handleAgentFrame(tailBatch(agentId, records));

    expect(lastBrowserFrame(h.port)).toMatchObject({
      type: "logs.gap",
      payload: {
        subscriptionId: "tab-1",
        gap: { reason: "dropped", fromSeq: 1, toSeq: 200 },
      },
    });
    const close = h.audits.at(-1);
    expect(close?.action).not.toBe("server.logs_close");
  });

  it("expires a search at its deadline, cancels it on the agent and drops the late reply", async () => {
    const h = harness();
    h.relay.handleBrowser(
      browserFrame("logs.search", {
        requestId: "req-1",
        query: { text: "needle" },
        cursor: null,
        limit: 20,
      }),
    );
    const agentId = lastAgentFrame(h.port).payload.requestId as string;

    h.now.value = T0 + 10_001;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(lastBrowserFrame(h.port)).toMatchObject({
      type: "logs.error",
      payload: expect.objectContaining({ code: "timeout", requestId: "req-1" }),
    });
    expect(lastAgentFrame(h.port)).toMatchObject({
      type: "logs.search.cancel",
      payload: { requestId: agentId },
    });

    const before = h.port.browser.length;
    h.relay.handleAgentFrame(
      encodeAgentWsV2Frame(
        createAgentWsV2Frame(
          "logs.search.result",
          {
            requestId: agentId,
            generation: "1",
            pinnedSeq: 2,
            matches: [record(1)],
            next: null,
            coverage: { gap: null, searchableFrom: null, searchableTo: null },
          },
          { ts: new Date(T0).toISOString() },
        ),
      ),
    );
    expect(h.port.browser.length).toBe(before);
    expect(lastBrowserFrame(h.port).type).toBe("logs.error");
  });

  it("ends the relay when the admin loses the role on an idle check", async () => {
    const store = authority();
    vi.mocked(store.loadAdminSession).mockResolvedValue(null);
    const h = harness({ authority: store });
    subscribe(h.relay);

    h.now.value = T0 + 30_000;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(h.port.closes).toEqual([{ code: 4001, reason: "forbidden" }]);
    expect(h.port.agent.at(-1)).toBeDefined();
    expect(lastAgentFrame(h.port).type).toBe("logs.unsubscribe");
    expect(h.audits.at(-1)).toMatchObject({
      action: "server.logs_close",
      reason: "forbidden",
    });
  });

  it("ends the relay when a newer agent session replaces the fence", async () => {
    const store = authority(server({ wsSessionId: "agent-session-2" }));
    const h = harness({ authority: store });

    h.now.value = T0 + 30_000;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(h.port.closes).toEqual([{ code: 4003, reason: "session_replaced" }]);
  });

  it("closes with offline when the agent disappears and does not message it", () => {
    const h = harness();
    subscribe(h.relay);
    const sent = h.port.agent.length;

    h.relay.handleAgentGone("agent_disconnected");

    expect(h.port.closes).toEqual([
      { code: 4004, reason: "agent_disconnected" },
    ]);
    expect(h.port.agent).toHaveLength(sent);
  });

  it("unsubscribes on browser close and clears both timers", async () => {
    const h = harness();
    subscribe(h.relay);

    h.relay.handleBrowserClosed();

    expect(lastAgentFrame(h.port).type).toBe("logs.unsubscribe");
    expect(h.port.closes).toEqual([{ code: 1000, reason: "browser_closed" }]);
    expect(h.audits.at(-1)).toMatchObject({
      action: "server.logs_close",
      reason: "browser_closed",
    });

    // The intervals must not tick a closed relay into another close.
    h.now.value = T0 + 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.port.closes).toHaveLength(1);
  });

  it("reports agent loss when a control frame cannot be delivered", () => {
    const h = harness();
    h.port.agentOnline = false;

    subscribe(h.relay);

    expect(h.port.closes).toEqual([
      { code: 4004, reason: "agent_disconnected" },
    ]);
  });
});
