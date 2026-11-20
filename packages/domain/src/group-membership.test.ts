import { describe, expect, it } from "vitest";

import {
  backfillGroupMemberPositions,
  buildEntranceOrderRanks,
  orderGatedEntrances,
  planGroupMembershipWrite,
  planNodeDeletionGroupCascade,
  reconcileCompatibilityEntranceOrder,
  validateDistinctEntranceIds,
} from "./group-membership";

describe("backfillGroupMemberPositions", () => {
  it("orders ties deterministically by stable nodeId and assigns contiguous 0..n-1 positions", () => {
    const rows = backfillGroupMemberPositions([
      { nodeId: "node-c", position: 0 },
      { nodeId: "node-a", position: 0 },
      { nodeId: "node-b", position: 0 },
    ]);
    expect(rows).toEqual([
      { nodeId: "node-a", position: 0 },
      { nodeId: "node-b", position: 1 },
      { nodeId: "node-c", position: 2 },
    ]);
  });

  it("preserves existing relative position order before breaking ties by nodeId", () => {
    const rows = backfillGroupMemberPositions([
      { nodeId: "node-z", position: 2 },
      { nodeId: "node-b", position: 5 },
      { nodeId: "node-a", position: 5 },
    ]);
    expect(rows).toEqual([
      { nodeId: "node-z", position: 0 },
      { nodeId: "node-a", position: 1 },
      { nodeId: "node-b", position: 2 },
    ]);
  });
});

describe("validateDistinctEntranceIds", () => {
  it("accepts distinct non-empty entrance IDs in exact order", () => {
    expect(validateDistinctEntranceIds(["n-2", "n-1", "n-3"])).toEqual({
      ok: true,
      nodeIds: ["n-2", "n-1", "n-3"],
    });
  });

  it("rejects duplicate and blank entrance IDs", () => {
    expect(validateDistinctEntranceIds(["n-1", " ", "n-2", "n-1"])).toEqual({
      ok: false,
      duplicateNodeIds: ["n-1"],
      emptyIndexes: [1],
    });
  });
});

describe("reconcileCompatibilityEntranceOrder", () => {
  it("retains surviving member order and appends new additions sorted by stable nodeId", () => {
    const current = [
      { nodeId: "n-c", position: 0 },
      { nodeId: "n-a", position: 1 },
      { nodeId: "n-b", position: 2 },
    ];
    // n-a is removed; n-c and n-b survive (in order n-c, n-b); n-z and n-d are added.
    const next = reconcileCompatibilityEntranceOrder(current, [
      "n-z",
      "n-b",
      "n-d",
      "n-c",
      "n-z",
    ]);
    expect(next).toEqual(["n-c", "n-b", "n-d", "n-z"]);
  });
});

