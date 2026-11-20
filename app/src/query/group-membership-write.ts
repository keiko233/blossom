import type { DatabaseDriver } from "@blossom/database/driver";
import {
  type AffectedGroupCascadePlan,
  compareStableIds,
  type GroupMemberPosition,
  type GroupMembershipWriteMode,
  type GroupMembershipWritePlan,
  planGroupMembershipWrite,
  planNodeDeletionGroupCascade,
  sortGroupMembersByPosition,
} from "@blossom/domain/group-membership";
import { asc, eq, getTableColumns, inArray, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";

import { type Database, db, getDatabaseDriver } from "@/db";
import {
  configChange,
  configChangeServer,
  node,
  nodeGroup,
  type Node,
  type ProxyGroup,
  proxyGroup,
  server,
} from "@/db/proxy-schema";
import { notifyAgentConfigChanged } from "@/lib/agent-notifications";
import { supportsInteractiveTransactions } from "@/lib/env-schema";
import {
  listServerIdsForGroupIds,
  listServerIdsForNodeIds,
  recordConfigChange,
} from "@/query/config-change";

/**
 * Shared persistence boundary for ordered `proxy_group` / `node_group` writes
 * (Task 02: Ordered group writes and exports).
 *
 * Invariants:
 *  - Every group starts at `proxy_group.revision = 1` and increments
 *    `revision = revision + 1` on any metadata or membership mutation
 *    (including compatibility writes and node-delete membership cascades).
 *  - `node_group.position` holds contiguous zero-based positions (`0..n-1`) per
 *    `group_id`. The deferrable unique constraint
 *    `node_group_group_position_unique` allows a whole row-set swap in one
 *    statement without intermediate collisions.
 *  - Each membership row is touched at most once per write plan: distinct
 *    removals, retained position updates, and new inserts.
 *  - A caller-supplied `expectedRevision` is an optimistic-concurrency token.
 *    Compatibility callers omit it; the writer still guards the mutation with
 *    the revision it read and retries on contention instead of writing from a
 *    stale membership preimage.
 *  - Reorder-only changes update `node_group.position` and the group revision
 *    only. They record no `config_change`, bump no `desired_revision_seq`, and
 *    send no agent notification.
 *  - Membership additions/removals record one `"authorization"` change with
 *    `prevRow: { nodeIds: previousNodeIds }` and bump affected servers inside
 *    the same transaction (node-postgres) or the same data-modifying statement
 *    (neon-http).
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
   * differs. When omitted (compatibility callers), the writer still guards the
   * mutation with the revision it read and retries on contention.
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

export interface DeleteGroupWithMembershipResult {
  groupId: string;
  previousNodeIds: string[];
  affectedServerIds: string[];
  changeId: string | null;
}

export interface DeleteNodeWithMembershipCascadeResult {
  node: Node;
  plans: AffectedGroupCascadePlan[];
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

interface WriterOptions {
  database?: DbHandle;
  driver?: DatabaseDriver;
}

interface GroupSnapshot {
  group: ProxyGroup;
  members: GroupMemberPosition[];
}

interface NodeCascadeSnapshot {
  node: Node;
  plans: AffectedGroupCascadePlan[];
}

const MAX_CONTENTION_RETRIES = 32;

function resolveWriter(options: WriterOptions): {
  database: DbHandle;
  driver: DatabaseDriver;
  interactive: boolean;
} {
  const database = options.database ?? db;
  const driver = options.driver ?? getDatabaseDriver();
  return {
    database,
    driver,
    interactive: supportsInteractiveTransactions(driver),
  };
}

/**
 * Runs a write in one interactive transaction on node-postgres. neon-http has
 * no interactive transactions, so its callers use the single-statement paths
 * inside the functions below.
 */
export async function withDatabaseTransaction<T>(
  database: DbHandle,
  driver: DatabaseDriver,
  run: (tx: DbHandle) => Promise<T>,
): Promise<T> {
  if (!supportsInteractiveTransactions(driver)) {
    return run(database);
  }
  return (
    database as unknown as {
      transaction: <Result>(
        callback: (tx: DbHandle) => Promise<Result>,
      ) => Promise<Result>;
    }
  ).transaction(run);
}

async function executeRows<T extends Record<string, unknown>>(
  database: DbHandle,
  statement: SQL,
): Promise<T[]> {
  const result = await database.execute<T>(statement, "objects");
  if (Array.isArray(result)) {
    return result;
  }
  const wrapped = result as unknown as { rows?: T[] };
  return wrapped.rows ?? [];
}

function mapColumns(
  table: PgTable,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => {
      const value = raw[column.name];
      if (typeof value === "string" && column.dataType === "object date") {
        return [key, new Date(value.replace(" ", "T") + "Z")];
      }
      return [key, value === null ? null : column.mapFromDriverValue(value)];
    }),
  );
}

