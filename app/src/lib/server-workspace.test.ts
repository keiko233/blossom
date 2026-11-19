import { describe, expect, it } from "vitest";

import {
  filterServersByQuery,
  nextServerListIndex,
  serverWorkspaceStatus,
} from "./server-workspace";

const NOW = Date.parse("2026-11-19T12:00:00Z");

const base = {
  enabled: true,
  lastSeenAt: new Date(NOW - 5_000),
  heartbeatIntervalSeconds: 30,
  runtimeState: "running",
  configState: "applied",
  appliedRevision: "rev-1",
  activeNodeIds: [],
};

describe("serverWorkspaceStatus", () => {
  it("reports a disabled server as disabled, even if it never reported", () => {
    expect(
      serverWorkspaceStatus({ ...base, enabled: false, lastSeenAt: null }, NOW),
    ).toBe("disabled");
  });

  it("reports a server that never sent a heartbeat as awaiting installation", () => {
    expect(serverWorkspaceStatus({ ...base, lastSeenAt: null }, NOW)).toBe(
      "awaiting_installation",
    );
  });

  it("reports a server whose last heartbeat is stale as offline", () => {
    expect(
      serverWorkspaceStatus(
        { ...base, lastSeenAt: new Date(NOW - 10 * 60_000) },
        NOW,
      ),
    ).toBe("agent_offline");
  });

  it("delegates reachable servers to the agent-health verdict", () => {
    expect(serverWorkspaceStatus(base, NOW)).toBe("online");
    expect(
      serverWorkspaceStatus({ ...base, runtimeState: "crash_loop" }, NOW),
    ).toBe("runtime_error");
  });
});

describe("filterServersByQuery", () => {
  const servers = [
    { name: "us-west-01", address: "203.0.113.10", remark: "Oregon edge" },
    { name: "eu-central-02", address: "eu.example.net", remark: null },
    { name: "asia-03", address: "198.51.100.7", remark: "Tokyo" },
  ];

  it("returns every server in order for a blank query", () => {
    expect(filterServersByQuery(servers, "  ")).toEqual(servers);
    expect(filterServersByQuery(servers, "")).not.toBe(servers);
  });

  it("matches name, address and remark case-insensitively", () => {
    expect(filterServersByQuery(servers, "US-WEST").map((s) => s.name)).toEqual(
      ["us-west-01"],
    );
    expect(
      filterServersByQuery(servers, "eu.example").map((s) => s.name),
    ).toEqual(["eu-central-02"]);
    expect(filterServersByQuery(servers, "tokyo").map((s) => s.name)).toEqual([
      "asia-03",
    ]);
  });

  it("tolerates a missing remark", () => {
    expect(filterServersByQuery(servers, "central")).toHaveLength(1);
    expect(filterServersByQuery(servers, "nothing-matches")).toEqual([]);
  });
});

describe("nextServerListIndex", () => {
  it("returns null for keys that are not list navigation", () => {
    expect(nextServerListIndex("Enter", 0, 3)).toBeNull();
    expect(nextServerListIndex("a", 1, 3)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(nextServerListIndex("ArrowDown", -1, 0)).toBeNull();
    expect(nextServerListIndex("End", -1, 0)).toBeNull();
  });

  it("enters at the top with ArrowDown and at the bottom with ArrowUp", () => {
    expect(nextServerListIndex("ArrowDown", -1, 3)).toBe(0);
    expect(nextServerListIndex("ArrowUp", -1, 3)).toBe(2);
  });

  it("clamps at both ends instead of wrapping", () => {
    expect(nextServerListIndex("ArrowDown", 1, 3)).toBe(2);
    expect(nextServerListIndex("ArrowDown", 2, 3)).toBe(2);
    expect(nextServerListIndex("ArrowUp", 1, 3)).toBe(0);
    expect(nextServerListIndex("ArrowUp", 0, 3)).toBe(0);
  });

  it("jumps to the first and last entries with Home and End", () => {
    expect(nextServerListIndex("Home", 2, 3)).toBe(0);
    expect(nextServerListIndex("End", 0, 3)).toBe(2);
  });
});
