import { describe, expect, it, vi } from "vitest";

import {
  handleAdminPtyRequest,
  type AdminPtyAuthSession,
  type AdminPtyRouteDependencies,
  type AdminPtyServerState,
} from "./admin-pty-route";

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getSession: vi.fn() } }),
}));

const ORIGIN = "https://panel.example.com";
const URL = `${ORIGIN}/api/admin/servers/srv-1/pty/ws?sessionId=pty-1&cols=120&rows=40`;

function row(
  overrides: Partial<AdminPtyServerState> = {},
): AdminPtyServerState {
  return {
    id: "srv-1",
    name: "edge",
    enabled: true,
    transportMode: "ws",
    wsConnectedAt: new Date("2026-11-19T00:00:00.000Z"),
    agentCapabilities: ["pty-v1"],
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
  overrides: Partial<AdminPtyRouteDependencies> = {},
): AdminPtyRouteDependencies {
  return {
    authenticate: vi.fn(
      async () =>
        ({
          user: {
            id: "admin-1",
            email: "admin@example.com",
            role: "admin",
          },
          session: { impersonatedBy: null },
        }) as unknown as AdminPtyAuthSession,
    ),
    loadServer: vi.fn(async () => row()),
    accept: vi.fn(async () => new Response(null, { status: 426 })),
    recordOpen: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("admin PTY upgrade", () => {
  it("requires a WebSocket upgrade before authenticating", async () => {
    const deps = dependencies();
    const response = await handleAdminPtyRequest(
      request({ upgrade: "" }),
      { serverId: "srv-1" },
      deps,
    );
    expect(response.status).toBe(426);
    expect(deps.authenticate).not.toHaveBeenCalled();
    expect(deps.accept).not.toHaveBeenCalled();
  });

  it("rejects cross-origin upgrades and non-admin sessions", async () => {
    const crossOrigin = await handleAdminPtyRequest(
      request({ origin: "https://attacker.example" }),
      { serverId: "srv-1" },
      dependencies(),
    );
    expect(crossOrigin.status).toBe(403);

    const forbidden = await handleAdminPtyRequest(
      request(),
      { serverId: "srv-1" },
      dependencies({ authenticate: vi.fn(async () => null) }),
    );
    expect(forbidden.status).toBe(403);
  });

  it("rejects unknown, disabled, offline and legacy agents", async () => {
    const missing = await handleAdminPtyRequest(
      request(),
      { serverId: "srv-1" },
      dependencies({ loadServer: vi.fn(async () => null) }),
    );
    expect(missing.status).toBe(404);

    for (const unavailable of [
      row({ enabled: false }),
      row({ transportMode: "http", wsConnectedAt: null }),
      row({ agentCapabilities: ["ws-v1"] }),
    ]) {
      const response = await handleAdminPtyRequest(
        request(),
        { serverId: "srv-1" },
        dependencies({ loadServer: vi.fn(async () => unavailable) }),
      );
      expect(response.status).toBe(409);
    }
  });

  it("passes clamped geometry and audit identity to the relay", async () => {
    const deps = dependencies();
    const response = await handleAdminPtyRequest(
      new Request(
        `${ORIGIN}/api/admin/servers/srv-1/pty/ws?sessionId=pty-1&cols=9999&rows=1`,
        { headers: { origin: ORIGIN, upgrade: "websocket" } },
      ),
      { serverId: "srv-1" },
      deps,
    );
    expect(response.status).toBe(426);
    expect(deps.accept).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        serverId: "srv-1",
        connectedAt: "2026-11-19T00:00:00.000Z",
        sessionId: "pty-1",
        cols: 400,
        rows: 5,
        session: expect.objectContaining({
          sessionId: "pty-1",
          actor: expect.objectContaining({ id: "admin-1" }),
        }),
      }),
    );
    expect(deps.recordOpen).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "pty-1" }),
      { failed: false },
    );
  });

  it("records a failed upgrade without exposing details to the client", async () => {
    const deps = dependencies({
      accept: vi.fn(async () => Response.json({}, { status: 503 })),
    });
    const response = await handleAdminPtyRequest(
      request(),
      { serverId: "srv-1" },
      deps,
    );
    expect(response.status).toBe(503);
    expect(deps.recordOpen).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "pty-1" }),
      { failed: true },
    );
  });
});