function mapGroupRow(raw: Record<string, unknown>): ProxyGroup {
  return mapColumns(proxyGroup, raw) as ProxyGroup;
}

function mapNodeRow(raw: Record<string, unknown>): Node {
  return mapColumns(node, raw) as Node;
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value === "string") {
    return JSON.parse(value) as string[];
  }
  return (value ?? []) as string[];
}

async function readGroupSnapshot(
  database: DbHandle,
  groupId: string,
  lock: boolean,
): Promise<GroupSnapshot | null> {
  const query = database
    .select()
    .from(proxyGroup)
    .where(eq(proxyGroup.id, groupId));
  const [group] = lock ? await query.for("update") : await query;
  if (!group) return null;
  const members = await database
    .select({
      nodeId: nodeGroup.nodeId,
      position: nodeGroup.position,
    })
    .from(nodeGroup)
    .where(eq(nodeGroup.groupId, groupId))
    .orderBy(asc(nodeGroup.position), asc(nodeGroup.nodeId));
  return { group, members };
}

function metadataSet(metadata: GroupMetadataPatch): SQL {
  const sets: SQL[] = [
    sql`${sql.identifier(proxyGroup.revision.name)} = ${proxyGroup.revision} + 1`,
    sql`${sql.identifier(proxyGroup.updatedAt.name)} = timezone('utc', now())`,
  ];
  if (metadata.name !== undefined) {
    sets.push(
      sql`${sql.identifier(proxyGroup.name.name)} = ${metadata.name}::text`,
    );
  }
  if (metadata.remark !== undefined) {
    sets.push(
      sql`${sql.identifier(proxyGroup.remark.name)} = ${metadata.remark}::text`,
    );
  }
  if (metadata.sortOrder !== undefined) {
    sets.push(
      sql`${sql.identifier(proxyGroup.sortOrder.name)} = ${metadata.sortOrder}::integer`,
    );
  }
  return sql.join(sets, sql`, `);
}

interface PublishGateWrite {
  previousNodeIds: readonly string[];
  candidateNodeIds: readonly string[];
  changeId: string;
}

function publishGateCtes(
  groupId: string,
  gate: PublishGateWrite,
  onlyEnabledServers: boolean,
): SQL[] {
  return [
    sql`candidate_nodes AS (
      SELECT DISTINCT value AS node_id
      FROM jsonb_array_elements_text(
        ${JSON.stringify(gate.candidateNodeIds)}::jsonb
      ) AS x(value)
    )`,
    sql`locked_servers AS (
      SELECT ${server.id} AS id
      FROM ${server}
      WHERE ${server.id} IN (
        SELECT ${node.serverId}
        FROM ${node}
        WHERE ${node.id} IN (SELECT node_id FROM candidate_nodes)
          ${onlyEnabledServers ? sql`AND ${node.enabled}` : sql``}
      )
      ORDER BY ${server.id}
      FOR UPDATE
    )`,
    sql`bumped AS (
      UPDATE ${server}
      SET ${sql.identifier(server.desiredRevisionSeq.name)} = ${server.desiredRevisionSeq} + 1
      FROM locked_servers
      WHERE ${server.id} = locked_servers.id
        AND EXISTS (SELECT 1 FROM target)
      RETURNING ${server.id} AS id, ${server.desiredRevisionSeq} AS seq
    )`,
    sql`change AS (
      INSERT INTO ${configChange} (
        ${sql.identifier(configChange.id.name)},
        ${sql.identifier(configChange.kind.name)},
        ${sql.identifier(configChange.subjectId.name)},
        ${sql.identifier(configChange.prevRow.name)}
      )
      SELECT ${gate.changeId}::text,
             'authorization',
             ${groupId}::text,
             jsonb_build_object('nodeIds', ${JSON.stringify(gate.previousNodeIds)}::jsonb)
      WHERE EXISTS (SELECT 1 FROM bumped)
      RETURNING ${configChange.id} AS id
    )`,
    sql`links AS (
      INSERT INTO ${configChangeServer} (
        ${sql.identifier(configChangeServer.changeId.name)},
        ${sql.identifier(configChangeServer.serverId.name)},
        ${sql.identifier(configChangeServer.revisionSeq.name)}
      )
      SELECT change.id, bumped.id, bumped.seq
      FROM change CROSS JOIN bumped
      RETURNING 1
    )`,
  ];
}

