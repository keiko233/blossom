import {
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
  parseAgentWsV2Frame,
  type AgentWsV2AgentMessageType,
  type AgentWsV2PayloadOf,
} from "@blossom/contracts/agent-ws-v2";
import { describe, expect, it, vi } from "vitest";

import type { Server } from "@/db/proxy-schema";

import type { AgentWsStore } from "./agent-ws-session";
import type { AgentWsV2HubStore } from "./agent-ws-store";
import type { AgentWsV2Store } from "./agent-ws-v2-session";
import { NitroRealtimeHub } from "./realtime-hub";
import type {
  RealtimeBackplane,
  RealtimeBackplaneMessage,
} from "./realtime-hub-types";

const FIRST_SESSION = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION = "22222222-2222-4222-8222-222222222222";

const server = { id: "srv-1", name: "edge", enabled: true } as Server;

interface FakePeer {
  id: string;
  sent: string[];
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Hooks {
  open(peer: FakePeer): Promise<void>;
  message(peer: FakePeer, message: { text(): string }): Promise<void>;
  close(peer: FakePeer): Promise<void>;
}

function peer(id: string): FakePeer {
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
  return {
    text: () =>
      encodeAgentWsV2Frame(
        createAgentWsV2Frame(type, payload as never, {
          ts: "2026-11-19T00:00:00.000Z",
        }),
      ),
  };
}

function fakeV2Store(): AgentWsV2HubStore {
  let session = 0;
  return {
    startSession: vi.fn(async () => ({
      sessionId: session++ === 0 ? FIRST_SESSION : SECOND_SESSION,
      connectedAt: new Date("2026-11-19T00:00:00.000Z"),
    })),
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
        }) as unknown as Server,
    ),
    recordStatus: vi.fn(async () => null),
    recordConfigAck: vi.fn(async () => "applied" as const),
    cacheDesiredRevision: vi.fn(async () => undefined),
    applyCertificateDeployments: vi.fn(async () => undefined),
    applyTraffic: vi.fn(async () => ({
      status: "applied" as const,
      accepted: 0,
      dropped: 0,
    })),
    compile: vi.fn(async () => ({
      desiredRevision: "1:sha256:rev",
      document: {},
      validUntil: new Date("2026-11-19T00:02:00.000Z"),
    })),
    endSession: vi.fn(async () => undefined),
  } satisfies AgentWsV2Store & AgentWsV2HubStore;
}

