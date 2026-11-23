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

const CONNECTED_AT = "2026-11-19T00:00:00.000Z";

beforeEach(() => {
  mocks.fetch
    .mockReset()
    .mockResolvedValue(new Response(null, { status: 204 }));
});

describe("CloudflareRealtimeHub telemetry inspection", () => {
  it("asks the Durable Object to inspect a v2 agent session", async () => {
    const snapshot = { kind: "snapshot", data: { listeners: [] } };
    mocks.fetch.mockResolvedValueOnce(Response.json(snapshot));

    const result = await new CloudflareRealtimeHub().inspectTelemetry(
      "srv-1",
      CONNECTED_AT,
      "session-1",
    );

    expect(result).toEqual(snapshot);
    const request = mocks.fetch.mock.calls[0]![0];
    expect(request.method).toBe("POST");
    const url = new URL(request.url);
    expect(url.pathname).toBe("/internal/telemetry");
    expect(url.searchParams.get("kind")).toBe("snapshot");
    expect(url.searchParams.get("connectedAt")).toBe(CONNECTED_AT);
    expect(url.searchParams.get("sessionId")).toBe("session-1");
  });

  it("returns null when the v2 agent cannot be inspected", async () => {
    expect(
      await new CloudflareRealtimeHub().inspectTelemetry(
        "srv-1",
        CONNECTED_AT,
        "session-1",
      ),
    ).toBeNull();
  });

  it("keeps the v1 snapshot request free of a session id", async () => {
    await new CloudflareRealtimeHub().inspectTelemetry(
      "srv-1",
      CONNECTED_AT,
      null,
    );

    const url = new URL(mocks.fetch.mock.calls[0]![0].url);
    expect(url.searchParams.get("sessionId")).toBeNull();
  });
});