function mutationSelect(gate: PublishGateWrite | null): SQL {
  return gate
    ? sql`SELECT target.*,
            (SELECT id FROM change) AS "__change_id",
            coalesce(
              (SELECT jsonb_agg(id ORDER BY id) FROM bumped),
              '[]'::jsonb
            ) AS "__server_ids"
          FROM target`
    : sql`SELECT target.*,
            NULL AS "__change_id",
            '[]'::jsonb AS "__server_ids"
          FROM target`;
}

function membershipMutationStatement(input: {
  groupId: string;
  expectedRevision: number;
  metadata: GroupMetadataPatch;
  plan: GroupMembershipWritePlan | null;
  gate: PublishGateWrite | null;
  onlyEnabledServers?: boolean;
}): SQL {
  const { groupId, expectedRevision, metadata, plan, gate } = input;
  const ctes: SQL[] = [
    sql`target AS (
      UPDATE ${proxyGroup}
      SET ${metadataSet(metadata)}
      WHERE ${proxyGroup.id} = ${groupId}::text
        AND ${proxyGroup.revision} = ${expectedRevision}::integer
      RETURNING ${proxyGroup}.*
    )`,
  ];

  if (plan && plan.removedNodeIds.length > 0) {
    ctes.push(sql`removed AS (
      DELETE FROM ${nodeGroup}
      WHERE ${nodeGroup.groupId} = ${groupId}::text
        AND ${nodeGroup.nodeId} IN (
          SELECT value
          FROM jsonb_array_elements_text(
            ${JSON.stringify(plan.removedNodeIds)}::jsonb
          ) AS x(value)
        )
        AND EXISTS (SELECT 1 FROM target)
      RETURNING 1
    )`);
  }

  if (plan && plan.retainedUpdates.length > 0) {
    const updates = plan.retainedUpdates.map((update) => ({
      node_id: update.nodeId,
      position: update.position,
    }));
    ctes.push(sql`updated AS (
      UPDATE ${nodeGroup}
      SET ${sql.identifier(nodeGroup.position.name)} = updates.position
      FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
        AS updates(node_id text, position integer)
      WHERE ${nodeGroup.groupId} = ${groupId}::text
        AND ${nodeGroup.nodeId} = updates.node_id
        AND ${nodeGroup.position} <> updates.position
        AND EXISTS (SELECT 1 FROM target)
      RETURNING 1
    )`);
  }

  if (plan && plan.insertedMembers.length > 0) {
    const inserts = plan.insertedMembers.map((member) => ({
      node_id: member.nodeId,
      position: member.position,
    }));
    ctes.push(sql`inserted AS (
      INSERT INTO ${nodeGroup} (
        ${sql.identifier(nodeGroup.groupId.name)},
        ${sql.identifier(nodeGroup.nodeId.name)},
        ${sql.identifier(nodeGroup.position.name)}
      )
      SELECT ${groupId}::text, members.node_id, members.position
      FROM jsonb_to_recordset(${JSON.stringify(inserts)}::jsonb)
        AS members(node_id text, position integer)
      WHERE EXISTS (SELECT 1 FROM target)
      RETURNING 1
    )`);
  }

  if (gate) {
    ctes.push(
      ...publishGateCtes(groupId, gate, input.onlyEnabledServers ?? false),
    );
  }

  return sql`
    WITH ${sql.join(ctes, sql`, `)}
    ${mutationSelect(gate)}
  `;
}

