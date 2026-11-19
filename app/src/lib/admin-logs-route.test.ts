import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  authenticateAdminLogsSession,
  handleAdminLogsRequest,
  type AdminLogsAuthSession,
  type AdminLogsRouteDependencies,
} from "./admin-logs-route";
import type { LogAdmission } from "./logs-authority";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getSession } }),
}));

vi.mock("@/lib/realtime-hub", () => ({
  getRealtimeHub: () => ({ acceptAdminLogs: vi.fn() }),
}));

const ORIGIN = "https://panel.example.com";
const URL = `${ORIGIN}/api/admin/servers/srv-1/logs/ws`;
const STARTED_AT = new Date("2026-11-19T00:00:00.000Z");

function request(headers: Record<string, string> = {}) {
  return new Request(URL, {
    headers: {
      origin: ORIGIN,
      upgrade: "websocket",
      "user-agent": "vitest",
      ...headers,
    },
  });
}

function adminSession(): AdminLogsAuthSession {
  return {
    session: { id: "auth-session-1", impersonatedBy: null },
    user: { id: "admin-1", email: "admin@example.com" },
  };
}

function admitted(): LogAdmission {
  return { ok: true, serverName: "edge", sessionId: "agent-session-1" };
}

function dependencies(
  overrides: Partial<AdminLogsRouteDependencies> = {},
): AdminLogsRouteDependencies {
  return {
    authenticate: vi.fn(async () => adminSession()),
    admit: vi.fn(async () => admitted()),
    accept: vi.fn(async () => new Response(null, { status: 426 })),
    recordOpen: vi.fn(async () => undefined),
    newRelayId: () => "relay-1",
    now: () => STARTED_AT,
    ...overrides,
  };
}

describe("admin log upgrade", () => {
  beforeEach(() => {
    getSession.mockReset();
  });

  it("requires a WebSocket upgrade before authenticating", async () => {
    const deps = dependencies();
    const response = await handleAdminLogsRequest(
      request({ upgrade: "" }),
      { serverId: "srv-1" },
      deps,
    );
    expect(response.status).toBe(426);
    expect(deps.authenticate).not.toHaveBeenCalled();
    expect(deps.admit).not.toHaveBeenCalled();
  });

  it("rejects cross-origin upgrades and non-admin sessions", async () => {
    const crossOrigin = await handleAdminLogsRequest(
      request({ origin: "https://attacker.example" }),
      { serverId: "srv-1" },
      dependencies(),
    );
    expect(crossOrigin.status).toBe(403);

    const forbidden = await handleAdminLogsRequest(
      request(),
      { serverId: "srv-1" },
      dependencies({ authenticate: vi.fn(async () => null) }),
    );
    expect(forbidden.status).toBe(403);
  });

  it("reads the admin session without refreshing it", async () => {
    getSession.mockResolvedValueOnce(null);

    const session = await authenticateAdminLogsSession(request());

    expect(session).toBeNull();
    expect(getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      query: { disableRefresh: true },
    });
  });

  it("rejects unknown, disabled, offline and unsupported servers", async () => {
    const missing = await handleAdminLogsRequest(
      request(),
      { serverId: "srv-1" },
      dependencies({
        admit: vi.fn(async (): Promise<LogAdmission> => ({
          ok: false,
          status: 404,
          error: "not_found",
        })),
      }),
    );
    expect(missing.status).toBe(404);

    for (const error of [
      "server_disabled",
      "offline",
      "unsupported",
    ] as const) {
      const response = await handleAdminLogsRequest(
        request(),
        { serverId: "srv-1" },
        dependencies({
          admit: vi.fn(async (): Promise<LogAdmission> => ({
            ok: false,
            status: 409,
            error,
          })),
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error });
    }
  });

  it("binds the relay to the server's current agent session and the admin session row", async () => {
    const deps = dependencies();
    const response = await handleAdminLogsRequest(
      request({ "x-forwarded-for": "203.0.113.9" }),
      { serverId: "srv-1" },
      deps,
    );

    expect(response.status).toBe(426);
    expect(deps.accept).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        serverId: "srv-1",
        serverName: "edge",
        agentSessionId: "agent-session-1",
        authSessionId: "auth-session-1",
        relayId: "relay-1",
        startedAt: STARTED_AT,
        actor: expect.objectContaining({
          id: "admin-1",
          email: "admin@example.com",
          ip: "203.0.113.9",
          userAgent: "vitest",
        }),
      }),
    );
    expect(deps.recordOpen).toHaveBeenCalledWith({
      serverId: "srv-1",
      sessionId: "agent-session-1",
      actor: expect.objectContaining({ id: "admin-1" }),
      failed: false,
    });
  });

  it("audits a refused upgrade and a failed accept", async () => {
    const refused = dependencies({
      accept: vi.fn(async () => new Response("no", { status: 503 })),
    });
    const response = await handleAdminLogsRequest(
      request(),
      { serverId: "srv-1" },
      refused,
    );
    expect(response.status).toBe(503);
    expect(refused.recordOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
        failed: true,
      }),
    );

    const failed = dependencies({
      accept: vi.fn(async () => {
        throw new Error("hub down");
      }),
    });
    const thrown = await handleAdminLogsRequest(
      request(),
      { serverId: "srv-1" },
      failed,
    );
    expect(thrown.status).toBe(503);
    expect(failed.recordOpen).toHaveBeenCalledWith(
      expect.objectContaining({ failed: true }),
    );
  });
});
