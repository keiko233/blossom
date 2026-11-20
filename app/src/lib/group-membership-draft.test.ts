import { describe, expect, it } from "vitest";

import {
  addEntrance,
  applyEntranceDrop,
  diffMembershipOrder,
  isMembershipColumn,
  isMembershipDraftDirty,
  moveEntrance,
  removeEntrance,
  shiftEntrance,
  splitMembershipColumns,
} from "./group-membership-draft";

describe("group membership draft", () => {
  it("adds at the end by default and at a clamped index", () => {
    expect(addEntrance(["a"], "b")).toEqual(["a", "b"]);
    expect(addEntrance(["a", "b"], "c", 1)).toEqual(["a", "c", "b"]);
    expect(addEntrance(["a"], "c", 9)).toEqual(["a", "c"]);
    expect(addEntrance(["a"], "c", -3)).toEqual(["c", "a"]);
  });

  it("never duplicates an entrance that is already selected", () => {
    expect(addEntrance(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  });

  it("removes and ignores unknown IDs", () => {
    expect(removeEntrance(["a", "b"], "a")).toEqual(["b"]);
    expect(removeEntrance(["a"], "x")).toEqual(["a"]);
    expect(moveEntrance(["a"], "x", 0)).toEqual(["a"]);
    expect(shiftEntrance(["a"], "x", 1)).toEqual(["a"]);
  });

  it("moves up and down within bounds", () => {
    expect(shiftEntrance(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(shiftEntrance(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(shiftEntrance(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(shiftEntrance(["a", "b"], "b", 1)).toEqual(["a", "b"]);
  });

  it("gives drag drops and explicit controls the same order", () => {
    const dragged = applyEntranceDrop(["a", "b", "c"], {
      nodeId: "c",
      to: "selected",
      index: 0,
    });
    const viaButtons = shiftEntrance(
      shiftEntrance(["a", "b", "c"], "c", -1),
      "c",
      -1,
    );
    expect(dragged).toEqual(["c", "a", "b"]);
    expect(viaButtons).toEqual(dragged);
  });

  it("treats drops into available as removal and into an empty list", () => {
    expect(
      applyEntranceDrop(["a", "b"], { nodeId: "a", to: "available", index: 0 }),
    ).toEqual(["b"]);
    expect(
      applyEntranceDrop([], { nodeId: "a", to: "selected", index: 0 }),
    ).toEqual(["a"]);
  });

  it("is dirty on reorder-only changes", () => {
    expect(isMembershipDraftDirty(["a", "b"], ["a", "b"])).toBe(false);
    expect(isMembershipDraftDirty(["a", "b"], ["b", "a"])).toBe(true);
    expect(isMembershipDraftDirty(["a"], ["a", "b"])).toBe(true);
  });

  it("keeps missing selected IDs in place instead of dropping them", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(splitMembershipColumns(nodes, ["c", "gone", "a"])).toEqual({
      selected: [
        { id: "c", node: { id: "c" } },
        { id: "gone", node: null },
        { id: "a", node: { id: "a" } },
      ],
      available: [{ id: "b" }],
      missingIds: ["gone"],
    });
  });

  it("compares saved and draft orders for the conflict panel", () => {
    expect(diffMembershipOrder(["a", "b", "c"], ["a", "b", "c"])).toEqual({
      added: [],
      removed: [],
      moved: [],
    });
    expect(diffMembershipOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual({
      added: [],
      removed: [],
      moved: ["c", "a", "b"],
    });
    expect(diffMembershipOrder(["a", "b"], ["b", "a", "d"])).toEqual({
      added: ["d"],
      removed: [],
      moved: ["b", "a"],
    });
    expect(diffMembershipOrder(["a", "gone", "b"], ["a", "b"])).toEqual({
      added: [],
      removed: ["gone"],
      moved: [],
    });
  });

  it("recognizes column identifiers", () => {
    expect(isMembershipColumn("selected")).toBe(true);
    expect(isMembershipColumn("a")).toBe(false);
  });
});
