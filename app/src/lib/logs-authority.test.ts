import { describe, expect, it } from "vitest";

import {
  admitLogRelay,
  revalidateLogRelay,
  type LogAuthorityServer,
  type LogAuthorityStore,
} from "./logs-authority";

const NOW = new Date("2026-11-19T00:00:00.000Z");

function server(
  overrides: Partial<LogAuthorityServer> & { id: string },
): LogAuthorityServer {
  return {
    name: overrides.id,
    enabled: true,
    transportMode: "ws",
    wsSessionId: `${overrides.id}-session`,
    agentCapabilities: ["logs-tail-v1", "logs-search-v1"],
    ...overrides,
  };
}

function store(input: {
  servers?: LogAuthorityServer[];
  sessions?: Record<string, { userId: string; role: string | null }>;
}) {
  const servers = new Map(
    (input.servers ?? []).map((row) => [row.id, { ...row }]),
  );
  const sessions = new Map(Object.entries(input.sessions ?? {}));
  const seen: { session: string; now: Date }[] = [];
  const authority: LogAuthorityStore = {
    async loadAdminSession(authSessionId, now) {
      seen.push({ session: authSessionId, now });
      return sessions.get(authSessionId) ?? null;
    },
    async loadServer(serverId) {
      const row = servers.get(serverId);
      return row ? { ...row } : null;
    },
  };
  return { authority, servers, sessions, seen };
}

const admin = { admin: { userId: "u-1", role: "admin" } };

describe("admitLogRelay", () => {
  it("binds to the server's current agent session", async () => {
    const { authority } = store({ servers: [server({ id: "srv-1" })] });
    expect(await admitLogRelay(authority, "srv-1")).toEqual({
      ok: true,
      serverName: "srv-1",
      sessionId: "srv-1-session",
    });
  });

  it("refuses an unknown server with not_found", async () => {
    const { authority } = store({});
    expect(await admitLogRelay(authority, "missing")).toEqual({
      ok: false,
      status: 404,
      error: "not_found",
    });
  });

  it("refuses a disabled server, and an offline one with no live session", async () => {
    const { authority } = store({
      servers: [
        server({ id: "off", enabled: false }),
        server({ id: "http", transportMode: "http" }),
        server({ id: "nosession", wsSessionId: null }),
      ],
    });
    expect(await admitLogRelay(authority, "off")).toMatchObject({
      status: 409,
      error: "server_disabled",
    });
    expect(await admitLogRelay(authority, "http")).toMatchObject({
      status: 409,
      error: "offline",
    });
    expect(await admitLogRelay(authority, "nosession")).toMatchObject({
      status: 409,
      error: "offline",
    });
  });

  it("does not open a relay for an agent without a log capability", async () => {
    const { authority } = store({
      servers: [
        server({ id: "legacy", agentCapabilities: ["pty-v1", "telemetry-v1"] }),
      ],
    });
    expect(await admitLogRelay(authority, "legacy")).toEqual({
      ok: false,
      status: 409,
      error: "unsupported",
    });
  });

  it("admits an agent that advertises either log capability", async () => {
    const { authority } = store({
      servers: [
        server({ id: "tail", agentCapabilities: ["logs-tail-v1"] }),
        server({ id: "search", agentCapabilities: ["logs-search-v1"] }),
      ],
    });
    expect((await admitLogRelay(authority, "tail")).ok).toBe(true);
    expect((await admitLogRelay(authority, "search")).ok).toBe(true);
  });

  it("never returns another server's session", async () => {
    const { authority } = store({
      servers: [server({ id: "srv-1" }), server({ id: "srv-2" })],
    });
    const admission = await admitLogRelay(authority, "srv-2");
    expect(admission).toMatchObject({ sessionId: "srv-2-session" });
    expect(JSON.stringify(admission)).not.toContain("srv-1");
  });
});

describe("revalidateLogRelay", () => {
  const input = {
    serverId: "srv-1",
    sessionId: "srv-1-session",
    authSessionId: "auth-1",
    now: NOW,
  };

  it("lets a relay continue while the admin, server and session all still hold", async () => {
    const { authority, seen } = store({
      servers: [server({ id: "srv-1" })],
      sessions: { "auth-1": admin.admin },
    });
    expect(await revalidateLogRelay(authority, input)).toBeNull();
    expect(seen).toEqual([{ session: "auth-1", now: NOW }]);
  });

  it("ends the relay when the admin session is missing, expired or no longer admin", async () => {
    const missing = store({ servers: [server({ id: "srv-1" })] });
    expect(await revalidateLogRelay(missing.authority, input)).toBe(
      "forbidden",
    );

    const demoted = store({
      servers: [server({ id: "srv-1" })],
      sessions: { "auth-1": { userId: "u-1", role: "user" } },
    });
    expect(await revalidateLogRelay(demoted.authority, input)).toBe(
      "forbidden",
    );
  });

  it("ends the relay when the server is disabled, deleted, or its agent goes offline", async () => {
    const disabled = store({
      servers: [server({ id: "srv-1", enabled: false })],
      sessions: { "auth-1": admin.admin },
    });
    expect(await revalidateLogRelay(disabled.authority, input)).toBe(
      "server_disabled",
    );

    const deleted = store({ sessions: { "auth-1": admin.admin } });
    expect(await revalidateLogRelay(deleted.authority, input)).toBe(
      "forbidden",
    );

    const offline = store({
      servers: [
        server({ id: "srv-1", transportMode: "http", wsSessionId: null }),
      ],
      sessions: { "auth-1": admin.admin },
    });
    expect(await revalidateLogRelay(offline.authority, input)).toBe("offline");
  });

  it("ends a relay whose agent session was replaced by a newer one", async () => {
    const { authority } = store({
      servers: [server({ id: "srv-1", wsSessionId: "srv-1-newer" })],
      sessions: { "auth-1": admin.admin },
    });
    expect(await revalidateLogRelay(authority, input)).toBe("session_replaced");
  });

  it("ends a relay when the agent drops its log capability", async () => {
    const { authority } = store({
      servers: [server({ id: "srv-1", agentCapabilities: ["pty-v1"] })],
      sessions: { "auth-1": admin.admin },
    });
    expect(await revalidateLogRelay(authority, input)).toBe("unsupported");
  });

  it("checks the admin before the server, so a revoked admin ends the relay first", async () => {
    const { authority } = store({
      servers: [server({ id: "srv-1", enabled: false })],
    });
    expect(await revalidateLogRelay(authority, input)).toBe("forbidden");
  });

  it("isolates servers: a relay on one server is not affected by another server's change", async () => {
    const { authority, servers } = store({
      servers: [server({ id: "srv-1" }), server({ id: "srv-2" })],
      sessions: { "auth-1": admin.admin },
    });
    servers.set("srv-2", { ...servers.get("srv-2")!, enabled: false });
    expect(await revalidateLogRelay(authority, input)).toBeNull();
  });
});
