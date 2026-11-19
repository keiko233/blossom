import { parseAgentWsV2Frame } from "@blossom/contracts/agent-ws-v2";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(
    async (_request: Request) => new Response(null, { status: 204 }),
  ),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    AGENT_SESSION_DO: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: mocks.fetch }),
    },
  },
}));

vi.mock("@/query/agent", () => ({
  markAgentWsConnected: vi.fn(async () => new Date()),
  markAgentWsDisconnected: vi.fn(async () => undefined),
  endAgentWsSession: vi.fn(async () => undefined),
}));

vi.mock("@/lib/agent-ws-store", () => ({
  createAgentWsV2Store: () => ({}),
}));

import { CloudflareRealtimeHub } from "./realtime-hub.cloudflare";

beforeEach(() => {
  mocks.fetch
    .mockReset()
    .mockResolvedValue(new Response(null, { status: 204 }));
});

describe("CloudflareRealtimeHub log policy", () => {
  it("sends a v2-only log.policy.notify to the server's Durable Object", async () => {
    const hub = new CloudflareRealtimeHub();
    await hub.notifyLogPolicy("srv-1", {
      revision: 3,
      source: "agent",
      reason: "log policy changed",
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const request = mocks.fetch.mock.calls[0]![0];
    expect(request.url).toBe("https://agent-session.internal/internal/notify");
    const body = (await request.json()) as { frame: string; protocol?: string };
    expect(body.protocol).toBe("v2");
    const parsed = parseAgentWsV2Frame(body.frame, "control-plane");
    expect(parsed).toMatchObject({
      ok: true,
      message: {
        kind: "log.policy.notify",
        payload: { revision: 3, source: "agent" },
      },
    });
  });
});
