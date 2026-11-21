/**
 * Pure domain rules for ordered group-to-entrance (`node_group`) memberships,
 * single-touch write planning, compatibility writer reconciliation, node-delete
 * membership cascades, and subscription entrance ordering across overlapping
 * groups.
 */

export type GroupMembershipWriteMode = "ordered" | "compatibility";

export interface GroupMemberPosition {
  nodeId: string;
  position: number;
}

export interface GroupMembershipRetainedUpdate {
  nodeId: string;
  previousPosition: number;
  position: number;
}

export interface GroupMembershipWritePlan {
  /**
   * Prior ordered node IDs (`position ASC, nodeId ASC`), suitable for
   * publish-gate `prevRow: { nodeIds: previousNodeIds }`.
   */
  previousNodeIds: string[];
  /** Target ordered node IDs (`0..n-1`). */
  nextNodeIds: string[];
  /** Target `(nodeId, position)` pairs (`0..n-1`). */
  nextMembers: GroupMemberPosition[];
  /** Distinct `nodeId`s removed from the group (`DELETE` set). */
  removedNodeIds: string[];
  /**
   * Retained `nodeId`s whose `position` changed (`UPDATE` set).
   * Each membership row is updated at most once.
   */
  retainedUpdates: GroupMembershipRetainedUpdate[];
  /** Retained `nodeId`s whose `position` is unchanged (no row write needed). */
  unchangedMembers: GroupMemberPosition[];
  /** Newly added `(nodeId, position)` rows (`INSERT` set). */
  insertedMembers: GroupMemberPosition[];
  /** True when the set of member `nodeId`s changed (additions or removals). */
  membershipSetChanged: boolean;
  /** True when at least one position changed while the member set stayed identical. */
  isReorderOnly: boolean;
  /** True when any `DELETE`, `UPDATE`, or `INSERT` on `node_group` is required. */
  hasMembershipRowChanges: boolean;
  /**
   * True when the mutation must record an `"authorization"` publish-gate
   * `config_change` and bump affected servers' `desiredRevisionSeq`.
   * Reorder-only changes (`isReorderOnly === true`) change client output order
   * only and must not record a publish-gate change or trigger agent apply.
   */
  requiresPublishGate: boolean;
  /**
   * Union of `previousNodeIds` and `nextNodeIds` in deterministic order, used
   * to resolve affected servers when `requiresPublishGate` is true.
   */
  publishGateCandidateNodeIds: string[];
}

export type ValidateDistinctEntrancesResult =
  | {
      ok: true;
      nodeIds: string[];
    }
  | {
      ok: false;
      duplicateNodeIds: string[];
      emptyIndexes: number[];
    };

export type PlanGroupMembershipWriteResult =
  | {
      ok: true;
      plan: GroupMembershipWritePlan;
    }
  | {
      ok: false;
      duplicateNodeIds: string[];
      emptyIndexes: number[];
    };

export interface GroupCascadeMembershipSnapshot {
  groupId: string;
  revision: number;
  members: readonly GroupMemberPosition[];
}

export interface AffectedGroupCascadePlan {
  groupId: string;
  previousRevision: number;
  nextRevision: number;
  removedNodeId: string;
  removedPosition: number;
  previousNodeIds: string[];
  nextNodeIds: string[];
  retainedUpdates: GroupMembershipRetainedUpdate[];
}

export interface GroupMembershipRankRow {
  groupId: string;
  groupSortOrder: number;
  nodeId: string;
  position: number;
}

/**
 * Deterministic locale-independent string comparison matching PostgreSQL C/byte
 * ordering for UUID/text identifiers used as tie-breakers.
 */
export function compareStableIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sorts membership rows by stored `position ASC` with stable `nodeId ASC` as
 * the final tie-breaker, deduplicating any repeated `nodeId` by first occurrence
 * while preserving each surviving row's stored `position`.
 */
export function sortGroupMembersByPosition(
  members: readonly GroupMemberPosition[],
): GroupMemberPosition[] {
  const sorted = [...members].sort(
    (a, b) => a.position - b.position || compareStableIds(a.nodeId, b.nodeId),
  );
  const seen = new Set<string>();
  const distinct: GroupMemberPosition[] = [];
  for (const member of sorted) {
    if (seen.has(member.nodeId)) continue;
    seen.add(member.nodeId);
    distinct.push({ nodeId: member.nodeId, position: member.position });
  }
  return distinct;
}

/**
 * Assigns contiguous zero-based positions (`0..n-1`) after sorting by
 * `(position ASC, nodeId ASC)`. Mirrors the SQL backfill migration.
 */
