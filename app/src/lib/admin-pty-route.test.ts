import { describe, expect, it, vi } from "vitest";

import {
  handleAdminPtyRequest,
  handleAdminPtyStatus,
  type AdminPtyAuthSession,
  type AdminPtyRouteDependencies,
  type AdminPtyServerState,
} from "./admin-pty-route";
import type { AdminPtyAcceptContext } from "./pty-relay-types";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getSession } }),
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
    wsSessionId: null,
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
          session: { id: "auth-session-1", impersonatedBy: null },
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
        agentProtocol: "v1",
        agentSessionId: null,
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

  it("binds a v2 shell to the exact current agent session", async () => {
    const v2Row = row({
      wsSessionId: "agent-session-1",
      agentCapabilities: ["ws-v2", "pty-v2"],
    });
    const deps = dependencies({ loadServer: vi.fn(async () => v2Row) });
    const response = await handleAdminPtyRequest(
      request(),
      { serverId: "srv-1" },
      deps,
    );

    expect(response.status).toBe(426);
    expect(deps.accept).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        agentProtocol: "v2",
        agentSessionId: "agent-session-1",
      }),
    );

    const unsupported = await handleAdminPtyRequest(
      request(),
      { serverId: "srv-1" },
      dependencies({
        loadServer: vi.fn(async () =>
          row({
            wsSessionId: null,
            agentCapabilities: ["ws-v2", "pty-v2"],
          }),
        ),
      }),
    );
    expect(unsupported.status).toBe(409);
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

  it("re-checks the admin session and agent connection while the shell is open", async () => {
    const accept = vi.fn(
      async (_request: Request, _context: AdminPtyAcceptContext) =>
        new Response(null, { status: 426 }),
    );
    const deps = dependencies({ accept });
    await handleAdminPtyRequest(request(), { serverId: "srv-1" }, deps);
    const context = accept.mock.calls[0]?.[1];
    expect(context?.authSessionId).toBe("auth-session-1");
    expect(await context?.isAuthorized()).toBe(true);

    deps.authenticate = vi.fn(async () => null);
    expect(await context?.isAuthorized()).toBe(false);
    deps.authenticate = dependencies().authenticate;

    deps.loadServer = vi.fn(async () => row({ enabled: false }));
    expect(await context?.isAuthorized()).toBe(false);

    deps.loadServer = vi.fn(async () =>
      row({ wsConnectedAt: new Date("2026-11-19T00:00:01.000Z") }),
    );
    expect(await context?.isAuthorized()).toBe(false);

    deps.loadServer = vi.fn(async () => row());
    expect(await context?.isAuthorized()).toBe(true);
  });
});

describe("admin PTY status probe", () => {
  it("denies unauthenticated and non-admin callers before reading the server", async () => {
    const deps = dependencies({ authenticate: vi.fn(async () => null) });
    const response = await handleAdminPtyStatus(
      new Request(`${ORIGIN}/api/admin/servers/srv-1/pty/status`),
      { serverId: "srv-1" },
      deps,
    );
    expect(response.status).toBe(403);
    expect(deps.loadServer).not.toHaveBeenCalled();
  });

  it("reports readiness and each unavailable state without a server name", async () => {
    const probe = (loaded: AdminPtyServerState | null) =>
      handleAdminPtyStatus(
        new Request(`${ORIGIN}/api/admin/servers/srv-1/pty/status`),
        { serverId: "srv-1" },
        dependencies({ loadServer: vi.fn(async () => loaded) }),
      );

    const ready = await probe(row());
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ available: true });

    expect(await (await probe(null)).status).toBe(404);
    expect(await (await probe(row({ enabled: false }))).json()).toEqual({
      available: false,
      reason: "disabled",
    });
    expect(
      await (
        await probe(row({ transportMode: "http", wsConnectedAt: null }))
      ).json(),
    ).toEqual({ available: false, reason: "offline" });
    const unsupported = await (
      await probe(row({ agentCapabilities: ["ws-v1"] }))
    ).text();
    expect(unsupported).toBe('{"available":false,"reason":"unsupported"}');
    expect(unsupported).not.toContain("edge");
  });
});

describe("admin PTY session lookup", () => {
  it("reads the admin session without refreshing it, so the upgrade keeps its 101 shape", async () => {
    // A rolling refresh sets a cookie; TanStack then rebuilds the response to
    // apply it, and workerd rejects a rebuilt 101 without its webSocket.
    getSession.mockResolvedValueOnce(null);

    const response = await handleAdminPtyRequest(request(), {
      serverId: "srv-1",
    });

    expect(response.status).toBe(403);
    expect(getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      query: { disableRefresh: true },
    });
  });
});