function deleteGroupMutationStatement(input: {
  groupId: string;
  expectedRevision: number;
  previousNodeIds: readonly string[];
  gate: PublishGateWrite | null;
}): SQL {
  const ctes: SQL[] = [
    sql`target AS (
      DELETE FROM ${proxyGroup}
      WHERE ${proxyGroup.id} = ${input.groupId}::text
        AND ${proxyGroup.revision} = ${input.expectedRevision}::integer
      RETURNING ${proxyGroup}.*
    )`,
  ];
  if (input.gate) {
    ctes.push(...publishGateCtes(input.groupId, input.gate, true));
  }
  return sql`
    WITH ${sql.join(ctes, sql`, `)}
    ${mutationSelect(input.gate)}
  `;
}

function deleteNodeCascadeStatement(input: {
  nodeId: string;
  plans: readonly AffectedGroupCascadePlan[];
}): SQL {
  const guards = input.plans.map((plan) => ({
    group_id: plan.groupId,
    revision: plan.previousRevision,
  }));
  const updates = input.plans.flatMap((plan) =>
    plan.retainedUpdates.map((update) => ({
      group_id: plan.groupId,
      node_id: update.nodeId,
      position: update.position,
    })),
  );
  const ctes: SQL[] = [
    sql`target AS (
      DELETE FROM ${node}
      WHERE ${node.id} = ${input.nodeId}::text
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset(${JSON.stringify(guards)}::jsonb)
            AS guards(group_id text, revision integer)
          JOIN ${proxyGroup} ON ${proxyGroup.id} = guards.group_id
          WHERE ${proxyGroup.revision} <> guards.revision
        )
      RETURNING ${node}.*
    )`,
  ];
  if (updates.length > 0) {
    ctes.push(sql`updated AS (
      UPDATE ${nodeGroup}
      SET ${sql.identifier(nodeGroup.position.name)} = updates.position
      FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
        AS updates(group_id text, node_id text, position integer)
      WHERE ${nodeGroup.groupId} = updates.group_id
        AND ${nodeGroup.nodeId} = updates.node_id
        AND ${nodeGroup.position} <> updates.position
        AND EXISTS (SELECT 1 FROM target)
      RETURNING 1
    )`);
  }
  if (input.plans.length > 0) {
    ctes.push(sql`bumped AS (
      UPDATE ${proxyGroup}
      SET ${sql.identifier(proxyGroup.revision.name)} = ${proxyGroup.revision} + 1
      WHERE ${proxyGroup.id} IN (
        SELECT group_id
        FROM jsonb_to_recordset(${JSON.stringify(guards)}::jsonb)
          AS guards(group_id text, revision integer)
      )
        AND EXISTS (SELECT 1 FROM target)
      RETURNING ${proxyGroup.id} AS id
    )`);
  }
  return sql`
    WITH ${sql.join(ctes, sql`, `)}
    SELECT target.* FROM target
  `;
}

function validationError(
  result: Extract<ReturnType<typeof planGroupMembershipWrite>, { ok: false }>,
): Error {
  if (result.duplicateNodeIds.length > 0) {
    return new Error(
      `Duplicate entrance IDs in group membership: ${result.duplicateNodeIds.join(", ")}`,
    );
  }
  return new Error("Invalid empty entrance ID in group membership");
}

function writeFailure(
  result: Extract<ReturnType<typeof planGroupMembershipWrite>, { ok: false }>,
): GroupMembershipWriteResult {
  return result.duplicateNodeIds.length > 0
    ? {
        ok: false,
        reason: "duplicate_node_ids",
        duplicateNodeIds: result.duplicateNodeIds,
      }
    : {
        ok: false,
        reason: "invalid_node_ids",
        missingNodeIds: [],
      };
}

function membershipMode(
  input: WriteGroupMembershipInput,
): GroupMembershipWriteMode {
  return (
    input.mode ??
    (input.expectedRevision !== undefined ? "ordered" : "compatibility")
  );
}

function planMembership(
  snapshot: GroupSnapshot,
  input: WriteGroupMembershipInput,
): ReturnType<typeof planGroupMembershipWrite> | null {
  if (input.nodeIds === undefined) return null;
  return planGroupMembershipWrite({
    currentMembers: snapshot.members,
    targetNodeIds: input.nodeIds,
    mode: membershipMode(input),
  });
}