export function backfillGroupMemberPositions(
  members: readonly GroupMemberPosition[],
): GroupMemberPosition[] {
  return sortGroupMembersByPosition(members).map((member, index) => ({
    nodeId: member.nodeId,
    position: index,
  }));
}

/**
 * Validates that an ordered entrance list contains only non-empty, distinct
 * subscriber entrance IDs.
 */
export function validateDistinctEntranceIds(
  nodeIds: readonly string[],
): ValidateDistinctEntrancesResult {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const emptyIndexes: number[] = [];
  const normalized: string[] = [];

  for (let index = 0; index < nodeIds.length; index += 1) {
    const raw = nodeIds[index] ?? "";
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      emptyIndexes.push(index);
      continue;
    }
    if (seen.has(trimmed)) {
      duplicates.add(trimmed);
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  if (emptyIndexes.length > 0 || duplicates.size > 0) {
    return {
      ok: false,
      duplicateNodeIds: [...duplicates],
      emptyIndexes,
    };
  }

  return { ok: true, nodeIds: normalized };
}

/**
 * Resolves the target ordered entrance IDs for a compatibility writer that
 * does not supply explicit positions: surviving members retain their current
 * `(position ASC, nodeId ASC)` relative order, and new additions are appended
 * deterministically sorted by stable `nodeId ASC`.
 */
export function reconcileCompatibilityEntranceOrder(
  currentMembers: readonly GroupMemberPosition[],
  incomingNodeIds: readonly string[],
): string[] {
  const orderedCurrent = sortGroupMembersByPosition(currentMembers);
  const targetSet = new Set<string>();
  for (const raw of incomingNodeIds) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      targetSet.add(trimmed);
    }
  }

  const surviving: string[] = [];
  const currentSet = new Set<string>();
  for (const member of orderedCurrent) {
    currentSet.add(member.nodeId);
    if (targetSet.has(member.nodeId)) {
      surviving.push(member.nodeId);
    }
  }

  const additions = [...targetSet]
    .filter((nodeId) => !currentSet.has(nodeId))
    .sort(compareStableIds);

  return [...surviving, ...additions];
}

/**
 * Builds a single-touch membership write plan from the current persisted rows
 * and target entrance IDs:
 *  - Every removed row appears only in `removedNodeIds` (`DELETE`).
 *  - Every retained row whose position changes appears only in `retainedUpdates` (`UPDATE`).
 *  - Every retained row whose position is unchanged appears only in `unchangedMembers` (no write).
 *  - Every newly added row appears only in `insertedMembers` (`INSERT`).
 *  - Reorder-only changes set `isReorderOnly = true` and `requiresPublishGate = false`.
 */
export function planGroupMembershipWrite(input: {
  currentMembers: readonly GroupMemberPosition[];
  targetNodeIds: readonly string[];
  mode?: GroupMembershipWriteMode;
}): PlanGroupMembershipWriteResult {
  const mode = input.mode ?? "ordered";
  const orderedCurrent = sortGroupMembersByPosition(input.currentMembers);

  let nextNodeIds: string[];
  if (mode === "ordered") {
    const validated = validateDistinctEntranceIds(input.targetNodeIds);
    if (!validated.ok) {
      return validated;
    }
    nextNodeIds = validated.nodeIds;
  } else {
    for (let index = 0; index < input.targetNodeIds.length; index += 1) {
      if ((input.targetNodeIds[index] ?? "").trim().length === 0) {
        return {
          ok: false,
          duplicateNodeIds: [],
          emptyIndexes: [index],
        };
      }
    }
    nextNodeIds = reconcileCompatibilityEntranceOrder(
      orderedCurrent,
      input.targetNodeIds,
    );
  }

  const previousNodeIds = orderedCurrent.map((member) => member.nodeId);
  const currentPositionById = new Map(
    orderedCurrent.map((member) => [member.nodeId, member.position]),
  );
  const nextSet = new Set(nextNodeIds);

  const removedNodeIds = previousNodeIds.filter(
    (nodeId) => !nextSet.has(nodeId),
  );
  const nextMembers: GroupMemberPosition[] = nextNodeIds.map(
    (nodeId, position) => ({
      nodeId,
      position,
    }),
  );

  const retainedUpdates: GroupMembershipRetainedUpdate[] = [];
  const unchangedMembers: GroupMemberPosition[] = [];
  const insertedMembers: GroupMemberPosition[] = [];

  for (const nextMember of nextMembers) {
    const previousPosition = currentPositionById.get(nextMember.nodeId);
    if (previousPosition === undefined) {
      insertedMembers.push(nextMember);
    } else if (previousPosition !== nextMember.position) {
      retainedUpdates.push({
        nodeId: nextMember.nodeId,
        previousPosition,
        position: nextMember.position,
      });
    } else {
      unchangedMembers.push(nextMember);
    }
  }

  const membershipSetChanged =
    removedNodeIds.length > 0 || insertedMembers.length > 0;
  const isReorderOnly = !membershipSetChanged && retainedUpdates.length > 0;
  const hasMembershipRowChanges =
    membershipSetChanged || retainedUpdates.length > 0;
  const requiresPublishGate = membershipSetChanged;

  const publishGateCandidateNodeIds = requiresPublishGate
    ? [...new Set([...previousNodeIds, ...nextNodeIds])]
    : [];

  return {
    ok: true,
    plan: {
      previousNodeIds,
      nextNodeIds,
      nextMembers,
      removedNodeIds,
      retainedUpdates,
      unchangedMembers,
      insertedMembers,
      membershipSetChanged,
      isReorderOnly,
      hasMembershipRowChanges,
      requiresPublishGate,
      publishGateCandidateNodeIds,
    },
  };
}

