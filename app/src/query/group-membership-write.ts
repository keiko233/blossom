import {
  type AffectedGroupCascadePlan,
  type GroupMemberPosition,
  type GroupMembershipWriteMode,
  type GroupMembershipWritePlan,
  planGroupMembershipWrite,
} from "@blossom/domain/group-membership";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { type Database, db } from "@/db";
import { nodeGroup, type ProxyGroup, proxyGroup } from "@/db/proxy-schema";
import { notifyAgentConfigChanged } from "@/lib/agent-notifications";
import {
  listServerIdsForNodeIds,
  recordConfigChange,
} from "@/query/config-change";

/**
 * Shared contract and persistence boundary for ordered `proxy_group` and
 * `node_group` writes (Task 02: Ordered group writes and exports).
 *
 * Invariants for the full atomic writer:
 *  - Every group starts at `proxy_group.revision = 1` and increments
 *    `revision = revision + 1` on any metadata or membership mutation
 *    (including compatibility writes and node-delete membership cascades).
 *  - `node_group.position` holds contiguous zero-based positions (`0..n-1`) per
 *    `group_id`, enforced by the deferrable constraint
 *    `node_group_group_position_unique` (`UNIQUE (group_id, position)
 *    DEFERRABLE INITIALLY IMMEDIATE`).
 *  - Each membership row is touched at most once per write plan:
 *      1. `DELETE` rows in `plan.removedNodeIds`
 *      2. `UPDATE` rows in `plan.retainedUpdates`
 *      3. `INSERT` rows in `plan.insertedMembers`
 *  - Reorder-only changes (`plan.isReorderOnly === true`, where
 *    `plan.requiresPublishGate === false`) update `node_group.position` and
 *    `proxy_group.revision` only; they MUST NOT record a `config_change`, bump
 *    `server.desired_revision_seq`, or trigger `notifyAgentConfigChanged`.
 *  - Membership additions or removals (`plan.requiresPublishGate === true`)
 *    record an `"authorization"` `config_change` with
 *    `prevRow: { nodeIds: plan.previousNodeIds }` and bump affected servers'
 *    `desired_revision_seq` inside the same atomic boundary (`node-postgres`
 *    interactive transaction with `FOR UPDATE` locks on `proxy_group` and
 *    `server`, or `neon-http` single-statement data-modifying CTE).
 */

export type DbHandle = Database;

export interface GroupMetadataPatch {
  name?: string;
  remark?: string | null;
  sortOrder?: number;
}

export interface CreateGroupWithMembershipInput {
  id?: string;
  name: string;
  remark?: string;
  sortOrder?: number;
  nodeIds: readonly string[];
  mode?: GroupMembershipWriteMode;
}

export interface WriteGroupMembershipInput {
  groupId: string;
  /**
   * Optimistic concurrency token (`proxy_group.revision`). When supplied, the
   * write fails with `reason: "revision_conflict"` if the stored revision
   * differs. When omitted (compatibility callers), the writer still increments
   * `proxy_group.revision` atomically.
   */
  expectedRevision?: number;
  metadata?: GroupMetadataPatch;
  /**
   * Desired membership list. When omitted, only `metadata` and `revision` are
   * updated.
   */
  nodeIds?: readonly string[];
  /**
   * `"ordered"` (default when `expectedRevision` is provided) validates
   * distinct entrance IDs and applies `nodeIds` in exact order.
   * `"compatibility"` deduplicates `nodeIds`, retains surviving member order,
   * and appends new additions sorted by `nodeId ASC`.
   */
  mode?: GroupMembershipWriteMode;
}

export interface DeleteGroupWithMembershipInput {
  groupId: string;
  expectedRevision?: number;
}

export interface CascadeNodeDeleteMembershipsInput {
  nodeId: string;
}

export interface CommittedGroupMembershipState {
  group: ProxyGroup;
  nodeIds: string[];
  members: GroupMemberPosition[];
  revision: number;
  writePlan: GroupMembershipWritePlan | null;
  publishGateRecorded: boolean;
  affectedServerIds: string[];
  changeId: string | null;
}

export type GroupMembershipWriteFailureReason =
  | "not_found"
  | "revision_conflict"
  | "duplicate_node_ids"
  | "invalid_node_ids";

export type GroupMembershipWriteResult =
  | ({ ok: true } & CommittedGroupMembershipState)
  | {
      ok: false;
      reason: "not_found";
    }
  | {
      ok: false;
      reason: "revision_conflict";
      currentRevision: number;
      currentNodeIds: string[];
    }
  | {
      ok: false;
      reason: "duplicate_node_ids";
      duplicateNodeIds: string[];
    }
  | {
      ok: false;
      reason: "invalid_node_ids";
      missingNodeIds: string[];
    };

export interface GroupMembershipAtomicWriter {
  createGroupWithMembership(
    input: CreateGroupWithMembershipInput,
  ): Promise<CommittedGroupMembershipState>;
  writeGroupMembership(
    input: WriteGroupMembershipInput,
  ): Promise<GroupMembershipWriteResult>;
  deleteGroupWithMembership(input: DeleteGroupWithMembershipInput): Promise<
    | {
        ok: true;
        groupId: string;
        previousNodeIds: string[];
        affectedServerIds: string[];
      }
    | {
        ok: false;
        reason: "not_found" | "revision_conflict";
        currentRevision?: number;
      }
  >;
  cascadeNodeDeleteMemberships(
    input: CascadeNodeDeleteMembershipsInput,
    tx?: DbHandle,
  ): Promise<AffectedGroupCascadePlan[]>;
}