async function conflictResult(
  database: DbHandle,
  groupId: string,
): Promise<GroupMembershipWriteResult> {
  const snapshot = await readGroupSnapshot(database, groupId, false);
  if (!snapshot) {
    return { ok: false, reason: "not_found" };
  }
  return {
    ok: false,
    reason: "revision_conflict",
    currentRevision: snapshot.group.revision,
    currentNodeIds: snapshot.members.map((member) => member.nodeId),
  };
}

function committedState(
  plan: GroupMembershipWritePlan | null,
  previousMembers: readonly GroupMemberPosition[],
  raw: Record<string, unknown> | undefined,
): CommittedGroupMembershipState {
  const group = mapGroupRow(raw ?? {});
  const members = plan
    ? plan.nextMembers
    : previousMembers.map((member) => ({ ...member }));
  const affectedServerIds = parseJsonArray(raw?.__server_ids);
  return {
    group,
    nodeIds: members.map((member) => member.nodeId),
    members,
    revision: group.revision,
    writePlan: plan,
    publishGateRecorded: affectedServerIds.length > 0,
    affectedServerIds,
    changeId: (raw?.__change_id as string | null | undefined) ?? null,
  };
}

async function performWrite(
  database: DbHandle,
  input: WriteGroupMembershipInput,
  interactive: boolean,
): Promise<GroupMembershipWriteResult> {
  for (let attempt = 0; attempt < MAX_CONTENTION_RETRIES; attempt += 1) {
    const snapshot = await readGroupSnapshot(
      database,
      input.groupId,
      interactive,
    );
    if (!snapshot) {
      return { ok: false, reason: "not_found" };
    }
    if (
      input.expectedRevision !== undefined &&
      snapshot.group.revision !== input.expectedRevision
    ) {
      return {
        ok: false,
        reason: "revision_conflict",
        currentRevision: snapshot.group.revision,
        currentNodeIds: snapshot.members.map((member) => member.nodeId),
      };
    }

    const planned = planMembership(snapshot, input);
    if (planned && !planned.ok) {
      return writeFailure(planned);
    }
    const plan = planned?.ok ? planned.plan : null;

    const gate = plan?.requiresPublishGate
      ? {
          previousNodeIds: plan.previousNodeIds,
          candidateNodeIds: plan.publishGateCandidateNodeIds,
          changeId: randomUUID(),
        }
      : null;

    if (interactive) {
      const row = (
        await database
          .update(proxyGroup)
          .set({
            ...input.metadata,
            revision: sql`${proxyGroup.revision} + 1`,
          })
          .where(eq(proxyGroup.id, input.groupId))
          .returning()
      )[0];
      if (!row) return conflictResult(database, input.groupId);

      if (plan) await applyPlan(database, input.groupId, plan);
      let changeId: string | null = null;
      let affectedServerIds: string[] = [];
      if (gate) {
        const serverIds = (
          await listServerIdsForNodeIds(database, gate.candidateNodeIds)
        ).sort(compareStableIds);
        const change = await recordConfigChange(database, {
          kind: "authorization",
          subjectId: input.groupId,
          prevRow: { nodeIds: gate.previousNodeIds },
          serverIds,
        });
        changeId = change.changeId;
        affectedServerIds = change.serverIds;
      }

      const members = await database
        .select({
          nodeId: nodeGroup.nodeId,
          position: nodeGroup.position,
        })
        .from(nodeGroup)
        .where(eq(nodeGroup.groupId, input.groupId))
        .orderBy(asc(nodeGroup.position), asc(nodeGroup.nodeId));

      return {
        ok: true,
        group: row,
        nodeIds: members.map((member) => member.nodeId),
        members,
        revision: row.revision,
        writePlan: plan,
        publishGateRecorded: affectedServerIds.length > 0,
        affectedServerIds,
        changeId,
      };
    }

    const raw = (
      await executeRows<Record<string, unknown>>(
        database,
        membershipMutationStatement({
          groupId: input.groupId,
          expectedRevision: snapshot.group.revision,
          metadata: input.metadata ?? {},
          plan,
          gate,
        }),
      )
    )[0];

    if (raw) {
      return {
        ok: true,
        ...committedState(plan, snapshot.members, raw),
      };
    }

    if (input.expectedRevision !== undefined) {
      return conflictResult(database, input.groupId);
    }
    const current = await readGroupSnapshot(database, input.groupId, false);
    if (!current) return { ok: false, reason: "not_found" };
  }
  throw new Error(
    `Group ${input.groupId} membership write did not settle after ${MAX_CONTENTION_RETRIES} attempts`,
  );
}

