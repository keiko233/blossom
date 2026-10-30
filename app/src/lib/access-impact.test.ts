import { describe, expect, it } from "vitest";

import {
  changedSnapshotFields,
  diffEffectiveNodes,
  diffSelection,
  distributableCount,
  isGroupUnused,
  type PlanImpact,
  planDeleteBlockers,
  type PreviewGroup,
  type PreviewNode,
  previewEffectiveNodes,
  previewNodeSelection,
  snapshotDrift,
  summarizeGroupImpact,
} from "./access-impact";

const NOW = Date.parse("2026-10-30T00:00:00Z");

function makeNode(
  id: string,
  overrides: {
    enabled?: boolean;
    serverEnabled?: boolean;
    serverName?: string;
    lastSeenSecondsAgo?: number | null;
    active?: boolean;
    configState?: string;
    runtimeState?: string;
    name?: string;
  } = {},
): PreviewNode {
  return {
    id,
    name: overrides.name ?? `node-${id}`,
    enabled: overrides.enabled ?? true,
    protocol: "vless",
    listenPort: 443,
    resolvedAddress: "proxy.example.test",
    serverSummary: {
      id: `srv-${id}`,
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

const group = (id: string, nodeIds: string[]): PreviewGroup => ({
  id,
  name: `group-${id}`,
  nodeIds,
});

describe("previewEffectiveNodes", () => {
  it("returns the union of nodes across groups with each node once", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const groups = [group("g1", ["a", "b"]), group("g2", ["b", "c"])];

    const preview = previewEffectiveNodes({
      groupIds: ["g1", "g2"],
      groups,
      nodes,
      now: NOW,
    });

    expect(preview.nodes.map((entry) => entry.node.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    const shared = preview.nodes.find((entry) => entry.node.id === "b");
    expect(shared?.groupIds).toEqual(["g1", "g2"]);
    expect(preview.nodes.find((e) => e.node.id === "a")?.groupIds).toEqual([
      "g1",
    ]);
  });

  it("ignores repeated group selections and repeated members", () => {
    const preview = previewEffectiveNodes({
      groupIds: ["g1", "g1"],
      groups: [group("g1", ["a", "a"])],
      nodes: [makeNode("a")],
      now: NOW,
    });
    expect(preview.nodes).toHaveLength(1);
    expect(preview.nodes[0]?.groupIds).toEqual(["g1"]);
  });

  it("marks disabled nodes and disabled servers as filtered, not usable", () => {
    const nodes = [
      makeNode("on"),
      makeNode("off", { enabled: false }),
      makeNode("srv-off", { serverEnabled: false }),
    ];
    const preview = previewEffectiveNodes({
      groupIds: ["g"],
      groups: [group("g", ["on", "off", "srv-off"])],
      nodes,
      now: NOW,
    });

    const byId = Object.fromEntries(
      preview.nodes.map((entry) => [entry.node.id, entry]),
    );
    expect(byId["on"]?.filtered).toBe(false);
    expect(byId["off"]).toMatchObject({ filtered: true, health: "disabled" });
    expect(byId["srv-off"]).toMatchObject({
      filtered: true,
      health: "server_disabled",
    });
    expect(preview.filteredCount).toBe(2);
    expect(distributableCount(preview)).toBe(1);
  });

  it("does not treat a heartbeat as proof the node works", () => {
    const nodes = [
      makeNode("serving"),
      makeNode("offline", { lastSeenSecondsAgo: 3600 }),
      makeNode("never", { lastSeenSecondsAgo: null }),
      makeNode("crashed", { runtimeState: "crash_loop" }),
      makeNode("rejected", { configState: "rejected", active: false }),
    ];
    const preview = previewEffectiveNodes({
      groupIds: ["g"],
      groups: [
        group(
          "g",
          nodes.map((node) => node.id),
        ),
      ],
      nodes,
      now: NOW,
    });
    const health = Object.fromEntries(
      preview.nodes.map((entry) => [entry.node.id, entry.health]),
    );
    expect(health).toEqual({
      serving: "serving",
      offline: "agent_offline",
      never: "agent_offline",
      crashed: "runtime_error",
      rejected: "config_error",
    });
    // Only the serving node is settled; the other four need a look.
    expect(preview.needsAttentionCount).toBe(4);
  });

  it("counts an idle node on a healthy agent as settled", () => {
    const preview = previewEffectiveNodes({
      groupIds: ["g"],
      groups: [group("g", ["a"])],
      nodes: [makeNode("a", { active: false })],
      now: NOW,
    });
    expect(preview.nodes[0]?.health).toBe("idle");
    expect(preview.needsAttentionCount).toBe(0);
  });

  it("reports members with no node and groups that do not exist", () => {
    const preview = previewEffectiveNodes({
      groupIds: ["g", "gone"],
      groups: [group("g", ["a", "ghost", "ghost"]), group("empty", [])],
      nodes: [makeNode("a")],
      now: NOW,
    });
    expect(preview.nodes.map((entry) => entry.node.id)).toEqual(["a"]);
    expect(preview.missingNodeIds).toEqual(["ghost"]);
    expect(preview.unknownGroupIds).toEqual(["gone"]);
  });

  it("flags selected groups that hold no nodes", () => {
    const preview = previewEffectiveNodes({
      groupIds: ["empty", "g"],
      groups: [group("empty", []), group("g", ["a"])],
      nodes: [makeNode("a")],
      now: NOW,
    });
    expect(preview.emptyGroupIds).toEqual(["empty"]);
  });

  it("resolves to nothing for no groups and for only-empty groups", () => {
    const none = previewEffectiveNodes({
      groupIds: [],
      groups: [group("g", ["a"])],
      nodes: [makeNode("a")],
      now: NOW,
    });
    expect(none.nodes).toEqual([]);
    expect(distributableCount(none)).toBe(0);

    const onlyEmpty = previewEffectiveNodes({
      groupIds: ["e"],
      groups: [group("e", [])],
      nodes: [makeNode("a")],
      now: NOW,
    });
    expect(onlyEmpty.nodes).toEqual([]);
  });

  it("orders nodes deterministically by server, name and id", () => {
    const nodes = [
      makeNode("3", { serverName: "beta", name: "z" }),
      makeNode("2", { serverName: "alpha", name: "b" }),
      makeNode("1", { serverName: "alpha", name: "a" }),
    ];
    const ids = ["3", "2", "1"];
    const forward = previewEffectiveNodes({
      groupIds: ["g"],
      groups: [group("g", ids)],
      nodes,
      now: NOW,
    });
    const reversed = previewEffectiveNodes({
      groupIds: ["g"],
      groups: [group("g", [...ids].reverse())],
      nodes: [...nodes].reverse(),
      now: NOW,
    });
    expect(forward.nodes.map((e) => e.node.id)).toEqual(["1", "2", "3"]);
    expect(reversed.nodes.map((e) => e.node.id)).toEqual(["1", "2", "3"]);
  });
});

describe("previewNodeSelection", () => {
  it("previews directly selected nodes with the same state rules", () => {
    const preview = previewNodeSelection({
      nodeIds: ["a", "off", "a", "ghost"],
      nodes: [makeNode("a"), makeNode("off", { enabled: false })],
      now: NOW,
    });
    expect(preview.nodes.map((entry) => entry.node.id)).toEqual(["a", "off"]);
    expect(preview.nodes[0]?.groupIds).toEqual([]);
    expect(preview.filteredCount).toBe(1);
    expect(preview.missingNodeIds).toEqual(["ghost"]);
  });
});

describe("diffSelection", () => {
  it("reports added and removed ids regardless of order", () => {
    expect(diffSelection(["a", "b"], ["b", "c", "c"])).toEqual({
      added: ["c"],
      removed: ["a"],
    });
    expect(diffSelection(["a", "b"], ["b", "a"])).toEqual({
      added: [],
      removed: [],
    });
  });
});

describe("diffEffectiveNodes", () => {
  const groups = [
    group("g1", ["a", "b"]),
    group("g2", ["b", "c"]),
    group("g3", ["d"]),
  ];

  it("reports the nodes a plan gains or loses", () => {
    expect(
      diffEffectiveNodes({
        beforeGroupIds: ["g1"],
        afterGroupIds: ["g3"],
        groups,
      }),
    ).toEqual({ added: ["d"], removed: ["a", "b"] });
  });

  it("keeps a node that is still reachable through another group", () => {
    expect(
      diffEffectiveNodes({
        beforeGroupIds: ["g1", "g2"],
        afterGroupIds: ["g2"],
        groups,
      }),
    ).toEqual({ added: [], removed: ["a"] });
  });

  it("ignores groups that no longer exist", () => {
    expect(
      diffEffectiveNodes({
        beforeGroupIds: ["gone"],
        afterGroupIds: ["g3"],
        groups,
      }),
    ).toEqual({ added: ["d"], removed: [] });
  });
});

describe("plan snapshots", () => {
  const saved = { trafficBytes: 100, deviceLimit: 3, durationDays: 30 };

  it("lists the snapshotted fields an edit changes", () => {
    expect(changedSnapshotFields(saved, saved)).toEqual([]);
    expect(
      changedSnapshotFields(saved, {
        trafficBytes: 200,
        deviceLimit: 3,
        durationDays: 90,
      }),
    ).toEqual(["traffic", "duration"]);
    expect(changedSnapshotFields(saved, { ...saved, deviceLimit: 0 })).toEqual([
      "devices",
    ]);
  });

  it("detects a subscription that no longer matches its plan", () => {
    const plan = { trafficBytes: 100, deviceLimit: 3 };
    expect(
      snapshotDrift({ trafficQuotaBytes: 100, deviceLimit: 3 }, plan),
    ).toEqual({ traffic: false, devices: false });
    expect(
      snapshotDrift({ trafficQuotaBytes: 50, deviceLimit: 5 }, plan),
    ).toEqual({ traffic: true, devices: true });
    // Unlimited (0) is a value like any other, not "matches everything".
    expect(
      snapshotDrift({ trafficQuotaBytes: 0, deviceLimit: 3 }, plan),
    ).toEqual({ traffic: true, devices: false });
  });
});

describe("planDeleteBlockers", () => {
  const free: PlanImpact = {
    subscriptionCount: 0,
    activeSubscriptionCount: 0,
    redeemBatchCount: 0,
    isTrialPlan: false,
  };

  it("allows deleting a plan nothing refers to", () => {
    expect(planDeleteBlockers(free)).toEqual([]);
  });

  it("lists every blocker in the order the server checks them", () => {
    expect(
      planDeleteBlockers({
        subscriptionCount: 2,
        activeSubscriptionCount: 1,
        redeemBatchCount: 1,
        isTrialPlan: true,
      }),
    ).toEqual(["trial", "subscriptions", "redeem_batches"]);
    expect(planDeleteBlockers({ ...free, redeemBatchCount: 4 })).toEqual([
      "redeem_batches",
    ]);
  });

  it("counts expired subscriptions as blocking even with none active", () => {
    expect(
      planDeleteBlockers({
        ...free,
        subscriptionCount: 3,
        activeSubscriptionCount: 0,
      }),
    ).toEqual(["subscriptions"]);
  });
});

describe("summarizeGroupImpact", () => {
  it("totals subscriptions across the plans that use the group", () => {
    const impact = summarizeGroupImpact([
      { id: "p1", name: "Basic", subscriptionCount: 4 },
      { id: "p2", name: "Pro", subscriptionCount: 0 },
    ]);
    expect(impact.subscriptionCount).toBe(4);
    expect(isGroupUnused(impact)).toBe(false);
  });

  it("treats a group with no plans as unused", () => {
    const impact = summarizeGroupImpact([]);
    expect(impact.subscriptionCount).toBe(0);
    expect(isGroupUnused(impact)).toBe(true);
  });
});
