import { describe, expect, it } from "vitest";

import {
  deriveEntranceStatus,
  filterAvailableEntrances,
  listEntranceProtocols,
  membershipDisplayColumns,
} from "./group-entrance-filter";

const NOW = Date.parse("2026-10-30T00:00:00Z");

function makeNode(
  id: string,
  overrides: {
    name?: string;
    protocol?: string;
    enabled?: boolean;
    serverName?: string;
    serverEnabled?: boolean;
    active?: boolean;
    lastSeenSecondsAgo?: number | null;
    configState?: string;
    runtimeState?: string;
  } = {},
) {
  return {
    id,
    name: overrides.name ?? `inbound-${id}`,
    protocol: overrides.protocol ?? "vless",
    enabled: overrides.enabled ?? true,
    serverSummary: {
      id: `server-${id}`,
      name: overrides.serverName ?? "alpha",
      enabled: overrides.serverEnabled ?? true,
      lastSeenAt:
        overrides.lastSeenSecondsAgo === null
          ? null
          : new Date(NOW - (overrides.lastSeenSecondsAgo ?? 5) * 1000),
      heartbeatIntervalSeconds: 30,
      runtimeState: overrides.runtimeState ?? "running",
      configState: overrides.configState ?? "applied",
      appliedRevision: "sha256:ok",
      activeNodeIds: overrides.active === false ? [] : [id],
    },
  };
}

describe("group entrance readiness", () => {
  it("treats disabled nodes and servers as withheld", () => {
    expect(
      deriveEntranceStatus(makeNode("off", { enabled: false }), NOW),
    ).toMatchObject({ health: "disabled", readiness: "withheld" });
    expect(
      deriveEntranceStatus(makeNode("srv", { serverEnabled: false }), NOW),
    ).toMatchObject({ health: "server_disabled", readiness: "withheld" });
  });

  it("only calls an applied node ready and never claims reachability", () => {
    expect(deriveEntranceStatus(makeNode("serving"), NOW)).toMatchObject({
      health: "serving",
      readiness: "ready",
      publication: "applied",
    });
    expect(
      deriveEntranceStatus(makeNode("idle", { active: false }), NOW),
    ).toMatchObject({ health: "idle", readiness: "pending" });
    expect(
      deriveEntranceStatus(
        makeNode("rejected", { active: false, configState: "rejected" }),
        NOW,
      ),
    ).toMatchObject({ health: "config_error", readiness: "pending" });
  });

  it("reports an offline or unconfirmed report instead of guessing", () => {
    expect(
      deriveEntranceStatus(
        makeNode("offline", { lastSeenSecondsAgo: 3600 }),
        NOW,
      ),
    ).toMatchObject({
      health: "agent_offline",
      readiness: "pending",
      publication: "unconfirmed",
    });
  });
});

describe("available entrance filters", () => {
  const nodes = [
    makeNode("a", { name: "Tokyo edge", serverName: "alpha" }),
    makeNode("b", {
      name: "Osaka backup",
      serverName: "beta",
      protocol: "trojan",
    }),
    makeNode("c", { name: "Retired edge", enabled: false }),
    makeNode("d", { name: "Idle edge", active: false }),
    makeNode("e", { name: "Offline edge", lastSeenSecondsAgo: 3600 }),
  ];

  it("matches a node name or its server name, ignoring case and spacing", () => {
    expect(
      filterAvailableEntrances(nodes, [], { query: "  TOKYO " }, NOW).map(
        (node) => node.id,
      ),
    ).toEqual(["a"]);
    expect(
      filterAvailableEntrances(nodes, [], { query: "BETA" }, NOW).map(
        (node) => node.id,
      ),
    ).toEqual(["b"]);
  });

  it("filters by protocol and readiness without hiding selected IDs", () => {
    expect(
      filterAvailableEntrances(nodes, ["a"], { protocol: "trojan" }, NOW).map(
        (node) => node.id,
      ),
    ).toEqual(["b"]);
    expect(
      filterAvailableEntrances(nodes, ["a"], { readiness: "ready" }, NOW).map(
        (node) => node.id,
      ),
    ).toEqual(["b"]);
    expect(
      filterAvailableEntrances(
        nodes,
        ["a"],
        { readiness: "withheld" },
        NOW,
      ).map((node) => node.id),
    ).toEqual(["c"]);
    expect(
      filterAvailableEntrances(nodes, ["a"], { readiness: "pending" }, NOW).map(
        (node) => node.id,
      ),
    ).toEqual(["d", "e"]);
  });

  it("feeds dnd-kit exactly the displayed filtered available ids", () => {
    const display = membershipDisplayColumns(
      nodes,
      ["a", "gone"],
      { query: "osaka" },
      NOW,
    );
    expect(display.columnIds).toEqual({
      available: ["b"],
      selected: ["a", "gone"],
    });
    expect(display.available.map((node) => node.id)).toEqual(["b"]);
    expect(display.selected.map((entry) => entry.id)).toEqual(["a", "gone"]);
    expect(display.missingIds).toEqual(["gone"]);
  });

  it("lists protocols from the full list in stable order", () => {
    expect(listEntranceProtocols(nodes)).toEqual(["trojan", "vless"]);
  });
});