async function applyPlan(
  database: DbHandle,
  groupId: string,
  plan: GroupMembershipWritePlan,
): Promise<void> {
  if (plan.removedNodeIds.length > 0) {
    await database.delete(nodeGroup).where(
      sql`${nodeGroup.groupId} = ${groupId}::text
          AND ${nodeGroup.nodeId} IN (
            SELECT value
            FROM jsonb_array_elements_text(
              ${JSON.stringify(plan.removedNodeIds)}::jsonb
            ) AS x(value)
          )`,
    );
  }
  if (plan.retainedUpdates.length > 0) {
    const updates = plan.retainedUpdates.map((update) => ({
      node_id: update.nodeId,
      position: update.position,
    }));
    await executeRows(
      database,
      sql`
        UPDATE ${nodeGroup}
        SET ${sql.identifier(nodeGroup.position.name)} = updates.position
        FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
          AS updates(node_id text, position integer)
        WHERE ${nodeGroup.groupId} = ${groupId}::text
          AND ${nodeGroup.nodeId} = updates.node_id
          AND ${nodeGroup.position} <> updates.position
      `,
    );
  }
  if (plan.insertedMembers.length > 0) {
    const inserts = plan.insertedMembers.map((member) => ({
      node_id: member.nodeId,
      position: member.position,
    }));
    await executeRows(
      database,
      sql`
        INSERT INTO ${nodeGroup} (
          ${sql.identifier(nodeGroup.groupId.name)},
          ${sql.identifier(nodeGroup.nodeId.name)},
          ${sql.identifier(nodeGroup.position.name)}
        )
        SELECT ${groupId}::text, members.node_id, members.position
        FROM jsonb_to_recordset(${JSON.stringify(inserts)}::jsonb)
          AS members(node_id text, position integer)
      `,
    );
  }
}

export async function createGroupWithMembership(
  input: CreateGroupWithMembershipInput,
  options: WriterOptions = {},
): Promise<CommittedGroupMembershipState> {
  const { database } = resolveWriter(options);
  const planned = planGroupMembershipWrite({
    currentMembers: [],
    targetNodeIds: input.nodeIds,
    mode: input.mode ?? "ordered",
  });
  if (!planned.ok) throw validationError(planned);

  const id = input.id ?? randomUUID();
  const inserts = planned.plan.insertedMembers.map((member) => ({
    node_id: member.nodeId,
    position: member.position,
  }));
  const row = (
    await executeRows<Record<string, unknown>>(
      database,
      sql`
        WITH created AS (
          INSERT INTO ${proxyGroup} (
            ${sql.identifier(proxyGroup.id.name)},
            ${sql.identifier(proxyGroup.name.name)},
            ${sql.identifier(proxyGroup.remark.name)},
            ${sql.identifier(proxyGroup.sortOrder.name)}
          )
          VALUES (
            ${id}::text,
            ${input.name}::text,
            ${input.remark ?? null}::text,
            ${input.sortOrder ?? 0}::integer
          )
          RETURNING ${proxyGroup}.*
        ),
        members AS (
          INSERT INTO ${nodeGroup} (
            ${sql.identifier(nodeGroup.groupId.name)},
            ${sql.identifier(nodeGroup.nodeId.name)},
            ${sql.identifier(nodeGroup.position.name)}
          )
          SELECT created.id, inserted.node_id, inserted.position
          FROM created
          CROSS JOIN jsonb_to_recordset(${JSON.stringify(inserts)}::jsonb)
            AS inserted(node_id text, position integer)
          RETURNING 1
        )
        SELECT created.* FROM created
      `,
    )
  )[0];
  if (!row) throw new Error("Failed to create group");
  const group = mapGroupRow(row);
  return {
    group,
    nodeIds: planned.plan.nextNodeIds,
    members: planned.plan.nextMembers,
    revision: group.revision,
    writePlan: planned.plan,
    publishGateRecorded: false,
    affectedServerIds: [],
    changeId: null,
  };
}