function fakeV1Store(): AgentWsStore {
  return {
    markConnected: vi.fn(async () => ({
      connectedAt: new Date("2026-11-19T00:00:00.000Z"),
      sessionId: "session-v1",
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

/** One Redis channel shared by both instances; each hub ignores its own origin. */
function sharedBackplane() {
  const subscribers = new Set<(message: RealtimeBackplaneMessage) => void>();
  const publish = vi.fn(async (message: RealtimeBackplaneMessage) => {
    for (const deliver of subscribers) {
      deliver(structuredClone(message));
    }
  });
  const backplane = {
    subscribe: vi.fn(
      async (deliver: (message: RealtimeBackplaneMessage) => void) => {
        subscribers.add(deliver);
      },
    ),
    publish,
  } satisfies RealtimeBackplane;
  return { backplane, publish, subscribers };
}

function makeHub(backplane: RealtimeBackplane, store = fakeV2Store()) {
  return {
    hub: new NitroRealtimeHub({
      backplane,
      store: fakeV1Store(),
      v2Store: store,
    }),
    store,
  };
}

async function acceptV2(hub: NitroRealtimeHub): Promise<Hooks> {
  const response = await hub.acceptAgentV2(
    new Request("http://localhost/api/agent/ws", {
      headers: { upgrade: "websocket" },
    }),
    server,
  );
  return (response as Response & { crossws: Hooks }).crossws;
}

async function welcome(hooks: Hooks, agent: FakePeer): Promise<void> {
  await hooks.message(
    agent,
    agentFrame("hello", {
      agentVersion: "0.4.0",
      agentBuildId: "build-1",
      capabilities: ["logs-tail-v1", "logs-search-v1"],
      applied: null,
      certificateDeployments: [],
    }),
  );
}

describe("NitroRealtimeHub admin log routing", () => {
  it("relays browser control frames and agent log frames across instances", async () => {
    const { backplane } = sharedBackplane();
    const browser = makeHub(backplane);
    const agentSide = makeHub(backplane);
    const hooks = await acceptV2(agentSide.hub);
    const agent = peer("agent");
    await hooks.open(agent);
    await welcome(hooks, agent);

    const received: string[] = [];
    const unregister = browser.hub.registerLogRelay(
      "srv-1",
      FIRST_SESSION,
      "relay-1",
      (event) => {
        if (event.type === "frame") {
          received.push(event.frame);
        }
      },
    );

    const subscribe = encodeAgentWsV2Frame(
      createAgentWsV2Frame(
        "logs.subscribe",
        {
          subscriptionId: "relay-sub-1",
          filter: {},
          resume: null,
          limit: 200,
        },
        { ts: "2026-11-19T00:00:00.000Z" },
      ),
    );
    expect(browser.hub.sendLogFrame("srv-1", FIRST_SESSION, subscribe)).toBe(
      true,
    );
    await vi.waitFor(() => expect(agent.sent).toContain(subscribe));

    await hooks.message(
      agent,
      agentFrame("logs.batch", {
        subscriptionId: "relay-sub-1",
        next: { generation: "1", seq: 1 },
        hasMore: false,
        records: [
          {
            seq: 1,
            time: "2026-11-19T00:00:01.000Z",
            source: "agent",
            level: "info",
            processGeneration: 0,
            text: "hello",
            truncated: false,
          },
        ],
      }),
    );

    await vi.waitFor(() => expect(received).toHaveLength(1));
    const parsed = parseAgentWsV2Frame(received[0]!, "agent");
    expect(parsed.ok && parsed.message.kind).toBe("logs.batch");

    // A frame for another server or session is handed to no relay.
    expect(browser.hub.sendLogFrame("srv-2", FIRST_SESSION, subscribe)).toBe(
      true,
    );
    expect(browser.hub.sendLogFrame("srv-1", SECOND_SESSION, subscribe)).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const logFrames = agent.sent.filter((text) => {
      const parsed = parseAgentWsV2Frame(text, "control-plane");
      return parsed.ok && parsed.message.kind === "logs.subscribe";
    });
    expect(logFrames).toHaveLength(1);

    unregister();
    await hooks.close(agent);
  });

  it("closes relays bound to a session when the agent disconnects", async () => {
    const { backplane } = sharedBackplane();
    const browser = makeHub(backplane);
    const agentSide = makeHub(backplane);
    const hooks = await acceptV2(agentSide.hub);
    const agent = peer("agent");
    await hooks.open(agent);
    await welcome(hooks, agent);

    const events: string[] = [];
    browser.hub.registerLogRelay("srv-1", FIRST_SESSION, "relay-1", (event) => {
      events.push(event.type === "agentGone" ? event.reason : event.type);
    });

    await hooks.close(agent);

    await vi.waitFor(() => expect(events).toEqual(["agent_disconnected"]));
  });

  it("closes older relays when a newer agent session is admitted", async () => {
    const { backplane } = sharedBackplane();
    const browser = makeHub(backplane);
    const agentSide = makeHub(backplane);

    const first = peer("agent-1");
    const firstHooks = await acceptV2(agentSide.hub);
    await firstHooks.open(first);
    await welcome(firstHooks, first);

    const events: string[] = [];
    browser.hub.registerLogRelay("srv-1", FIRST_SESSION, "relay-1", (event) => {
      events.push(event.type === "agentGone" ? event.reason : event.type);
    });

    const second = peer("agent-2");
    const secondHooks = await acceptV2(agentSide.hub);
    await secondHooks.open(second);

    await vi.waitFor(() => expect(events).toEqual(["session_replaced"]));
    await firstHooks.close(first);
    await secondHooks.close(second);
  });
});
