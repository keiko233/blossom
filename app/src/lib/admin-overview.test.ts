import { describe, expect, it } from "vitest";

import {
  EXPIRING_SOON_DAYS,
  getExpiringSoonCutoff,
  getQuotaUsageRatio,
  isExpiringSoon,
  isNearQuota,
  type OverviewServerInput,
  summarizeServers,
} from "./admin-overview";

const now = Date.parse("2026-07-13T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("isExpiringSoon", () => {
  it("flags dates inside the window", () => {
    expect(isExpiringSoon(new Date(now + DAY), now)).toBe(true);
    expect(isExpiringSoon(new Date(now + EXPIRING_SOON_DAYS * DAY), now)).toBe(
      true,
    );
  });

  it("ignores dates beyond the window", () => {
    expect(
      isExpiringSoon(new Date(now + EXPIRING_SOON_DAYS * DAY + 1), now),
    ).toBe(false);
  });

  it("ignores already-expired dates", () => {
    expect(isExpiringSoon(new Date(now), now)).toBe(false);
    expect(isExpiringSoon(new Date(now - DAY), now)).toBe(false);
  });

  it("accepts ISO strings and custom windows", () => {
    const iso = new Date(now + 2 * DAY).toISOString();
    expect(isExpiringSoon(iso, now, 1)).toBe(false);
    expect(isExpiringSoon(iso, now, 3)).toBe(true);
  });
});

describe("getExpiringSoonCutoff", () => {
  it("adds the window to now", () => {
    expect(getExpiringSoonCutoff(now).getTime()).toBe(
      now + EXPIRING_SOON_DAYS * DAY,
    );
  });
});

describe("quota helpers", () => {
  it("has no ratio for unlimited quotas", () => {
    expect(getQuotaUsageRatio(0, 123)).toBeNull();
    expect(isNearQuota(0, 123)).toBe(false);
  });

  it("computes the usage ratio, including over-quota", () => {
    expect(getQuotaUsageRatio(100, 25)).toBe(0.25);
    expect(getQuotaUsageRatio(100, 150)).toBe(1.5);
  });

  it("flags usage at or above the threshold", () => {
    expect(isNearQuota(100, 89)).toBe(false);
    expect(isNearQuota(100, 90)).toBe(true);
    expect(isNearQuota(100, 120)).toBe(true);
    expect(isNearQuota(100, 50, 50)).toBe(true);
  });
});

function makeServer(
  id: string,
  overrides: Partial<OverviewServerInput> = {},
): OverviewServerInput {
  return {
    id,
    name: id,
    address: `${id}.example.com`,
    enabled: true,
    lastSeenAt: new Date(now - 10_000),
    heartbeatIntervalSeconds: 30,
    runtimeState: "running",
    configState: "applied",
    appliedRevision: "1:abc",
    activeNodeIds: [],
    lastErrorMessage: null,
    ...overrides,
  };
}

describe("summarizeServers", () => {
  it("counts healthy servers as online and not needing attention", () => {
    const summary = summarizeServers(
      [makeServer("a"), makeServer("b")],
      new Map(),
      now,
    );
    expect(summary).toEqual({ total: 2, online: 2, attention: [] });
  });

  it("flags offline servers, including ones never seen", () => {
    const summary = summarizeServers(
      [
        makeServer("stale", { lastSeenAt: new Date(now - 10 * 60_000) }),
        makeServer("never", { lastSeenAt: null }),
        makeServer("ok"),
      ],
      new Map(),
      now,
    );
    expect(summary.total).toBe(3);
    expect(summary.online).toBe(1);
    expect(summary.attention.map((s) => [s.id, s.health])).toEqual([
      ["never", "agent_offline"],
      ["stale", "agent_offline"],
    ]);
  });

  it("flags online servers that still have pending config changes", () => {
    const summary = summarizeServers(
      [makeServer("pending"), makeServer("ok")],
      new Map([["pending", 3]]),
      now,
    );
    expect(summary.online).toBe(2);
    expect(summary.attention).toEqual([
      {
        id: "pending",
        name: "pending",
        address: "pending.example.com",
        health: "online",
        pendingConfigChanges: 3,
        lastErrorMessage: null,
      },
    ]);
  });

  it("never flags disabled servers, even with pending changes", () => {
    const summary = summarizeServers(
      [makeServer("off", { enabled: false, lastSeenAt: null })],
      new Map([["off", 2]]),
      now,
    );
    expect(summary).toEqual({ total: 1, online: 0, attention: [] });
  });

  it("does not flag unknown health on its own", () => {
    const summary = summarizeServers(
      [makeServer("fresh", { configState: "unknown" })],
      new Map(),
      now,
    );
    expect(summary.online).toBe(0);
    expect(summary.attention).toEqual([]);
  });

  it("orders by severity, then pending changes, then name", () => {
    const summary = summarizeServers(
      [
        makeServer("pending-1"),
        makeServer("degraded", {
          configState: "rejected",
          lastErrorMessage: "bad config",
        }),
        makeServer("runtime", { runtimeState: "crash_loop" }),
        makeServer("offline", { lastSeenAt: null }),
        makeServer("pending-5"),
      ],
      new Map([
        ["pending-1", 1],
        ["pending-5", 5],
      ]),
      now,
    );
    expect(summary.attention.map((s) => s.id)).toEqual([
      "offline",
      "runtime",
      "degraded",
      "pending-5",
      "pending-1",
    ]);
    expect(summary.attention[2]?.lastErrorMessage).toBe("bad config");
  });
});