export async function writeGroupMembership(
  input: WriteGroupMembershipInput,
  options: WriterOptions = {},
): Promise<GroupMembershipWriteResult> {
  const { database, driver, interactive } = resolveWriter(options);
  const result = await withDatabaseTransaction(database, driver, (tx) =>
    performWrite(tx, input, interactive),
  );
  if (result.ok && result.affectedServerIds.length > 0) {
    await notifyAgentConfigChanged(
      result.affectedServerIds,
      "group membership changed",
    );
  }
  return result;
}

async function performDeleteGroup(
  database: DbHandle,
  input: DeleteGroupWithMembershipInput,
  interactive: boolean,
): Promise<
  | { ok: true; result: DeleteGroupWithMembershipResult }
  | {
      ok: false;
      reason: "not_found";
    }
  | {
      ok: false;
      reason: "revision_conflict";
      currentRevision: number;
    }
> {
  for (let attempt = 0; attempt < MAX_CONTENTION_RETRIES; attempt += 1) {
    const snapshot = await readGroupSnapshot(
      database,
      input.groupId,
      interactive,
    );
    if (!snapshot) return { ok: false, reason: "not_found" };
    if (
      input.expectedRevision !== undefined &&
      snapshot.group.revision !== input.expectedRevision
    ) {
      return {
        ok: false,
        reason: "revision_conflict",
        currentRevision: snapshot.group.revision,
      };
    }

    const previousNodeIds = snapshot.members.map((member) => member.nodeId);
    const gate =
      previousNodeIds.length > 0
        ? {
            previousNodeIds,
            candidateNodeIds: previousNodeIds,
            changeId: randomUUID(),
          }
        : null;

    if (interactive) {
      const serverIds = (
        await listServerIdsForGroupIds(database, [input.groupId])
      ).sort(compareStableIds);
      const [row] = await database
        .delete(proxyGroup)
        .where(eq(proxyGroup.id, input.groupId))
        .returning();
      if (!row) return { ok: false, reason: "not_found" };
      let changeId: string | null = null;
      let affectedServerIds: string[] = [];
      if (gate) {
        const change = await recordConfigChange(database, {
          kind: "authorization",
          subjectId: input.groupId,
          prevRow: { nodeIds: previousNodeIds },
          serverIds,
        });
        changeId = change.changeId;
        affectedServerIds = change.serverIds;
      }
      return {
        ok: true,
        result: {
          groupId: row.id,
          previousNodeIds,
          affectedServerIds,
          changeId,
        },
      };
    }

    const raw = (
      await executeRows<Record<string, unknown>>(
        database,
        deleteGroupMutationStatement({
          groupId: input.groupId,
          expectedRevision: snapshot.group.revision,
          previousNodeIds,
          gate,
        }),
      )
    )[0];
    if (raw) {
      return {
        ok: true,
        result: {
          groupId: input.groupId,
          previousNodeIds,
          affectedServerIds: parseJsonArray(raw.__server_ids),
          changeId: (raw.__change_id as string | null | undefined) ?? null,
        },
      };
    }
    if (input.expectedRevision !== undefined) {
      const current = await readGroupSnapshot(database, input.groupId, false);
      if (!current) return { ok: false, reason: "not_found" };
      return {
        ok: false,
        reason: "revision_conflict",
        currentRevision: current.group.revision,
      };
    }
    const current = await readGroupSnapshot(database, input.groupId, false);
    if (!current) return { ok: false, reason: "not_found" };
  }
  throw new Error(
    `Group ${input.groupId} delete did not settle after ${MAX_CONTENTION_RETRIES} attempts`,
  );
}

export async function deleteGroupWithMembership(
  input: DeleteGroupWithMembershipInput,
  options: WriterOptions = {},
): Promise<
  | { ok: true; result: DeleteGroupWithMembershipResult }
  | { ok: false; reason: "not_found" }
  | {
      ok: false;
      reason: "revision_conflict";
      currentRevision: number;
    }
> {
  const { database, driver, interactive } = resolveWriter(options);
  const result = await withDatabaseTransaction(database, driver, (tx) =>
    performDeleteGroup(tx, input, interactive),
  );
  if (result.ok && result.result.affectedServerIds.length > 0) {
    await notifyAgentConfigChanged(
      result.result.affectedServerIds,
      "group deleted",
    );
  }
  return result;
}

