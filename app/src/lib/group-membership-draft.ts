/**
 * Draft model for the ordered group membership editor.
 *
 * The draft is the selected subscriber entrance IDs in subscription order;
 * saving sends it unchanged to `updateGroup` as `nodeIds`. The available
 * column is derived from the node list minus the draft, so a drop there is a
 * removal. Pointer drag, keyboard drag and the explicit Add/Remove/Move
 * controls all go through these functions so every input path yields the same
 * saved order.
 */

export const MEMBERSHIP_COLUMNS = ["available", "selected"] as const;

export type MembershipColumn = (typeof MEMBERSHIP_COLUMNS)[number];

export function isMembershipColumn(value: unknown): value is MembershipColumn {
  return MEMBERSHIP_COLUMNS.includes(value as MembershipColumn);
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length);
}

/** Inserts `nodeId` at `index` (default: end). A selected ID is moved. */
export function addEntrance(
  draft: readonly string[],
  nodeId: string,
  index: number = draft.length,
): string[] {
  const rest = draft.filter((id) => id !== nodeId);
  const next = [...rest];
  next.splice(clampIndex(index, rest.length), 0, nodeId);
  return next;
}

export function removeEntrance(
  draft: readonly string[],
  nodeId: string,
): string[] {
  return draft.filter((id) => id !== nodeId);
}

/** Moves a selected entrance to `index`; unknown IDs leave the draft as is. */
export function moveEntrance(
  draft: readonly string[],
  nodeId: string,
  index: number,
): string[] {
  if (!draft.includes(nodeId)) return [...draft];
  return addEntrance(draft, nodeId, index);
}

/** Move up (`-1`) / Move down (`+1`), clamped to the list bounds. */
export function shiftEntrance(
  draft: readonly string[],
  nodeId: string,
  delta: number,
): string[] {
  const from = draft.indexOf(nodeId);
  if (from === -1) return [...draft];
  return moveEntrance(draft, nodeId, from + delta);
}

export interface EntranceDrop {
  nodeId: string;
  to: MembershipColumn;
  /** Destination index within the selected column; ignored for available. */
  index: number;
}

/** Applies a completed drag (pointer or keyboard) to the draft. */
export function applyEntranceDrop(
  draft: readonly string[],
  drop: EntranceDrop,
): string[] {
  if (drop.to === "available") return removeEntrance(draft, drop.nodeId);
  return addEntrance(draft, drop.nodeId, drop.index);
}

/** Order-sensitive: a reorder-only change is a dirty draft. */
export function isMembershipDraftDirty(
  saved: readonly string[],
  draft: readonly string[],
): boolean {
  return (
    saved.length !== draft.length || saved.some((id, i) => id !== draft[i])
  );
}

export interface SelectedEntrance<T extends { id: string }> {
  /** Always the draft ID, even when the node row is gone. */
  id: string;
  /** Null for an ID the node list no longer contains (deleted meanwhile). */
  node: T | null;
}

export interface MembershipColumns<T extends { id: string }> {
  /**
   * Draft order, including IDs missing from `nodes`. A stale ID keeps its
   * position so a refetch or concurrent delete never drops it from the draft
   * without an explicit Remove.
   */
  selected: SelectedEntrance<T>[];
  /** Unselected nodes in their list order. */
  available: T[];
  /** Selected IDs with no matching node, in draft order. */
  missingIds: string[];
}

export function splitMembershipColumns<T extends { id: string }>(
  nodes: readonly T[],
  draft: readonly string[],
): MembershipColumns<T> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selectedIds = new Set(draft);
  const selected = draft.map((id) => ({ id, node: byId.get(id) ?? null }));
  return {
    selected,
    available: nodes.filter((node) => !selectedIds.has(node.id)),
    missingIds: selected.flatMap(({ id, node }) => (node ? [] : [id])),
  };
}

export interface MembershipOrderDiff {
  /** Draft IDs absent from the saved order. */
  added: string[];
  /** Saved IDs absent from the draft. */
  removed: string[];
  /** IDs in both orders whose relative position changed. */
  moved: string[];
}

/** Compares two membership orders for the stale-draft conflict panel. */
export function diffMembershipOrder(
  saved: readonly string[],
  draft: readonly string[],
): MembershipOrderDiff {
  const savedIds = new Set(saved);
  const draftIds = new Set(draft);
  const savedCommon = saved.filter((id) => draftIds.has(id));
  const draftCommon = draft.filter((id) => savedIds.has(id));
  return {
    added: draft.filter((id) => !savedIds.has(id)),
    removed: saved.filter((id) => !draftIds.has(id)),
    moved: draftCommon.filter((id, index) => savedCommon[index] !== id),
  };
}