describe("planGroupMembershipWrite", () => {
  it("marks pure reorders as reorder-only and skips publish-gate recording", () => {
    const result = planGroupMembershipWrite({
      currentMembers: [
        { nodeId: "n-a", position: 0 },
        { nodeId: "n-b", position: 1 },
        { nodeId: "n-c", position: 2 },
      ],
      targetNodeIds: ["n-c", "n-b", "n-a"],
      mode: "ordered",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.removedNodeIds).toEqual([]);
    expect(result.plan.insertedMembers).toEqual([]);
    expect(result.plan.unchangedMembers).toEqual([
      { nodeId: "n-b", position: 1 },
    ]);
    expect(result.plan.retainedUpdates).toEqual([
      { nodeId: "n-c", previousPosition: 2, position: 0 },
      { nodeId: "n-a", previousPosition: 0, position: 2 },
    ]);
    expect(result.plan.membershipSetChanged).toBe(false);
    expect(result.plan.isReorderOnly).toBe(true);
    expect(result.plan.hasMembershipRowChanges).toBe(true);
    expect(result.plan.requiresPublishGate).toBe(false);
    expect(result.plan.publishGateCandidateNodeIds).toEqual([]);
  });

  it("partitions removals, single-touch retained updates, unchanged rows and inserts", () => {
    const result = planGroupMembershipWrite({
      currentMembers: [
        { nodeId: "n-a", position: 0 },
        { nodeId: "n-b", position: 1 },
        { nodeId: "n-c", position: 2 },
      ],
      targetNodeIds: ["n-a", "n-d", "n-c"],
      mode: "ordered",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.removedNodeIds).toEqual(["n-b"]);
    expect(result.plan.unchangedMembers).toEqual([
      { nodeId: "n-a", position: 0 },
      { nodeId: "n-c", position: 2 },
    ]);
    expect(result.plan.retainedUpdates).toEqual([]);
    expect(result.plan.insertedMembers).toEqual([
      { nodeId: "n-d", position: 1 },
    ]);
    expect(result.plan.membershipSetChanged).toBe(true);
    expect(result.plan.isReorderOnly).toBe(false);
    expect(result.plan.requiresPublishGate).toBe(true);
    expect(result.plan.publishGateCandidateNodeIds).toEqual([
      "n-a",
      "n-b",
      "n-c",
      "n-d",
    ]);
  });

  it("supports compatibility writers by preserving surviving order and appending additions deterministically", () => {
    const result = planGroupMembershipWrite({
      currentMembers: [
        { nodeId: "n-2", position: 0 },
        { nodeId: "n-1", position: 1 },
      ],
      targetNodeIds: ["n-4", "n-1", "n-3", "n-2"],
      mode: "compatibility",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.nextNodeIds).toEqual(["n-2", "n-1", "n-3", "n-4"]);
    expect(result.plan.retainedUpdates).toEqual([]);
    expect(result.plan.insertedMembers).toEqual([
      { nodeId: "n-3", position: 2 },
      { nodeId: "n-4", position: 3 },
    ]);
    expect(result.plan.requiresPublishGate).toBe(true);
  });
});

describe("planNodeDeletionGroupCascade", () => {
  it("compacts surviving positions and increments revisions in stable groupId order", () => {
    const cascade = planNodeDeletionGroupCascade({
      deletedNodeId: "n-mid",
      groups: [
        {
          groupId: "g-beta",
          revision: 4,
          members: [
            { nodeId: "n-first", position: 0 },
            { nodeId: "n-mid", position: 1 },
            { nodeId: "n-last", position: 2 },
          ],
        },
        {
          groupId: "g-alpha",
          revision: 1,
          members: [
            { nodeId: "n-mid", position: 0 },
            { nodeId: "n-after", position: 1 },
          ],
        },
        {
          groupId: "g-untouched",
          revision: 2,
          members: [{ nodeId: "n-other", position: 0 }],
        },
      ],
    });

    expect(cascade).toEqual([
      {
        groupId: "g-alpha",
        previousRevision: 1,
        nextRevision: 2,
        removedNodeId: "n-mid",
        removedPosition: 0,
        previousNodeIds: ["n-mid", "n-after"],
        nextNodeIds: ["n-after"],
        retainedUpdates: [
          { nodeId: "n-after", previousPosition: 1, position: 0 },
        ],
      },
      {
        groupId: "g-beta",
        previousRevision: 4,
        nextRevision: 5,
        removedNodeId: "n-mid",
        removedPosition: 1,
        previousNodeIds: ["n-first", "n-mid", "n-last"],
        nextNodeIds: ["n-first", "n-last"],
        retainedUpdates: [
          { nodeId: "n-last", previousPosition: 2, position: 1 },
        ],
      },
    ]);
  });
});

describe("buildEntranceOrderRanks and orderGatedEntrances", () => {
  it("traverses groups by (sortOrder, groupId), members by (position, nodeId), and deduplicates by first occurrence", () => {
    const ranks = buildEntranceOrderRanks([
      // Second group in sort order
      { groupId: "g-b", groupSortOrder: 10, nodeId: "n-3", position: 0 },
      { groupId: "g-b", groupSortOrder: 10, nodeId: "n-1", position: 1 },
      // First group (tie on sortOrder=0 broken by groupId: g-a before g-c)
      { groupId: "g-c", groupSortOrder: 0, nodeId: "n-2", position: 0 },
      { groupId: "g-a", groupSortOrder: 0, nodeId: "n-2", position: 1 },
      { groupId: "g-a", groupSortOrder: 0, nodeId: "n-1", position: 0 },
    ]);

    // Expected traversal:
    // g-a (sortOrder 0): n-1 (pos 0), n-2 (pos 1)
    // g-c (sortOrder 0): n-2 (already seen)
    // g-b (sortOrder 10): n-3 (pos 0), n-1 (already seen)
    expect([...ranks.entries()]).toEqual([
      ["n-1", 0],
      ["n-2", 1],
      ["n-3", 2],
    ]);

    // Publish-gated visible set omits pending/disabled n-2; n-2 must not reappear.
    const gated = [{ id: "n-3" }, { id: "n-1" }, { id: "n-3" }];
    expect(orderGatedEntrances(gated, ranks, (item) => item.id)).toEqual([
      { id: "n-1" },
      { id: "n-3" },
    ]);
  });
});