async function readNodeCascadeSnapshot(
  database: DbHandle,
  nodeId: string,
  lock: boolean,
): Promise<NodeCascadeSnapshot | null> {
  const query = database.select().from(node).where(eq(node.id, nodeId));
  if (!lock) {
    const [row] = await query;
    return row ? buildNodeCascadeSnapshot(database, nodeId, row) : null;
  }

  const [existing] = await database
    .select({ id: node.id })
    .from(node)
    .where(eq(node.id, nodeId));
  if (!existing) return null;

  // Lock the groups before the node. Group writers lock their group first and
  // may then need the node for a membership insert; taking the node first
  // would deadlock that writer. A group-wide lock is rare (only node deletion)
  // and makes the membership snapshot stable for the whole transaction.
  await database
    .select({ id: proxyGroup.id })
    .from(proxyGroup)
    .orderBy(asc(proxyGroup.id))
    .for("update");
  const [row] = await query.for("update");
  if (!row) return null;
  return buildNodeCascadeSnapshot(database, nodeId, row);
}

async function buildNodeCascadeSnapshot(
  database: DbHandle,
  nodeId: string,
  row: Node,
): Promise<NodeCascadeSnapshot> {
  const memberships = await database
    .select({
      groupId: proxyGroup.id,
      revision: proxyGroup.revision,
      nodeId: nodeGroup.nodeId,
      position: nodeGroup.position,
    })
    .from(proxyGroup)
    .innerJoin(nodeGroup, eq(nodeGroup.groupId, proxyGroup.id))
    .where(
      inArray(
        proxyGroup.id,
        database
          .select({ groupId: nodeGroup.groupId })
          .from(nodeGroup)
          .where(eq(nodeGroup.nodeId, nodeId)),
      ),
    )
    .orderBy(
      asc(proxyGroup.id),
      asc(nodeGroup.position),
      asc(nodeGroup.nodeId),
    );

  const groups = new Map<
    string,
    { revision: number; members: GroupMemberPosition[] }
  >();
  for (const membership of memberships) {
    const group = groups.get(membership.groupId) ?? {
      revision: membership.revision,
      members: [],
    };
    group.members.push({
      nodeId: membership.nodeId,
      position: membership.position,
    });
    groups.set(membership.groupId, group);
  }

  const plans = planNodeDeletionGroupCascade({
    deletedNodeId: nodeId,
    groups: [...groups].map(([groupId, group]) => ({
      groupId,
      revision: group.revision,
      members: sortGroupMembersByPosition(group.members),
    })),
  });
  return { node: row, plans };
}

export async function deleteNodeWithMembershipCascade(
  input: { nodeId: string },
  options: WriterOptions & { interactive?: boolean } = {},
): Promise<DeleteNodeWithMembershipCascadeResult | null> {
  const { database, driver } = resolveWriter(options);
  const interactive =
    options.interactive ?? supportsInteractiveTransactions(driver);
  if (interactive) {
    const snapshot = await readNodeCascadeSnapshot(
      database,
      input.nodeId,
      true,
    );
    if (!snapshot) return null;
    const row = (
      await executeRows<Record<string, unknown>>(
        database,
        deleteNodeCascadeStatement({
          nodeId: input.nodeId,
          plans: snapshot.plans,
        }),
      )
    )[0];
    return row ? { node: mapNodeRow(row), plans: snapshot.plans } : null;
  }

  for (let attempt = 0; attempt < MAX_CONTENTION_RETRIES; attempt += 1) {
    const snapshot = await readNodeCascadeSnapshot(
      database,
      input.nodeId,
      false,
    );
    if (!snapshot) return null;
    const row = (
      await executeRows<Record<string, unknown>>(
        database,
        deleteNodeCascadeStatement({
          nodeId: input.nodeId,
          plans: snapshot.plans,
        }),
      )
    )[0];
    if (row) {
      return { node: mapNodeRow(row), plans: snapshot.plans };
    }
    const stillPresent = await database
      .select({ id: node.id })
      .from(node)
      .where(eq(node.id, input.nodeId));
    if (stillPresent.length === 0) return null;
  }
  throw new Error(
    `Node ${input.nodeId} delete did not settle after ${MAX_CONTENTION_RETRIES} attempts`,
  );
}

/** Reads a group's current membership rows ordered by `(position, nodeId)`. */
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
