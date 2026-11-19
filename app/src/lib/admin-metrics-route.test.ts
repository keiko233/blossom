import { describe, expect, it, vi } from "vitest";

import {
  handleAdminMetricsRequest,
  type AdminMetricsAuthSession,
  type AdminMetricsRouteDependencies,
  type AdminMetricsServerState,
} from "./admin-metrics-route";

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getSession: vi.fn() } }),
}));

const ORIGIN = "https://panel.example.com";
const URL = `${ORIGIN}/api/admin/servers/srv-1/metrics/ws`;

function row(
  overrides: Partial<AdminMetricsServerState> = {},
): AdminMetricsServerState {
  return {
    id: "srv-1",
    enabled: true,
    transportMode: "ws",
    wsConnectedAt: new Date("2026-11-19T00:00:00.000Z"),
    wsSessionId: "22222222-2222-4222-8222-222222222222",
    agentCapabilities: ["telemetry-v2"],
    ...overrides,
  };
}

function request(headers: Record<string, string> = {}) {
  return new Request(URL, {
    headers: {
      origin: ORIGIN,
      upgrade: "websocket",
      ...headers,
    },
  });
}

function dependencies(
  overrides: Partial<AdminMetricsRouteDependencies> = {},
): AdminMetricsRouteDependencies {
  return {
    authenticate: vi.fn(
      async () =>
        ({
          user: { id: "admin-1", email: "admin@example.com", role: "admin" },
          session: { id: "session-1", impersonatedBy: null },
        }) as unknown as AdminMetricsAuthSession,
    ),
    loadServer: vi.fn(async () => row()),
    accept: vi.fn(async () => new Response(null, { status: 426 })),
    verify: vi.fn(async () => true),
    ...overrides,
  };
}

describe("admin metric WebSocket upgrade", () => {
  it("requires an upgrade before authenticating", async () => {
    const deps = dependencies();
    const response = await handleAdminMetricsRequest(
      request({ upgrade: "" }),
      { serverId: "srv-1" },
      deps,
    );
    expect(response.status).toBe(426);
    expect(deps.authenticate).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and unauthenticated upgrades", async () => {
    const cross = await handleAdminMetricsRequest(
      request({ origin: "https://attacker.example" }),
      { serverId: "srv-1" },
      dependencies(),
    );
    expect(cross.status).toBe(403);

    const denied = await handleAdminMetricsRequest(
      request(),
      { serverId: "srv-1" },
      dependencies({ authenticate: vi.fn(async () => null) }),
    );
    expect(denied.status).toBe(403);
  });

  it("reports unavailable servers without upgrading", async () => {
    const missing = await handleAdminMetricsRequest(
      request(),
      { serverId: "srv-1" },
      dependencies({ loadServer: vi.fn(async () => null) }),
    );
    expect(missing.status).toBe(404);

    for (const unavailable of [
      row({ enabled: false }),
      row({ transportMode: "http", wsConnectedAt: null }),
      row({ agentCapabilities: ["ws-v1"] }),
      row({ agentCapabilities: ["telemetry-v2"], wsSessionId: null }),
    ]) {
      const response = await handleAdminMetricsRequest(
        request(),
        { serverId: "srv-1" },
        dependencies({ loadServer: vi.fn(async () => unavailable) }),
      );
      expect(response.status).toBe(409);
    }
  });

  it("selects the exact v2 session and forwards the relay response", async () => {
    const deps = dependencies({
      accept: vi.fn(async () => new Response(null, { status: 426 })),
    });
    const response = await handleAdminMetricsRequest(
      request(),
      { serverId: "srv-1" },
      deps,
    );
    expect(response.status).toBe(426);
    expect(deps.accept).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        serverId: "srv-1",
        connectedAt: "2026-11-19T00:00:00.000Z",
        sessionId: "22222222-2222-4222-8222-222222222222",
        protocol: "v2",
        adminSessionId: "session-1",
        userId: "admin-1",
      }),
    );
  });

  it("keeps a legacy v1 agent working without a session id", async () => {
    const deps = dependencies({
      loadServer: vi.fn(async () =>
        row({ agentCapabilities: ["telemetry-v1"], wsSessionId: null }),
      ),
    });
    await handleAdminMetricsRequest(request(), { serverId: "srv-1" }, deps);
    expect(deps.accept).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ protocol: "v1", sessionId: null }),
    );
  });
});
