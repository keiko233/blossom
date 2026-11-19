import { describe, expect, it } from "vitest";

import {
  isPtyAuthorized,
  type PtyAuthorizationRecord,
  ptyAvailability,
  type PtyServerRecord,
} from "./pty-authorization";

const CONNECTED_AT = new Date("2026-11-19T00:00:00.000Z");
const NOW = new Date("2026-11-19T01:00:00.000Z");

function server(overrides: Partial<PtyServerRecord> = {}): PtyServerRecord {
  return {
    enabled: true,
    transportMode: "ws",
    wsConnectedAt: CONNECTED_AT,
    agentCapabilities: ["pty-v1"],
    ...overrides,
  };
}

function record(
  overrides: Partial<PtyAuthorizationRecord> = {},
): PtyAuthorizationRecord {
  return {
    sessionUserId: "admin-1",
    sessionExpiresAt: new Date("2026-11-20T00:00:00.000Z"),
    role: "admin",
    server: server(),
    ...overrides,
  };
}

const expected = {
  userId: "admin-1",
  serverConnectedAt: CONNECTED_AT.toISOString(),
  now: NOW,
};

describe("ptyAvailability", () => {
  it("reports each reason a server cannot host a terminal", () => {
    expect(ptyAvailability(server())).toBeNull();
    expect(ptyAvailability(server({ enabled: false }))).toBe("disabled");
    expect(ptyAvailability(server({ transportMode: "http" }))).toBe("offline");
    expect(ptyAvailability(server({ wsConnectedAt: null }))).toBe("offline");
    expect(ptyAvailability(server({ agentCapabilities: ["ws-v1"] }))).toBe(
      "unsupported",
    );
  });
});

describe("isPtyAuthorized", () => {
  it("keeps a shell whose session, role, server and agent connection still hold", () => {
    expect(isPtyAuthorized(record(), expected)).toBe(true);
  });

  it("revokes a missing or expired admin session", () => {
    expect(
      isPtyAuthorized(
        record({ sessionUserId: null, sessionExpiresAt: null }),
        expected,
      ),
    ).toBe(false);
    expect(
      isPtyAuthorized(
        record({ sessionExpiresAt: new Date(NOW.getTime()) }),
        expected,
      ),
    ).toBe(false);
    expect(
      isPtyAuthorized(
        record({ sessionExpiresAt: new Date(NOW.getTime() - 1) }),
        expected,
      ),
    ).toBe(false);
    expect(
      isPtyAuthorized(
        record({ sessionExpiresAt: new Date(NOW.getTime() + 1) }),
        expected,
      ),
    ).toBe(true);
  });

  it("revokes a session that now belongs to someone else", () => {
    expect(isPtyAuthorized(record({ sessionUserId: "user-2" }), expected)).toBe(
      false,
    );
  });

  it("revokes when the user has lost the admin role", () => {
    expect(isPtyAuthorized(record({ role: "user" }), expected)).toBe(false);
    expect(isPtyAuthorized(record({ role: null }), expected)).toBe(false);
  });

  it("revokes when the server is disabled, offline or no longer advertises PTY", () => {
    expect(
      isPtyAuthorized(record({ server: server({ enabled: false }) }), expected),
    ).toBe(false);
    expect(
      isPtyAuthorized(
        record({ server: server({ transportMode: "http" }) }),
        expected,
      ),
    ).toBe(false);
    expect(
      isPtyAuthorized(
        record({ server: server({ agentCapabilities: [] }) }),
        expected,
      ),
    ).toBe(false);
  });

  it("revokes a shell whose server row is gone", () => {
    expect(isPtyAuthorized(record({ server: null }), expected)).toBe(false);
  });

  it("revokes a shell after the agent reconnected on a new connection", () => {
    expect(
      isPtyAuthorized(
        record({
          server: server({ wsConnectedAt: new Date("2026-11-19T00:00:01Z") }),
        }),
        expected,
      ),
    ).toBe(false);
  });
});