/**
 * Plans the deterministic membership compaction and group revision increments
 * required when a deleted node (`deletedNodeId`) cascades out of one or more
 * groups. Affected groups are sorted by `groupId ASC` for deadlock-free locking.
 */
export function planNodeDeletionGroupCascade(input: {
  deletedNodeId: string;
  groups: readonly GroupCascadeMembershipSnapshot[];
}): AffectedGroupCascadePlan[] {
  const plans: AffectedGroupCascadePlan[] = [];

  const sortedGroups = [...input.groups].sort((a, b) =>
    compareStableIds(a.groupId, b.groupId),
  );

  for (const group of sortedGroups) {
    const ordered = sortGroupMembersByPosition(group.members);
    const removedEntry = ordered.find(
      (member) => member.nodeId === input.deletedNodeId,
    );
    if (!removedEntry) continue;

    const surviving = ordered.filter(
      (member) => member.nodeId !== input.deletedNodeId,
    );
    const retainedUpdates: GroupMembershipRetainedUpdate[] = [];
    const nextNodeIds: string[] = [];

    for (let position = 0; position < surviving.length; position += 1) {
      const member = surviving[position]!;
      nextNodeIds.push(member.nodeId);
      if (member.position !== position) {
        retainedUpdates.push({
          nodeId: member.nodeId,
          previousPosition: member.position,
          position,
        });
      }
    }

    plans.push({
      groupId: group.groupId,
      previousRevision: group.revision,
      nextRevision: group.revision + 1,
      removedNodeId: input.deletedNodeId,
      removedPosition: removedEntry.position,
      previousNodeIds: ordered.map((member) => member.nodeId),
      nextNodeIds,
      retainedUpdates,
    });
  }

  return plans;
}

/**
 * Builds first-occurrence entrance ranks across the groups bound to a plan
 * (or set of plans).
 *
 * Traversal order per spec:
 *  1. Group `sortOrder ASC`, then stable `groupId ASC`.
 *  2. Member `position ASC`, then stable `nodeId ASC`.
 *  3. Deduplicate by entrance `nodeId` using its first occurrence.
 */
export function buildEntranceOrderRanks(
  rows: readonly GroupMembershipRankRow[],
): ReadonlyMap<string, number> {
  const sorted = [...rows].sort(
    (a, b) =>
      a.groupSortOrder - b.groupSortOrder ||
      compareStableIds(a.groupId, b.groupId) ||
      a.position - b.position ||
      compareStableIds(a.nodeId, b.nodeId),
  );

  const ranks = new Map<string, number>();
  for (const row of sorted) {
    if (!ranks.has(row.nodeId)) {
      ranks.set(row.nodeId, ranks.size);
    }
  }
  return ranks;
}

/**
 * Applies current authorized group-membership ranks ONLY to the publish-gated
 * visible set (`gatedItems`), deduplicating by entrance ID (first occurrence).
 *
 * A denied, disabled, or pending entrance absent from `gatedItems` can never
 * reappear through sorting. Any item in `gatedItems` without a rank in `ranks`
 * sorts deterministically after ranked items by stable entrance ID.
 */
export function orderGatedEntrances<T>(
  gatedItems: readonly T[],
  ranks: ReadonlyMap<string, number>,
  getNodeId: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const distinct: T[] = [];
  for (const item of gatedItems) {
    const nodeId = getNodeId(item);
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    distinct.push(item);
  }

  return distinct.sort((a, b) => {
    const idA = getNodeId(a);
    const idB = getNodeId(b);
    const rankA = ranks.get(idA);
    const rankB = ranks.get(idB);

    if (rankA !== undefined && rankB !== undefined) {
      return rankA - rankB;
    }
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return compareStableIds(idA, idB);
  });
}
