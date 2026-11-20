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

export interface MembershipColumns<T extends { id: string }> {
  /** Draft order. IDs missing from `nodes` (deleted meanwhile) are dropped. */
  selected: T[];
  /** Unselected nodes in their list order. */
  available: T[];
}

export function splitMembershipColumns<T extends { id: string }>(
  nodes: readonly T[],
  draft: readonly string[],
): MembershipColumns<T> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selectedIds = new Set(draft);
  return {
    selected: draft.flatMap((id) => byId.get(id) ?? []),
    available: nodes.filter((node) => !selectedIds.has(node.id)),
  };
}