export class GroupMembershipConflictError extends Error {
  readonly code = "GROUP_REVISION_CONFLICT" as const;
  readonly groupId: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;

  constructor(params: {
    groupId: string;
    expectedRevision: number;
    currentRevision: number;
  }) {
    super(
      `Group ${params.groupId} revision conflict (expected ${params.expectedRevision}, found ${params.currentRevision})`,
    );
    this.name = "GroupMembershipConflictError";
    this.groupId = params.groupId;
    this.expectedRevision = params.expectedRevision;
    this.currentRevision = params.currentRevision;
  }
}

/**
 * Reads a group's current membership rows ordered by `(position ASC, nodeId ASC)`.
 */
export async function listOrderedGroupMembers(
  groupId: string,
  database: DbHandle = db,
): Promise<GroupMemberPosition[]> {
  return database
    .select({
      nodeId: nodeGroup.nodeId,
      position: nodeGroup.position,
    })
    .from(nodeGroup)
    .where(eq(nodeGroup.groupId, groupId))
    .orderBy(asc(nodeGroup.position), asc(nodeGroup.nodeId));
}

/**
 * Applies a precomputed `GroupMembershipWritePlan` to `node_group` while
 * touching each membership row at most once, and records a publish-gate
 * `"authorization"` change only when `plan.requiresPublishGate` is true
 * (skipping publish-gate writes on reorder-only saves).
 *
 * Checkpoint implementation used by `app/src/query/groups.ts`; DeepSeek will
 * upgrade `writeGroupMembership` to the full driver-specific atomic execution
 * (`node-postgres` interactive transaction with `FOR UPDATE` row locks and
 * `neon-http` single-statement data-modifying CTE).
 */
export async function applyPlannedGroupMembershipUpdate(params: {
  groupId: string;
  expectedRevision?: number;
  metadata: GroupMetadataPatch;
  nodeIds?: readonly string[];
  mode?: GroupMembershipWriteMode;
  database?: DbHandle;
}): Promise<ProxyGroup> {
  const database = params.database ?? db;
  const { groupId, expectedRevision, metadata, nodeIds } = params;

  const currentMembers =
    nodeIds !== undefined
      ? await listOrderedGroupMembers(groupId, database)
      : [];

  const planned =
    nodeIds !== undefined
      ? planGroupMembershipWrite({
          currentMembers,
          targetNodeIds: nodeIds,
          mode:
            params.mode ??
            (expectedRevision !== undefined ? "ordered" : "compatibility"),
        })
      : null;

  if (planned && !planned.ok) {
    if (planned.duplicateNodeIds.length > 0) {
      throw new Error(
        `Duplicate entrance IDs in group membership: ${planned.duplicateNodeIds.join(", ")}`,
      );
    }
    throw new Error("Invalid empty entrance ID in group membership");
  }

  const whereClause =
    expectedRevision !== undefined
      ? and(
          eq(proxyGroup.id, groupId),
          eq(proxyGroup.revision, expectedRevision),
        )
      : eq(proxyGroup.id, groupId);

  const [row] = await database
    .update(proxyGroup)
    .set({
      ...metadata,
      revision: sql`${proxyGroup.revision} + 1`,
    })
    .where(whereClause)
    .returning();

  if (!row) {
    if (expectedRevision !== undefined) {
      const [existing] = await database
        .select({ revision: proxyGroup.revision })
        .from(proxyGroup)
        .where(eq(proxyGroup.id, groupId));
      if (existing) {
        throw new GroupMembershipConflictError({
          groupId,
          expectedRevision,
          currentRevision: existing.revision,
        });
      }
    }
    throw new Error("Not found");
  }

  if (planned?.ok) {
    const { plan } = planned;

    if (plan.removedNodeIds.length > 0) {
      await database
        .delete(nodeGroup)
        .where(
          and(
            eq(nodeGroup.groupId, groupId),
            inArray(nodeGroup.nodeId, plan.removedNodeIds),
          ),
        );
    }

    if (plan.retainedUpdates.length > 0) {
      const valueTuples = sql.join(
        plan.retainedUpdates.map(
          (item) => sql`(${item.nodeId}::text, ${item.position}::integer)`,
        ),
        sql`, `,
      );
      const executor = database as unknown as {
        execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }>;
      };
      await executor.execute(sql`
        UPDATE ${nodeGroup}
        SET ${sql.identifier(nodeGroup.position.name)} = updates.position
        FROM (VALUES ${valueTuples}) AS updates(node_id, position)
        WHERE ${nodeGroup.groupId} = ${groupId}::text
          AND ${nodeGroup.nodeId} = updates.node_id
      `);
    }

    if (plan.insertedMembers.length > 0) {
      await database.insert(nodeGroup).values(
        plan.insertedMembers.map((member) => ({
          groupId,
          nodeId: member.nodeId,
          position: member.position,
        })),
      );
    }

    if (plan.requiresPublishGate) {
      const change = await recordConfigChange(database, {
        kind: "authorization",
        subjectId: groupId,
        prevRow: { nodeIds: plan.previousNodeIds },
        serverIds: await listServerIdsForNodeIds(
          database,
          plan.publishGateCandidateNodeIds,
        ),
      });
      await notifyAgentConfigChanged(
        change.serverIds,
        "group membership changed",
      );
    }
  }

  return row;
}
