import {
  buildEntranceOrderRanks,
  orderGatedEntrances,
} from "@blossom/domain/group-membership";
import { describe, expect, it } from "vitest";

import { previewNodeSelection, type PreviewNode } from "./access-impact";

const NOW = Date.parse("2026-10-30T00:00:00Z");
const DRAFT = ["c", "a", "off", "b"];

function makeNode(
  id: string,
  options: { enabled?: boolean; active?: boolean } = {},
): PreviewNode {
  return {
    id,
    name: `entrance-${id}`,
    enabled: options.enabled ?? true,
    protocol: "vless",
    listenPort: 443,
    resolvedAddress: "proxy.example.test",
    serverSummary: {
      id: `server-${id}`,
      name: "alpha",
      enabled: true,
      lastSeenAt: new Date(NOW - 5_000),
      heartbeatIntervalSeconds: 30,
      runtimeState: "running",
      configState: "applied",
      appliedRevision: "sha256:ok",
      activeNodeIds: options.active === false ? [] : [id],
    },
  };
}

describe("group editor preview and ordered export", () => {
  it("matches the Task 02 export order for the same single group", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const preview = previewNodeSelection({
      nodeIds: DRAFT,
      nodes,
      now: NOW,
    });

    // Task 02's export path ranks current authorized membership positions.
    // A single group with the draft positions must produce the same order.
    const ranks = buildEntranceOrderRanks(
      DRAFT.filter((id) => id !== "off").map((nodeId, position) => ({
        groupId: "group-1",
        groupSortOrder: 0,
        nodeId,
        position,
      })),
    );
    const exported = orderGatedEntrances(
      preview.nodes.filter((entry) => !entry.filtered),
      ranks,
      (entry) => entry.node.id,
    );

    expect(exported.map((entry) => entry.node.id)).toEqual(["c", "a", "b"]);
    expect(preview.nodes.map((entry) => entry.node.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(preview.missingNodeIds).toEqual(["off"]);
  });

  it("keeps a disabled draft member out of the export while the preview flags it", () => {
    const preview = previewNodeSelection({
      nodeIds: ["b", "off"],
      nodes: [makeNode("b"), makeNode("off", { enabled: false })],
      now: NOW,
    });
    const ranks = buildEntranceOrderRanks([
      {
        groupId: "group-1",
        groupSortOrder: 0,
        nodeId: "b",
        position: 0,
      },
      {
        groupId: "group-1",
        groupSortOrder: 0,
        nodeId: "off",
        position: 1,
      },
    ]);
    const exported = orderGatedEntrances(
      preview.nodes.filter((entry) => !entry.filtered),
      ranks,
      (entry) => entry.node.id,
    );
    expect(preview.nodes.map((entry) => entry.node.id)).toEqual(["b", "off"]);
    expect(preview.filteredCount).toBe(1);
    expect(exported.map((entry) => entry.node.id)).toEqual(["b"]);
  });
});
