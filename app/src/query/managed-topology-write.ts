import { compareStableIds } from "@blossom/domain/group-membership";
import {
  MANAGED_NETWORKING_ACTIVATION_ENABLED,
  MANAGED_TOPOLOGY_ID,
  type ManagedRolloutState,
} from "@blossom/domain/managed-networking";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { type Database, db } from "@/db";
import {
  type ListenerClaim,
  listenerClaim,
  managedConfigVersion,
  managedRollout,
  managedRolloutClaim,
  managedRolloutStage,
  managedServerState,
  managedTopology,
} from "@/db/managed-network-schema";
import {
  configChange,
  configChangeServer,
  type NewNode,
  type Node,
  node,
  nodeGroup,
  proxyGroup,
  server,
} from "@/db/proxy-schema";
import {
  isNodeConfigChange,
  snapshotNodeForGate,
} from "@/lib/node-config-change";
import type { JsonValue } from "@/orpc/proxy/schema";
import { canonicalize } from "@/orpc/proxy/singbox";
import {
  deleteNodeCascadeCtes,
  mapNodeRow,
  readNodeCascadeSnapshot,
  type NodeCascadeSnapshot,
} from "@/query/group-membership-write";
import {
  isManagedSubscriberPrevious,
  MANAGED_SUBSCRIBER_INTENT_VERSION,
  parseManagedSubscriberIntent,
  type ManagedSubscriberIntent,
  type ManagedSubscriberPrevious,
} from "@/query/managed-subscriber-intent";

/** Fields accepted by a legacy or staged node write, excluding identity and timestamps. */
export type NodeWriteValues = Partial<
  Omit<NewNode, "id" | "createdAt" | "updatedAt">
>;

/**
 * Shared persistence boundary for managed networking (Task 06: managed
 * persistence and writer boundary).
 *
 * Invariants for every writer:
 *  - Managed activation stays off while `MANAGED_NETWORKING_ACTIVATION_ENABLED`
 *    is false: no rollout, stage pointer or peer claim may be written, and
 *    `commitStage` answers `activation_disabled`.
 *  - Any graph-changing write compares and bumps
 *    `managed_topology.generation` in the same statement or transaction as its
 *    graph change. A conflict repeats validation; it is never retried blindly
 *    after the caller's expected generation is stale.
 *  - Rollout claims (`managed_rollout_claim`) are acquired in stable server ID
 *    order in the same atomic unit as the topology CAS.
 *  - Subscriber listener claims are derived from `node` by trigger. Writers
 *    never insert them; peer claims are written only through this module.
 *  - For staged subscriber changes only `commitStage` writes subscriber rows.
 *    It composes the rollout ordinal CAS, node and membership writes (through
 *    the group-membership statements, never a second node-delete path), the
 *    stage pointer, `server.desired_revision_seq` bumps, the publish-gate
 *    record and the replaced rows in `subscriber_previous` atomically.
 *    Compensation uses the same path and preserves newer entitlement changes.
 *  - Legacy structural node writers (UI `nodes.ts`, MCP `mcp-tools.ts`) return
 *    a `LegacyStructuralWriteRejection` instead of writing a node that a
 *    pointed-to `managed_config_version.subscriber_node_ids` references or
 *    whose server holds a rollout claim. Credential rotation and entitlement
 *    revocation are never blocked.
 */

const MAX_CONTENTION_RETRIES = 32;
const ACTIVE_ROLLOUT_STATES = sql`('applying', 'stalled', 'recovering')`;

export interface ManagedWriteOptions {
  database?: Database;
  /**
   * Test seam and future rollout gate. Defaults to the domain constant, which
   * stays false until Task 08 flips it together with stage confirmation.
   */
  activationEnabled?: boolean;
}

interface ManagedWriteContext {
  database: Database;
  activationEnabled: boolean;
}

function resolveWriter(options: ManagedWriteOptions = {}): ManagedWriteContext {
  return {
    database: options.database ?? db,
    activationEnabled:
      options.activationEnabled ?? MANAGED_NETWORKING_ACTIVATION_ENABLED,
  };
}

async function executeRows<T extends Record<string, unknown>>(
  database: Database,
  statement: SQL,
): Promise<T[]> {
  const result = await database.execute<T>(statement, "objects");
  if (Array.isArray(result)) {
    return result;
  }
  const wrapped = result as unknown as { rows?: T[] };
  return wrapped.rows ?? [];
}

function jsonParam(value: unknown): SQL {
  return sql`${JSON.stringify(value ?? null)}::jsonb`;
}

function numeric(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function stableServerIds(serverIds: readonly string[]): string[] {
  return [...new Set(serverIds)].sort(compareStableIds);
}

// --- Topology fence ---------------------------------------------------------

export type TopologyGenerationResult =
  | { ok: true; generation: number }
  | { ok: false; reason: "topology_conflict"; currentGeneration: number };

/**
 * `topology_cas` CTE: bumps the singleton generation only if it still equals
 * `expectedGeneration` (and any caller-supplied graph guard holds) and returns
 * the new value. Compose it before data-modifying CTEs and gate them on its
 * row.
 */
export function topologyGenerationCasCte(
  expectedGeneration: number,
  guard?: SQL,
): SQL {
  return sql`topology_cas AS (
    UPDATE ${managedTopology}
    SET ${sql.identifier(managedTopology.generation.name)} = ${managedTopology.generation} + 1,
        ${sql.identifier(managedTopology.updatedAt.name)} = now()
    WHERE ${managedTopology.id} = ${MANAGED_TOPOLOGY_ID}
      AND ${managedTopology.generation} = ${expectedGeneration}::integer
      ${guard ? sql`AND ${guard}` : sql``}
    RETURNING ${managedTopology.generation} AS generation
  )`;
}

export async function readTopologyGeneration(
  database: Database = db,
): Promise<number> {
  const [row] = await database
    .select({ generation: managedTopology.generation })
    .from(managedTopology)
    .where(eq(managedTopology.id, MANAGED_TOPOLOGY_ID));
  if (!row) {
    throw new Error("managed_topology singleton row is missing");
  }
  return row.generation;
}

/** Standalone compare-and-bump for callers inside an interactive transaction. */
export async function compareAndBumpTopologyGeneration(
  expectedGeneration: number,
  database: Database = db,
): Promise<TopologyGenerationResult> {
  const [row] = await database
    .update(managedTopology)
    .set({
      generation: sql`${managedTopology.generation} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(managedTopology.id, MANAGED_TOPOLOGY_ID),
        eq(managedTopology.generation, expectedGeneration),
      ),
    )
    .returning({ generation: managedTopology.generation });
  if (row) {
    return { ok: true, generation: row.generation };
  }
  return {
    ok: false,
    reason: "topology_conflict",
    currentGeneration: await readTopologyGeneration(database),
  };
}

// --- Listener claims --------------------------------------------------------

export async function readListenerClaim(
  serverId: string,
  port: number,
  database: Database = db,
): Promise<ListenerClaim | null> {
  const [row] = await database
    .select()
    .from(listenerClaim)
    .where(
      and(eq(listenerClaim.serverId, serverId), eq(listenerClaim.port, port)),
    );
  return row ?? null;
}

/** Ports reserved on a server, for conflict previews. */
export async function listListenerClaims(
  serverId: string,
  database: Database = db,
): Promise<ListenerClaim[]> {
  return database
    .select()
    .from(listenerClaim)
    .where(eq(listenerClaim.serverId, serverId))
    .orderBy(asc(listenerClaim.port));
}

export interface ListenerClaimConflict {
  ok: false;
  reason: "listener_claim_conflict";
  serverId: string;
  port: number;
  ownerKind: ListenerClaim["ownerKind"];
  ownerId: string;
}

export interface PeerListenerClaimInput {
  serverId: string;
  port: number;
  ownerId: string;
  expectedTopologyGeneration: number;
}

export type PeerListenerClaimResult =
  | {
      ok: true;
      serverId: string;
      port: number;
      ownerId: string;
      generation: number;
    }
  | { ok: false; reason: "activation_disabled" }
  | { ok: false; reason: "topology_conflict"; currentGeneration: number }
  | ListenerClaimConflict;

function claimConflict(row: ListenerClaim): ListenerClaimConflict {
  return {
    ok: false,
    reason: "listener_claim_conflict",
    serverId: row.serverId,
    port: row.port,
    ownerKind: row.ownerKind,
    ownerId: row.ownerId,
  };
}

function assertPeerListenerInput(input: PeerListenerClaimInput): void {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error(
      "Peer listener port must be an integer between 1 and 65535",
    );
  }
  if (input.ownerId.trim().length === 0) {
    throw new Error("Peer listener claim owner id must not be empty");
  }
}

/**
 * Reserves one peer listener port. The topology CAS and claim insert share one
 * statement, so a stale reservation or a port conflict leaves both untouched.
 */
export async function reservePeerListenerClaim(
  input: PeerListenerClaimInput,
  options: ManagedWriteOptions = {},
): Promise<PeerListenerClaimResult> {
  const { database, activationEnabled } = resolveWriter(options);
  if (!activationEnabled) return { ok: false, reason: "activation_disabled" };
  assertPeerListenerInput(input);

  const existing = await readListenerClaim(
    input.serverId,
    input.port,
    database,
  );
  if (existing) {
    if (
      existing.ownerKind === "peer_inbound" &&
      existing.ownerId === input.ownerId
    ) {
      return {
        ok: true,
        serverId: input.serverId,
        port: input.port,
        ownerId: input.ownerId,
        generation: await readTopologyGeneration(database),
      };
    }
    return claimConflict(existing);
  }

  let rows: Record<string, unknown>[];
  try {
    rows = await executeRows(
      database,
      sql`
        WITH ${topologyGenerationCasCte(input.expectedTopologyGeneration)},
        claimed AS (
          INSERT INTO ${listenerClaim} (
            ${sql.identifier(listenerClaim.serverId.name)},
            ${sql.identifier(listenerClaim.port.name)},
            ${sql.identifier(listenerClaim.ownerKind.name)},
            ${sql.identifier(listenerClaim.ownerId.name)}
          )
          SELECT ${input.serverId}::text,
                 ${input.port}::integer,
                 'peer_inbound',
                 ${input.ownerId}::text
          FROM topology_cas
          WHERE NOT EXISTS (
            SELECT 1 FROM ${listenerClaim}
            WHERE ${listenerClaim.serverId} = ${input.serverId}::text
              AND ${listenerClaim.port} = ${input.port}::integer
          )
          RETURNING ${listenerClaim}.*
        )
        SELECT claimed.*, topology_cas.generation
        FROM claimed CROSS JOIN topology_cas
      `,
    );
  } catch (error) {
    const current = await readListenerClaim(
      input.serverId,
      input.port,
      database,
    );
    if (current) return claimConflict(current);
    throw error;
  }

  if (rows[0]) {
    return {
      ok: true,
      serverId: input.serverId,
      port: input.port,
      ownerId: input.ownerId,
      generation: numeric(rows[0].generation),
    };
  }
  return {
    ok: false,
    reason: "topology_conflict",
    currentGeneration: await readTopologyGeneration(database),
  };
}

export type PeerListenerReleaseResult =
  | { ok: true; generation: number }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "topology_conflict"; currentGeneration: number };

/** Releases a peer listener port. Cleanup remains available while activation is off. */
export async function releasePeerListenerClaim(
  input: {
    serverId: string;
    port: number;
    ownerId: string;
    expectedTopologyGeneration?: number;
  },
  database: Database = db,
): Promise<PeerListenerReleaseResult> {
  const expected =
    input.expectedTopologyGeneration ??
    (await readTopologyGeneration(database));
  const rows = await executeRows(
    database,
    sql`
      WITH claim_guard AS (
        SELECT 1 FROM ${listenerClaim}
        WHERE ${listenerClaim.serverId} = ${input.serverId}::text
          AND ${listenerClaim.port} = ${input.port}::integer
          AND ${listenerClaim.ownerKind} = 'peer_inbound'
          AND ${listenerClaim.ownerId} = ${input.ownerId}::text
      ),
      ${topologyGenerationCasCte(expected, sql`EXISTS (SELECT 1 FROM claim_guard)`)},
      released AS (
        DELETE FROM ${listenerClaim}
        WHERE ${listenerClaim.serverId} = ${input.serverId}::text
          AND ${listenerClaim.port} = ${input.port}::integer
          AND ${listenerClaim.ownerKind} = 'peer_inbound'
          AND ${listenerClaim.ownerId} = ${input.ownerId}::text
          AND EXISTS (SELECT 1 FROM topology_cas)
        RETURNING 1
      )
      SELECT topology_cas.generation
      FROM released CROSS JOIN topology_cas
    `,
  );
  if (rows[0]) {
    return { ok: true, generation: numeric(rows[0].generation) };
  }
  const current = await readListenerClaim(input.serverId, input.port, database);
  if (current) {
    return {
      ok: false,
      reason: "topology_conflict",
      currentGeneration: await readTopologyGeneration(database),
    };
  }
  return { ok: false, reason: "not_found" };
}

// --- Rollout admission and stable claims ------------------------------------

export interface ManagedRolloutAdmissionStage {
  ordinal: number;
  serverId: string;
  configVersionId: string;
  previousConfigVersionId?: string | null;
  managedFingerprint: string;
  deadlineAt?: Date | string | null;
  subscriberIntent?: JsonValue | null;
}

export interface ManagedRolloutAdmissionInput {
  rolloutId: string;
  expectedTopologyGeneration: number;
  stageCount: number;
  requestedByUserId?: string | null;
  /** Servers to claim. Claims are inserted in stable server ID order. */
  serverIds: readonly string[];
  /** Optional stages inserted atomically with the claims. */
  stages?: readonly ManagedRolloutAdmissionStage[];
}

export type ManagedRolloutAdmissionResult =
  | {
      ok: true;
      rolloutId: string;
      topologyGeneration: number;
      serverIds: string[];
    }
  | { ok: false; reason: "activation_disabled" }
  | { ok: false; reason: "topology_conflict"; currentGeneration: number }
  | { ok: false; reason: "rollout_exists"; rolloutId: string }
  | {
      ok: false;
      reason: "rollout_claim_conflict";
      serverId: string;
      rolloutId: string;
    }
  | { ok: false; reason: "invalid_admission"; message: string };

function validateAdmission(input: ManagedRolloutAdmissionInput): string | null {
  if (!Number.isInteger(input.stageCount) || input.stageCount < 1) {
    return "stageCount must be a positive integer";
  }
  if (input.serverIds.length === 0) {
    return "at least one server must be claimed";
  }
  if (new Set(input.serverIds).size !== input.serverIds.length) {
    return "serverIds must be distinct";
  }
  const stages = input.stages ?? [];
  if (stages.length > input.stageCount) {
    return "stages exceed stageCount";
  }
  if (stages.length > 0) {
    const ordinals = new Set<number>();
    const claimedServers = new Set(input.serverIds);
    for (const stage of stages) {
      if (
        !Number.isInteger(stage.ordinal) ||
        stage.ordinal < 1 ||
        stage.ordinal > input.stageCount
      ) {
        return "stage ordinals must be integers within stageCount";
      }
      if (ordinals.has(stage.ordinal)) {
        return `duplicate stage ordinal ${stage.ordinal}`;
      }
      if (!claimedServers.has(stage.serverId)) {
        return `stage ${stage.ordinal} server is not claimed`;
      }
      ordinals.add(stage.ordinal);
    }
  }
  return null;
}

function errorField(error: unknown, field: "code" | "constraint" | "message") {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const value = (current as Record<string, unknown>)[field];
    if (typeof value === "string") return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function constraintName(error: unknown): string | undefined {
  return errorField(error, "constraint");
}

/**
 * Admits one rollout and its server claims. The topology CAS, rollout insert
 * and ordered claim insert are one statement on both drivers; a port/server
 * claim conflict cannot leave a partial admission behind.
 */
export async function admitManagedRollout(
  input: ManagedRolloutAdmissionInput,
  options: ManagedWriteOptions = {},
): Promise<ManagedRolloutAdmissionResult> {
  const { database, activationEnabled } = resolveWriter(options);
  if (!activationEnabled) return { ok: false, reason: "activation_disabled" };
  const invalid = validateAdmission(input);
  if (invalid)
    return { ok: false, reason: "invalid_admission", message: invalid };

  const serverIds = stableServerIds(input.serverIds);

  const [existingRollout] = await database
    .select({ id: managedRollout.id })
    .from(managedRollout)
    .where(eq(managedRollout.id, input.rolloutId));
  if (existingRollout) {
    return {
      ok: false,
      reason: "rollout_exists",
      rolloutId: input.rolloutId,
    };
  }
  const existingClaims = await database
    .select({
      serverId: managedRolloutClaim.serverId,
      rolloutId: managedRolloutClaim.rolloutId,
    })
    .from(managedRolloutClaim)
    .where(inArray(managedRolloutClaim.serverId, serverIds))
    .orderBy(asc(managedRolloutClaim.serverId));
  if (existingClaims[0]) {
    return {
      ok: false,
      reason: "rollout_claim_conflict",
      serverId: existingClaims[0].serverId,
      rolloutId: existingClaims[0].rolloutId,
    };
  }

  const stages = (input.stages ?? []).map((stage) => ({
    ordinal: stage.ordinal,
    server_id: stage.serverId,
    config_version_id: stage.configVersionId,
    previous_config_version_id: stage.previousConfigVersionId ?? null,
    managed_fingerprint: stage.managedFingerprint,
    deadline_at:
      stage.deadlineAt instanceof Date
        ? stage.deadlineAt.toISOString()
        : (stage.deadlineAt ?? null),
    subscriber_intent: stage.subscriberIntent ?? null,
  }));
  const stageRowset =
    stages.length > 0
      ? sql`stage_rows AS (
          INSERT INTO ${managedRolloutStage} (
            ${sql.identifier(managedRolloutStage.rolloutId.name)},
            ${sql.identifier(managedRolloutStage.ordinal.name)},
            ${sql.identifier(managedRolloutStage.serverId.name)},
            ${sql.identifier(managedRolloutStage.configVersionId.name)},
            ${sql.identifier(managedRolloutStage.previousConfigVersionId.name)},
            ${sql.identifier(managedRolloutStage.managedFingerprint.name)},
            ${sql.identifier(managedRolloutStage.deadlineAt.name)},
            ${sql.identifier(managedRolloutStage.subscriberIntent.name)}
          )
          SELECT created.id,
                 stages.ordinal,
                 stages.server_id,
                 stages.config_version_id,
                 stages.previous_config_version_id,
                 stages.managed_fingerprint,
                 stages.deadline_at::timestamp,
                 stages.subscriber_intent
          FROM created
          CROSS JOIN jsonb_to_recordset(${jsonParam(stages)}::jsonb) AS stages(
            ordinal integer,
            server_id text,
            config_version_id text,
            previous_config_version_id text,
            managed_fingerprint text,
            deadline_at text,
            subscriber_intent jsonb
          )
          ORDER BY stages.ordinal
          RETURNING 1
        )`
      : sql``;

  const ctes: SQL[] = [
    topologyGenerationCasCte(input.expectedTopologyGeneration),
    sql`created AS (
      INSERT INTO ${managedRollout} (
        ${sql.identifier(managedRollout.id.name)},
        ${sql.identifier(managedRollout.topologyGeneration.name)},
        ${sql.identifier(managedRollout.stageCount.name)},
        ${sql.identifier(managedRollout.requestedByUserId.name)}
      )
      SELECT ${input.rolloutId}::text,
             topology_cas.generation,
             ${input.stageCount}::integer,
             ${input.requestedByUserId ?? null}::text
      FROM topology_cas
      RETURNING ${managedRollout}.*
    )`,
    sql`claimed AS (
      INSERT INTO ${managedRolloutClaim} (
        ${sql.identifier(managedRolloutClaim.serverId.name)},
        ${sql.identifier(managedRolloutClaim.rolloutId.name)}
      )
      SELECT server_id, created.id
      FROM created
      CROSS JOIN jsonb_array_elements_text(${jsonParam(serverIds)}::jsonb)
        AS servers(server_id)
      ORDER BY server_id
      RETURNING ${managedRolloutClaim.serverId} AS server_id
    )`,
  ];
  if (stages.length > 0) ctes.push(stageRowset);

  let rows: Record<string, unknown>[];
  try {
    rows = await executeRows(
      database,
      sql`
        WITH ${sql.join(ctes, sql`, `)}
        SELECT created.id AS rollout_id,
               created.topology_generation AS topology_generation,
               coalesce(
                 (SELECT jsonb_agg(server_id ORDER BY server_id) FROM claimed),
                 '[]'::jsonb
               ) AS server_ids
        FROM created
      `,
    );
  } catch (error) {
    const constraint = constraintName(error);
    const unique =
      errorField(error, "code") === "23505" ||
      constraint === "managed_rollout_pkey" ||
      constraint === "managed_rollout_claim_pkey";
    if (unique) {
      const [existing] = await database
        .select({ id: managedRollout.id })
        .from(managedRollout)
        .where(eq(managedRollout.id, input.rolloutId));
      if (existing) {
        return {
          ok: false,
          reason: "rollout_exists",
          rolloutId: input.rolloutId,
        };
      }
      const conflict = await database
        .select({
          serverId: managedRolloutClaim.serverId,
          rolloutId: managedRolloutClaim.rolloutId,
        })
        .from(managedRolloutClaim)
        .where(inArray(managedRolloutClaim.serverId, serverIds))
        .orderBy(asc(managedRolloutClaim.serverId))
        .limit(1);
      if (conflict[0]) {
        return {
          ok: false,
          reason: "rollout_claim_conflict",
          serverId: conflict[0].serverId,
          rolloutId: conflict[0].rolloutId,
        };
      }
    }
    throw error;
  }

  if (!rows[0]) {
    return {
      ok: false,
      reason: "topology_conflict",
      currentGeneration: await readTopologyGeneration(database),
    };
  }
  return {
    ok: true,
    rolloutId: input.rolloutId,
    topologyGeneration: numeric(rows[0].topology_generation),
    serverIds,
  };
}

export type ManagedRolloutClaimReleaseResult =
  | { ok: true; serverIds: string[]; topologyGeneration: number | null }
  | { ok: false; reason: "topology_conflict"; currentGeneration: number };

/**
 * Releases claims once recovery proves which routes and credentials remain
 * active. Task 06 exposes the write; Task 08 owns the transition that calls it.
 */
export async function releaseManagedRolloutClaims(
  rolloutId: string,
  options: ManagedWriteOptions & {
    expectedTopologyGeneration?: number;
  } = {},
): Promise<ManagedRolloutClaimReleaseResult> {
  const { database } = resolveWriter(options);
  const reserved = await database
    .select({ serverId: managedRolloutClaim.serverId })
    .from(managedRolloutClaim)
    .where(eq(managedRolloutClaim.rolloutId, rolloutId))
    .orderBy(asc(managedRolloutClaim.serverId));
  if (reserved.length === 0) {
    return {
      ok: true,
      serverIds: [],
      topologyGeneration: null,
    };
  }
  const expected =
    options.expectedTopologyGeneration ??
    (await readTopologyGeneration(database));
  const rows = await executeRows(
    database,
    sql`
      WITH claim_guard AS (
        SELECT 1 FROM ${managedRolloutClaim}
        WHERE ${managedRolloutClaim.rolloutId} = ${rolloutId}::text
      ),
      ${topologyGenerationCasCte(expected, sql`EXISTS (SELECT 1 FROM claim_guard)`)},
      released AS (
        DELETE FROM ${managedRolloutClaim}
        WHERE ${managedRolloutClaim.rolloutId} = ${rolloutId}::text
          AND EXISTS (SELECT 1 FROM topology_cas)
        RETURNING ${managedRolloutClaim.serverId} AS server_id
      )
      SELECT topology_cas.generation,
             coalesce(
               (SELECT jsonb_agg(server_id ORDER BY server_id) FROM released),
               '[]'::jsonb
             ) AS server_ids
      FROM released CROSS JOIN topology_cas
    `,
  );
  if (!rows[0]) {
    return {
      ok: false,
      reason: "topology_conflict",
      currentGeneration: await readTopologyGeneration(database),
    };
  }
  return {
    ok: true,
    serverIds: parseStringArray(rows[0].server_ids),
    topologyGeneration: numeric(rows[0].generation),
  };
}

function parseStringArray(value: unknown): string[] {
  if (typeof value === "string") return JSON.parse(value) as string[];
  return (value as string[] | null) ?? [];
}

// --- Legacy UI / MCP structural fence ---------------------------------------

export type LegacyStructuralWriteRejection =
  | {
      ok: false;
      reason: "managed_reference";
      nodeId: string;
      configVersionIds: string[];
    }
  | {
      ok: false;
      reason: "rollout_in_progress";
      serverId: string;
      rolloutId: string;
    };

export interface LegacyStructuralNodeWriteFenceInput {
  nodeId?: string | null;
  serverIds: readonly string[];
}

/** Structural fields a legacy writer may not change outside a staged update. */
export function isLegacyNodeStructuralChange(
  before: Pick<
    Node,
    | "serverId"
    | "enabled"
    | "listenPort"
    | "protocol"
    | "settings"
    | "certificateId"
    | "tlsServerName"
  >,
  after: Pick<
    Node,
    | "serverId"
    | "enabled"
    | "listenPort"
    | "protocol"
    | "settings"
    | "certificateId"
    | "tlsServerName"
  >,
): boolean {
  return (
    before.serverId !== after.serverId ||
    before.enabled !== after.enabled ||
    before.listenPort !== after.listenPort ||
    before.protocol !== after.protocol ||
    before.certificateId !== after.certificateId ||
    before.tlsServerName !== after.tlsServerName ||
    canonicalize(before.settings) !== canonicalize(after.settings)
  );
}

function referencesManagedConfigVersionSql(nodeId: string): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM ${managedConfigVersion}
    WHERE ${managedConfigVersion.subscriberNodeIds} @> ${jsonParam([nodeId])}
      AND (
        EXISTS (
          SELECT 1 FROM ${managedServerState}
          WHERE ${managedServerState.desiredConfigVersionId} = ${managedConfigVersion.id}
             OR ${managedServerState.appliedConfigVersionId} = ${managedConfigVersion.id}
        )
        OR EXISTS (
          SELECT 1
          FROM ${managedRolloutStage}
          JOIN ${managedRollout}
            ON ${managedRollout.id} = ${managedRolloutStage.rolloutId}
          WHERE (
            ${managedRolloutStage.configVersionId} = ${managedConfigVersion.id}
            OR ${managedRolloutStage.previousConfigVersionId} = ${managedConfigVersion.id}
          )
            AND ${managedRollout.state} IN ${ACTIVE_ROLLOUT_STATES}
            AND ${managedRolloutStage.state} NOT IN ('failed', 'superseded')
        )
      )
  )`;
}

function activeRolloutClaimSql(serverIds: readonly string[]): SQL | null {
  if (serverIds.length === 0) return null;
  return sql`EXISTS (
    SELECT 1 FROM ${managedRolloutClaim}
    WHERE ${managedRolloutClaim.serverId} IN (
      SELECT value FROM jsonb_array_elements_text(${jsonParam(serverIds)}::jsonb)
    )
  )`;
}

function referencedVersionsSql(nodeId: string): SQL {
  return sql`
    SELECT ${managedConfigVersion.id} AS id
    FROM ${managedConfigVersion}
    WHERE ${managedConfigVersion.subscriberNodeIds} @> ${jsonParam([nodeId])}
      AND (
        EXISTS (
          SELECT 1 FROM ${managedServerState}
          WHERE ${managedServerState.desiredConfigVersionId} = ${managedConfigVersion.id}
             OR ${managedServerState.appliedConfigVersionId} = ${managedConfigVersion.id}
        )
        OR EXISTS (
          SELECT 1
          FROM ${managedRolloutStage}
          JOIN ${managedRollout}
            ON ${managedRollout.id} = ${managedRolloutStage.rolloutId}
          WHERE (
            ${managedRolloutStage.configVersionId} = ${managedConfigVersion.id}
            OR ${managedRolloutStage.previousConfigVersionId} = ${managedConfigVersion.id}
          )
            AND ${managedRollout.state} IN ${ACTIVE_ROLLOUT_STATES}
            AND ${managedRolloutStage.state} NOT IN ('failed', 'superseded')
        )
      )
    ORDER BY ${managedConfigVersion.id}
  `;
}

/**
 * Reads the fence a legacy structural writer must pass before touching a
 * subscriber ingress. The caller then performs the matching topology CAS in
 * the same statement, so a concurrent admission either wins the CAS (and this
 * check is re-run against its claim) or waits behind the legacy write.
 */
export async function readLegacyStructuralNodeWriteFence(
  input: LegacyStructuralNodeWriteFenceInput,
  database: Database = db,
): Promise<LegacyStructuralWriteRejection | null> {
  const serverIds = stableServerIds(input.serverIds);
  if (serverIds.length > 0) {
    const claims = await database
      .select({
        serverId: managedRolloutClaim.serverId,
        rolloutId: managedRolloutClaim.rolloutId,
      })
      .from(managedRolloutClaim)
      .where(inArray(managedRolloutClaim.serverId, serverIds))
      .orderBy(asc(managedRolloutClaim.serverId));
    if (claims[0]) {
      return {
        ok: false,
        reason: "rollout_in_progress",
        serverId: claims[0].serverId,
        rolloutId: claims[0].rolloutId,
      };
    }
  }

  if (!input.nodeId) return null;
  const rows = await executeRows<{ id: string }>(
    database,
    referencedVersionsSql(input.nodeId),
  );
  if (rows.length === 0) return null;
  return {
    ok: false,
    reason: "managed_reference",
    nodeId: input.nodeId,
    configVersionIds: rows.map((row) => row.id),
  };
}

function legacyFenceSql(input: LegacyStructuralNodeWriteFenceInput): SQL {
  const parts: SQL[] = [];
  const claim = activeRolloutClaimSql(stableServerIds(input.serverIds));
  if (claim) parts.push(sql`NOT ${claim}`);
  if (input.nodeId) {
    parts.push(sql`NOT ${referencesManagedConfigVersionSql(input.nodeId)}`);
  }
  return parts.length > 0 ? sql.join(parts, sql` AND `) : sql`TRUE`;
}

// --- Legacy structural node writes ------------------------------------------

export type LegacyNodeWriteResult =
  | { ok: true; node: Node; topologyGeneration: number }
  | { ok: false; reason: "not_found" }
  | LegacyStructuralWriteRejection
  | ListenerClaimConflict;

export type LegacyNodeWriteRejection =
  | LegacyStructuralWriteRejection
  | ListenerClaimConflict;

/**
 * Thrown inside an existing node-postgres transaction so a fence rejection
 * rolls back the binding writes that precede the node statement. Callers catch
 * it, compensate neon-http binding writes, and return the typed rejection.
 */
export class LegacyNodeWriteRejectedError extends Error {
  readonly rejection: LegacyNodeWriteRejection;

  constructor(rejection: LegacyNodeWriteRejection) {
    super(
      rejection.reason === "managed_reference"
        ? `Node ${rejection.nodeId} is referenced by a managed configuration`
        : rejection.reason === "rollout_in_progress"
          ? `Server ${rejection.serverId} has an active rollout`
          : `Listener port ${rejection.port} is already claimed`,
    );
    this.name = "LegacyNodeWriteRejectedError";
    this.rejection = rejection;
  }
}

export type LegacyNodeDeleteResult =
  | {
      ok: true;
      node: Node;
      plans: NodeCascadeSnapshot["plans"];
      topologyGeneration: number;
    }
  | { ok: false; reason: "not_found" }
  | LegacyStructuralWriteRejection
  | ListenerClaimConflict;

function nodeUpdateSet(values: NodeWriteValues): SQL {
  const sets: SQL[] = [];
  if (values.name !== undefined) {
    sets.push(sql`${sql.identifier(node.name.name)} = ${values.name}::text`);
  }
  if (values.remark !== undefined) {
    sets.push(
      sql`${sql.identifier(node.remark.name)} = ${values.remark}::text`,
    );
  }
  if (values.tags !== undefined) {
    sets.push(
      sql`${sql.identifier(node.tags.name)} = ${jsonParam(values.tags)}`,
    );
  }
  if (values.enabled !== undefined) {
    sets.push(
      sql`${sql.identifier(node.enabled.name)} = ${values.enabled}::boolean`,
    );
  }
  if (values.serverId !== undefined) {
    sets.push(
      sql`${sql.identifier(node.serverId.name)} = ${values.serverId}::text`,
    );
  }
  if (values.address !== undefined) {
    sets.push(
      sql`${sql.identifier(node.address.name)} = ${values.address}::text`,
    );
  }
  if (values.listenPort !== undefined) {
    sets.push(
      sql`${sql.identifier(node.listenPort.name)} = ${values.listenPort}::integer`,
    );
  }
  if (values.protocol !== undefined) {
    sets.push(
      sql`${sql.identifier(node.protocol.name)} = ${values.protocol}::text`,
    );
  }
  if (values.certificateId !== undefined) {
    sets.push(
      sql`${sql.identifier(node.certificateId.name)} = ${values.certificateId}::text`,
    );
  }
  if (values.tlsServerName !== undefined) {
    sets.push(
      sql`${sql.identifier(node.tlsServerName.name)} = ${values.tlsServerName}::text`,
    );
  }
  if (values.settings !== undefined) {
    sets.push(
      sql`${sql.identifier(node.settings.name)} = ${jsonParam(values.settings)}`,
    );
  }
  sets.push(sql`${sql.identifier(node.updatedAt.name)} = now()`);
  return sql.join(sets, sql`, `);
}

function legacyInsertNodeStatement(input: {
  values: NodeWriteValues & { id: string; name: string; serverId: string };
  expectedTopologyGeneration: number;
  fence: SQL;
}): SQL {
  const { values } = input;
  return sql`
    WITH ${topologyGenerationCasCte(
      input.expectedTopologyGeneration,
      input.fence,
    )},
    written AS (
      INSERT INTO ${node} (
        ${sql.identifier(node.id.name)},
        ${sql.identifier(node.name.name)},
        ${sql.identifier(node.remark.name)},
        ${sql.identifier(node.tags.name)},
        ${sql.identifier(node.enabled.name)},
        ${sql.identifier(node.serverId.name)},
        ${sql.identifier(node.address.name)},
        ${sql.identifier(node.listenPort.name)},
        ${sql.identifier(node.protocol.name)},
        ${sql.identifier(node.certificateId.name)},
        ${sql.identifier(node.tlsServerName.name)},
        ${sql.identifier(node.settings.name)}
      )
      SELECT ${values.id}::text,
             ${values.name}::text,
             ${values.remark ?? null}::text,
             ${jsonParam(values.tags ?? [])},
             ${values.enabled ?? true}::boolean,
             ${values.serverId}::text,
             ${values.address ?? null}::text,
             ${values.listenPort ?? 0}::integer,
             ${values.protocol ?? ""}::text,
             ${values.certificateId ?? null}::text,
             ${values.tlsServerName ?? null}::text,
             ${jsonParam(values.settings ?? {})}
      FROM topology_cas
      RETURNING ${node}.*
    )
    SELECT written.* FROM written
  `;
}

function legacyUpdateNodeStatement(input: {
  nodeId: string;
  values: NodeWriteValues;
  expectedTopologyGeneration: number;
  fence: SQL;
}): SQL {
  return sql`
    WITH ${topologyGenerationCasCte(
      input.expectedTopologyGeneration,
      input.fence,
    )},
    written AS (
      UPDATE ${node}
      SET ${nodeUpdateSet(input.values)}
      FROM topology_cas
      WHERE ${node.id} = ${input.nodeId}::text
      RETURNING ${node}.*
    )
    SELECT written.* FROM written
  `;
}

function isListenerConflict(error: unknown): boolean {
  return (
    errorField(error, "code") === "23505" ||
    constraintName(error) === "listener_claim_pkey" ||
    constraintName(error) === "node_server_listen_port_unique"
  );
}

async function resolveListenerConflict(
  database: Database,
  serverId: string,
  port: number,
): Promise<ListenerClaimConflict | null> {
  const claim = await readListenerClaim(serverId, port, database);
  if (!claim) return null;
  return claimConflict(claim);
}

async function tryLegacyNodeStatement(
  database: Database,
  statement: SQL,
  serverIds: readonly string[],
  port: number,
): Promise<{ row: Record<string, unknown> } | ListenerClaimConflict | null> {
  try {
    const rows = await executeRows(database, statement);
    return rows[0] ? { row: rows[0] } : null;
  } catch (error) {
    for (const serverId of stableServerIds(serverIds)) {
      const conflict = await resolveListenerConflict(database, serverId, port);
      if (conflict && isListenerConflict(error)) return conflict;
    }
    throw error;
  }
}

function valuesServerIds(
  existing: Node | null,
  values: NodeWriteValues,
): string[] {
  return stableServerIds([
    ...(existing ? [existing.serverId] : []),
    ...(values.serverId ? [values.serverId] : []),
  ]);
}

/**
 * Writes one new or updated subscriber node through the topology fence. The
 * caller passes already validated settings and certificate checks; this helper
 * owns generation CAS, claim/reference rejection and the single node statement.
 */
export async function writeLegacySubscriberNode(
  input:
    | { kind: "create"; values: NodeWriteValues & { id: string } }
    | { kind: "update"; nodeId: string; values: NodeWriteValues },
  options: ManagedWriteOptions = {},
): Promise<LegacyNodeWriteResult> {
  const { database } = resolveWriter(options);
  for (let attempt = 0; attempt < MAX_CONTENTION_RETRIES; attempt += 1) {
    let existing: Node | null = null;
    if (input.kind === "update") {
      const [row] = await database
        .select()
        .from(node)
        .where(eq(node.id, input.nodeId));
      if (!row) return { ok: false, reason: "not_found" };
      existing = row;
    }

    const serverIds = valuesServerIds(existing, input.values);
    const rejection = await readLegacyStructuralNodeWriteFence(
      {
        nodeId: input.kind === "update" ? input.nodeId : null,
        serverIds,
      },
      database,
    );
    if (rejection) return rejection;

    const generation = await readTopologyGeneration(database);
    const fence = legacyFenceSql({
      nodeId: input.kind === "update" ? input.nodeId : null,
      serverIds,
    });
    const statement =
      input.kind === "create"
        ? legacyInsertNodeStatement({
            values: input.values as NodeWriteValues & {
              id: string;
              name: string;
              serverId: string;
            },
            expectedTopologyGeneration: generation,
            fence,
          })
        : legacyUpdateNodeStatement({
            nodeId: input.nodeId,
            values: input.values,
            expectedTopologyGeneration: generation,
            fence,
          });

    const result = await tryLegacyNodeStatement(
      database,
      statement,
      serverIds,
      input.values.listenPort ?? existing?.listenPort ?? 0,
    );
    if (result && "ok" in result) return result;
    if (result?.row) {
      return {
        ok: true,
        node: mapNodeRow(result.row),
        topologyGeneration: generation + 1,
      };
    }

    if (input.kind === "update") {
      const [current] = await database
        .select({ id: node.id })
        .from(node)
        .where(eq(node.id, input.nodeId));
      if (!current) return { ok: false, reason: "not_found" };
    }
    if ((await readTopologyGeneration(database)) === generation) {
      const currentRejection = await readLegacyStructuralNodeWriteFence(
        {
          nodeId: input.kind === "update" ? input.nodeId : null,
          serverIds,
        },
        database,
      );
      if (currentRejection) return currentRejection;
    }
  }
  throw new Error(
    `Legacy node write did not settle after ${MAX_CONTENTION_RETRIES} attempts`,
  );
}

/** Deletes one subscriber node and its task-02 membership cascade through the fence. */
export async function deleteLegacySubscriberNode(
  input: { nodeId: string },
  options: ManagedWriteOptions = {},
): Promise<LegacyNodeDeleteResult> {
  const { database } = resolveWriter(options);
  for (let attempt = 0; attempt < MAX_CONTENTION_RETRIES; attempt += 1) {
    const snapshot = await readNodeCascadeSnapshot(
      database,
      input.nodeId,
      false,
    );
    if (!snapshot) return { ok: false, reason: "not_found" };

    const serverIds = [snapshot.node.serverId];
    const rejection = await readLegacyStructuralNodeWriteFence(
      { nodeId: input.nodeId, serverIds },
      database,
    );
    if (rejection) return rejection;

    const generation = await readTopologyGeneration(database);
    const groupGuards = snapshot.plans.map((plan) => ({
      group_id: plan.groupId,
      revision: plan.previousRevision,
    }));
    const groupGuard =
      groupGuards.length > 0
        ? sql`NOT EXISTS (
            SELECT 1
            FROM jsonb_to_recordset(${jsonParam(groupGuards)}::jsonb)
              AS guards(group_id text, revision integer)
            JOIN ${proxyGroup}
              ON ${proxyGroup.id} = guards.group_id
            WHERE ${proxyGroup.revision} <> guards.revision
          )`
        : sql`TRUE`;
    const ctes = [
      topologyGenerationCasCte(
        generation,
        sql`${groupGuard} AND ${legacyFenceSql({ nodeId: input.nodeId, serverIds })}`,
      ),
      ...deleteNodeCascadeCtes({
        nodeId: input.nodeId,
        plans: snapshot.plans,
        guard: sql`EXISTS (SELECT 1 FROM topology_cas)`,
      }),
    ];
    const rows = await executeRows<Record<string, unknown>>(
      database,
      sql`
        WITH ${sql.join(ctes, sql`, `)}
        SELECT target.* FROM target
      `,
    );
    if (rows[0]) {
      return {
        ok: true,
        node: mapNodeRow(rows[0]),
        plans: snapshot.plans,
        topologyGeneration: generation + 1,
      };
    }

    const [stillPresent] = await database
      .select({ id: node.id })
      .from(node)
      .where(eq(node.id, input.nodeId));
    if (!stillPresent) return { ok: false, reason: "not_found" };
    if ((await readTopologyGeneration(database)) === generation) {
      const currentRejection = await readLegacyStructuralNodeWriteFence(
        { nodeId: input.nodeId, serverIds },
        database,
      );
      if (currentRejection) return currentRejection;
    }
  }
  throw new Error(
    `Legacy node delete did not settle after ${MAX_CONTENTION_RETRIES} attempts`,
  );
}

// `proxyGroup` is imported above and shared with the cascade helper.

// --- Stage writer -----------------------------------------------------------

export interface ManagedStageCommitInput {
  rolloutId: string;
  /** `managed_rollout.current_ordinal` the caller read; the advance CAS token. */
  expectedOrdinal: number;
  /**
   * Required when the stage adds or removes a managed forwarding edge, uses a
   * stage-owned subscriber write, or releases a reservation; null otherwise.
   */
  expectedTopologyGeneration: number | null;
}

export interface ManagedStageCompensationInput {
  rolloutId: string;
  ordinal: number;
  failureCode: string;
  /** Optional CAS token; when omitted the writer reads the current generation. */
  expectedTopologyGeneration?: number | null;
}

export type ManagedStageCommitResult =
  | {
      ok: true;
      ordinal: number;
      serverId: string;
      configVersionId: string | null;
      /** `server.desired_revision_seq` after the bump; the stage minimum. */
      revisionSeq: number;
      /** Publish-gate record for a staged subscriber change, if any. */
      changeId: string | null;
      topologyGeneration: number | null;
    }
  | { ok: false; reason: "activation_disabled" }
  | { ok: false; reason: "rollout_not_found" }
  | {
      ok: false;
      reason: "stage_not_found";
      rolloutId: string;
      ordinal: number;
    }
  | {
      ok: false;
      reason: "stage_conflict";
      currentOrdinal: number;
      state?: ManagedRolloutState;
    }
  | { ok: false; reason: "topology_conflict"; currentGeneration: number }
  | { ok: false; reason: "rollout_claim_missing"; serverId: string }
  | { ok: false; reason: "invalid_intent"; message: string }
  | { ok: false; reason: "invalid_previous"; message: string }
  | ListenerClaimConflict;

/**
 * Atomic stage writer. Both methods run the whole mutation as one
 * data-modifying statement on node-postgres and neon-http; the statement's
 * CTEs re-check the rollout ordinal, the server claim, the topology generation
 * and the exact previous rows before any pointer or sequence moves.
 */
export interface ManagedStageWriter {
  commitStage(
    input: ManagedStageCommitInput,
  ): Promise<ManagedStageCommitResult>;
  compensateStage(
    input: ManagedStageCompensationInput,
  ): Promise<ManagedStageCommitResult>;
}

interface ParsedStage {
  stage: typeof managedRolloutStage.$inferSelect;
  intent: ManagedSubscriberIntent | null;
  snapshot: NodeCascadeSnapshot | null;
  gate: {
    subjectId: string;
    prevRow: unknown;
    serverIds: string[];
    changeId: string;
  } | null;
  previous: ManagedSubscriberPrevious | null;
  affectedServerIds: string[];
}

function nodeSettings(value: unknown): Record<string, JsonValue> {
  return (value ?? {}) as Record<string, JsonValue>;
}

function patchToNodeState(
  current: Node,
  patch: Record<string, unknown>,
): Pick<
  Node,
  | "serverId"
  | "enabled"
  | "listenPort"
  | "protocol"
  | "settings"
  | "certificateId"
  | "tlsServerName"
> {
  return {
    serverId: (patch.serverId as string | undefined) ?? current.serverId,
    enabled: (patch.enabled as boolean | undefined) ?? current.enabled,
    listenPort: (patch.listenPort as number | undefined) ?? current.listenPort,
    protocol:
      (patch.protocol as Node["protocol"] | undefined) ?? current.protocol,
    settings: nodeSettings(patch.settings ?? current.settings),
    certificateId:
      patch.certificateId === undefined
        ? current.certificateId
        : (patch.certificateId as string | null),
    tlsServerName:
      patch.tlsServerName === undefined
        ? current.tlsServerName
        : (patch.tlsServerName as string | null),
  };
}

async function loadStage(
  database: Database,
  rolloutId: string,
  ordinal: number,
): Promise<
  | { ok: true; parsed: ParsedStage }
  | { ok: false; reason: "stage_not_found" }
  | { ok: false; reason: "invalid_intent"; message: string }
  | ListenerClaimConflict
> {
  const [stage] = await database
    .select()
    .from(managedRolloutStage)
    .where(
      and(
        eq(managedRolloutStage.rolloutId, rolloutId),
        eq(managedRolloutStage.ordinal, ordinal),
      ),
    );
  if (!stage) return { ok: false, reason: "stage_not_found" };

  const parsedIntent = parseManagedSubscriberIntent(stage.subscriberIntent);
  if (parsedIntent && !parsedIntent.ok) {
    return {
      ok: false,
      reason: "invalid_intent",
      message: parsedIntent.message,
    };
  }
  const intent = parsedIntent?.intent ?? null;

  let snapshot: NodeCascadeSnapshot | null = null;
  let current: Node | null = null;
  if (intent) {
    if (intent.kind === "create_node") {
      current = null;
    } else {
      snapshot = await readNodeCascadeSnapshot(
        database,
        intent.kind === "update_node" ? intent.nodeId : intent.nodeId,
        false,
      );
      if (!snapshot) {
        return { ok: false, reason: "stage_not_found" };
      }
      current = snapshot.node;
    }
  }

  let gate: ParsedStage["gate"] = null;
  let previous: ManagedSubscriberPrevious | null = null;
  let affectedServerIds = [stage.serverId];
  if (intent && intent.kind === "create_node") {
    const values = intent.node;
    affectedServerIds.push(values.serverId);
    if (values.enabled ?? true) {
      gate = {
        subjectId: values.id,
        prevRow: null,
        serverIds: [values.serverId],
        changeId: randomUUID(),
      };
    }
    previous = {
      version: MANAGED_SUBSCRIBER_INTENT_VERSION,
      intent,
      node: null,
      plans: [],
    };
  } else if (intent && current) {
    if (intent.kind === "update_node") {
      const after = patchToNodeState(
        current,
        intent.patch as Record<string, unknown>,
      );
      affectedServerIds.push(after.serverId);
      if (isNodeConfigChange(current, after)) {
        gate = {
          subjectId: intent.nodeId,
          prevRow: await snapshotNodeForGate(database, current),
          serverIds: stableServerIds([current.serverId, after.serverId]),
          changeId: randomUUID(),
        };
      }
      previous = {
        version: MANAGED_SUBSCRIBER_INTENT_VERSION,
        intent,
        node: current,
        plans: [],
      };
    } else {
      affectedServerIds.push(current.serverId);
      if (current.enabled) {
        gate = {
          subjectId: intent.nodeId,
          prevRow: null,
          serverIds: [current.serverId],
          changeId: randomUUID(),
        };
      }
      previous = {
        version: MANAGED_SUBSCRIBER_INTENT_VERSION,
        intent,
        node: current,
        plans: snapshot?.plans ?? [],
      };
    }
  }

  return {
    ok: true,
    parsed: {
      stage,
      intent,
      snapshot,
      gate,
      previous,
      affectedServerIds: stableServerIds(affectedServerIds),
    },
  };
}

function nodeInsertColumns(values: Record<string, unknown>): SQL {
  const createdAt = timestampSql(values.createdAt);
  const updatedAt = timestampSql(values.updatedAt);
  return sql`
    SELECT ${String(values.id)}::text,
           ${String(values.name)}::text,
           ${values.remark ?? null}::text,
           ${jsonParam(values.tags ?? [])},
           ${values.enabled ?? true}::boolean,
           ${String(values.serverId)}::text,
           ${values.address ?? null}::text,
           ${numeric(values.listenPort)}::integer,
           ${String(values.protocol)}::text,
           ${values.certificateId ?? null}::text,
           ${values.tlsServerName ?? null}::text,
           ${jsonParam(values.settings ?? {})},
           ${createdAt},
           ${updatedAt}
  `;
}

function nodeInsertColumnsNoTimestamps(values: Record<string, unknown>): SQL {
  return sql`
    SELECT ${String(values.id)}::text,
           ${String(values.name)}::text,
           ${values.remark ?? null}::text,
           ${jsonParam(values.tags ?? [])},
           ${values.enabled ?? true}::boolean,
           ${String(values.serverId)}::text,
           ${values.address ?? null}::text,
           ${numeric(values.listenPort)}::integer,
           ${String(values.protocol)}::text,
           ${values.certificateId ?? null}::text,
           ${values.tlsServerName ?? null}::text,
           ${jsonParam(values.settings ?? {})}
  `;
}

function timestampSql(value: unknown): SQL {
  if (value instanceof Date) return sql`${value.toISOString()}::timestamp`;
  if (typeof value === "string") return sql`${value}::timestamp`;
  return sql`now()`;
}

function stageNodeWriteCte(
  parsed: ParsedStage,
): { ctes: SQL[]; gateName: string } | null {
  const intent = parsed.intent;
  if (!intent) return null;

  if (intent.kind === "create_node") {
    return {
      gateName: "node_write",
      ctes: [
        sql`node_write AS (
          INSERT INTO ${node} (
            ${sql.identifier(node.id.name)},
            ${sql.identifier(node.name.name)},
            ${sql.identifier(node.remark.name)},
            ${sql.identifier(node.tags.name)},
            ${sql.identifier(node.enabled.name)},
            ${sql.identifier(node.serverId.name)},
            ${sql.identifier(node.address.name)},
            ${sql.identifier(node.listenPort.name)},
            ${sql.identifier(node.protocol.name)},
            ${sql.identifier(node.certificateId.name)},
            ${sql.identifier(node.tlsServerName.name)},
            ${sql.identifier(node.settings.name)}
          )
          ${nodeInsertColumnsNoTimestamps(intent.node)}
          FROM rollout_gate
          RETURNING ${node}.*
        )`,
      ],
    };
  }

  if (intent.kind === "update_node") {
    return {
      gateName: "node_write",
      ctes: [
        sql`node_write AS (
          UPDATE ${node}
          SET ${nodeUpdateSet(intent.patch as NodeWriteValues)}
          FROM rollout_gate
          WHERE ${node.id} = ${intent.nodeId}::text
          RETURNING ${node}.*
        )`,
      ],
    };
  }

  return {
    gateName: "node_write",
    ctes: deleteNodeCascadeCtes({
      nodeId: intent.nodeId,
      plans: parsed.snapshot?.plans ?? [],
      guard: sql`EXISTS (SELECT 1 FROM rollout_gate)`,
      targetName: "node_write",
    }),
  };
}

function stagePreviousJson(parsed: ParsedStage): SQL {
  return jsonParam(parsed.previous);
}

// Shared publish-gate tables imported above.

function stageGateCtes(
  gate: ParsedStage["gate"],
  serverBumpedName: string,
  mutationGateName: string,
): { ctes: SQL[]; changeIdSelect: SQL } {
  if (!gate) {
    return { ctes: [], changeIdSelect: sql`NULL::text` };
  }
  return {
    ctes: [
      sql`gate_change AS (
        INSERT INTO ${configChange} (
          ${sql.identifier(configChange.id.name)},
          ${sql.identifier(configChange.kind.name)},
          ${sql.identifier(configChange.subjectId.name)},
          ${sql.identifier(configChange.prevRow.name)}
        )
        SELECT ${gate.changeId}::text,
               'node',
               ${gate.subjectId}::text,
               ${jsonParam(gate.prevRow)}
        WHERE EXISTS (SELECT 1 FROM ${sql.identifier(mutationGateName)})
          AND EXISTS (SELECT 1 FROM ${sql.identifier(serverBumpedName)})
        RETURNING ${configChange.id} AS id
      )`,
      sql`gate_links AS (
        INSERT INTO ${configChangeServer} (
          ${sql.identifier(configChangeServer.changeId.name)},
          ${sql.identifier(configChangeServer.serverId.name)},
          ${sql.identifier(configChangeServer.revisionSeq.name)}
        )
        SELECT gate_change.id,
               bumped.id,
               bumped.seq
        FROM gate_change
        CROSS JOIN ${sql.identifier(serverBumpedName)} bumped
        WHERE EXISTS (SELECT 1 FROM ${sql.identifier(mutationGateName)})
        RETURNING 1
      )`,
    ],
    changeIdSelect: sql`(SELECT id FROM gate_change)`,
  };
}

function stageUpdateBuiltStatement(input: {
  parsed: ParsedStage;
  targetOrdinal: number;
  expectedTopologyGeneration: number | null;
  rolloutGuard: number;
}): SQL {
  const { parsed, targetOrdinal } = input;
  const stage = parsed.stage;
  const nodeCte = stageNodeWriteCte(parsed);
  const ctes: SQL[] = [];
  ctes.push(sql`stage_guard AS (
    SELECT 1 FROM ${managedRolloutStage}
    WHERE ${managedRolloutStage.rolloutId} = ${stage.rolloutId}::text
      AND ${managedRolloutStage.ordinal} = ${targetOrdinal}::integer
      AND ${managedRolloutStage.state} IN ('pending', 'issued')
  )`);
  ctes.push(sql`claim_guard AS (
    SELECT 1 FROM ${managedRolloutClaim}
    WHERE ${managedRolloutClaim.serverId} = ${stage.serverId}::text
      AND ${managedRolloutClaim.rolloutId} = ${stage.rolloutId}::text
  )`);
  ctes.push(sql`rollout_guard AS (
    SELECT 1 FROM ${managedRollout}
    WHERE ${managedRollout.id} = ${stage.rolloutId}::text
      AND ${managedRollout.currentOrdinal} = ${input.rolloutGuard}::integer
      AND ${managedRollout.state} IN ${ACTIVE_ROLLOUT_STATES}
  )`);
  const preconditionParts: SQL[] = [
    sql`EXISTS (SELECT 1 FROM stage_guard)`,
    sql`EXISTS (SELECT 1 FROM claim_guard)`,
    sql`EXISTS (SELECT 1 FROM rollout_guard)`,
  ];
  if (parsed.snapshot && parsed.intent?.kind === "delete_node") {
    const guards = parsed.snapshot.plans.map((plan) => ({
      group_id: plan.groupId,
      revision: plan.previousRevision,
    }));
    if (guards.length > 0) {
      preconditionParts.push(sql`NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset(${jsonParam(guards)}::jsonb)
          AS guards(group_id text, revision integer)
        JOIN ${proxyGroup} ON ${proxyGroup.id} = guards.group_id
        WHERE ${proxyGroup.revision} <> guards.revision
      )`);
    }
  }
  ctes.push(sql`preconditions AS (
    SELECT 1 WHERE ${sql.join(preconditionParts, sql` AND `)}
  )`);
  if (input.expectedTopologyGeneration !== null) {
    ctes.push(
      topologyGenerationCasCte(
        input.expectedTopologyGeneration,
        sql`EXISTS (SELECT 1 FROM preconditions)`,
      ),
    );
  }
  ctes.push(sql`rollout_gate AS (
    UPDATE ${managedRollout}
    SET ${sql.identifier(managedRollout.currentOrdinal.name)} = ${targetOrdinal}::integer,
        ${sql.identifier(managedRollout.updatedAt.name)} = now()
    WHERE ${managedRollout.id} = ${stage.rolloutId}::text
      AND ${managedRollout.currentOrdinal} = ${input.rolloutGuard}::integer
      AND ${managedRollout.state} IN ${ACTIVE_ROLLOUT_STATES}
      AND EXISTS (SELECT 1 FROM preconditions)
      ${input.expectedTopologyGeneration !== null ? sql`AND EXISTS (SELECT 1 FROM topology_cas)` : sql``}
    RETURNING ${managedRollout}.*
  )`);
  if (nodeCte) ctes.push(...nodeCte.ctes);
  const mutationGateName = "mutation_gate";
  ctes.push(sql`${sql.identifier(mutationGateName)} AS (
    SELECT 1 FROM rollout_gate
    ${nodeCte ? sql`WHERE EXISTS (SELECT 1 FROM ${sql.identifier(nodeCte.gateName)})` : sql``}
  )`);
  const serverBumpedName = "server_bumped";
  ctes.push(sql`${sql.identifier(serverBumpedName)} AS (
    UPDATE ${server}
    SET ${sql.identifier(server.desiredRevisionSeq.name)} = ${server.desiredRevisionSeq} + 1
    WHERE ${server.id} IN (
      SELECT value FROM jsonb_array_elements_text(${jsonParam(parsed.affectedServerIds)}::jsonb)
    )
      AND EXISTS (SELECT 1 FROM mutation_gate)
    RETURNING ${server.id} AS id, ${server.desiredRevisionSeq} AS seq
  )`);
  ctes.push(sql`stage_updated AS (
    UPDATE ${managedRolloutStage}
    SET ${sql.identifier(managedRolloutStage.state.name)} = 'confirmed',
        ${sql.identifier(managedRolloutStage.minRevisionSeq.name)} = (
          SELECT seq FROM server_bumped WHERE id = ${stage.serverId}::text
        ),
        ${sql.identifier(managedRolloutStage.subscriberPrevious.name)} = ${stagePreviousJson(parsed)},
        ${sql.identifier(managedRolloutStage.confirmedAt.name)} = now(),
        ${sql.identifier(managedRolloutStage.updatedAt.name)} = now()
    WHERE ${managedRolloutStage.rolloutId} = ${stage.rolloutId}::text
      AND ${managedRolloutStage.ordinal} = ${targetOrdinal}::integer
      AND EXISTS (SELECT 1 FROM mutation_gate)
    RETURNING ${managedRolloutStage}.*
  )`);
  ctes.push(sql`pointer AS (
    INSERT INTO ${managedServerState} (
      ${sql.identifier(managedServerState.serverId.name)},
      ${sql.identifier(managedServerState.desiredConfigVersionId.name)},
      ${sql.identifier(managedServerState.desiredRolloutId.name)},
      ${sql.identifier(managedServerState.desiredOrdinal.name)},
      ${sql.identifier(managedServerState.desiredMinRevisionSeq.name)},
      ${sql.identifier(managedServerState.desiredManagedFingerprint.name)},
      ${sql.identifier(managedServerState.updatedAt.name)}
    )
    SELECT ${stage.serverId}::text,
           ${stage.configVersionId}::text,
           ${stage.rolloutId}::text,
           ${targetOrdinal}::integer,
           bumped.seq,
           ${stage.managedFingerprint}::text,
           now()
    FROM ${sql.identifier(serverBumpedName)} bumped
    WHERE bumped.id = ${stage.serverId}::text
      AND EXISTS (SELECT 1 FROM ${sql.identifier(mutationGateName)})
    ON CONFLICT (${sql.identifier(managedServerState.serverId.name)}) DO UPDATE SET
      ${sql.identifier(managedServerState.desiredConfigVersionId.name)} = ${stage.configVersionId}::text,
      ${sql.identifier(managedServerState.desiredRolloutId.name)} = ${stage.rolloutId}::text,
      ${sql.identifier(managedServerState.desiredOrdinal.name)} = ${targetOrdinal}::integer,
      ${sql.identifier(managedServerState.desiredMinRevisionSeq.name)} = (
        SELECT seq FROM ${sql.identifier(serverBumpedName)}
        WHERE id = ${stage.serverId}::text
      ),
      ${sql.identifier(managedServerState.desiredManagedFingerprint.name)} = ${stage.managedFingerprint}::text,
      ${sql.identifier(managedServerState.updatedAt.name)} = now()
    RETURNING 1
  )`);
  const gate = stageGateCtes(parsed.gate, serverBumpedName, mutationGateName);
  ctes.push(...gate.ctes);

  return sql`
    WITH ${sql.join(ctes, sql`, `)}
    SELECT ${targetOrdinal}::integer AS ordinal,
           stage_updated.server_id AS server_id,
           stage_updated.config_version_id AS config_version_id,
           bumped.seq AS revision_seq,
           ${gate.changeIdSelect} AS change_id,
           ${
             input.expectedTopologyGeneration !== null
               ? sql`(SELECT generation FROM topology_cas)`
               : sql`NULL::integer`
           } AS topology_generation
    FROM stage_updated
    JOIN ${sql.identifier(serverBumpedName)} bumped
      ON bumped.id = stage_updated.server_id
  `;
}

async function diagnoseCommitFailure(
  database: Database,
  input: ManagedStageCommitInput,
  targetOrdinal: number,
): Promise<ManagedStageCommitResult | null> {
  const [rollout] = await database
    .select()
    .from(managedRollout)
    .where(eq(managedRollout.id, input.rolloutId));
  if (!rollout) return { ok: false, reason: "rollout_not_found" };
  if (rollout.currentOrdinal !== input.expectedOrdinal) {
    return {
      ok: false,
      reason: "stage_conflict",
      currentOrdinal: rollout.currentOrdinal,
      state: rollout.state,
    };
  }
  if (targetOrdinal > rollout.stageCount) {
    return {
      ok: false,
      reason: "stage_not_found",
      rolloutId: input.rolloutId,
      ordinal: targetOrdinal,
    };
  }
  const [stage] = await database
    .select()
    .from(managedRolloutStage)
    .where(
      and(
        eq(managedRolloutStage.rolloutId, input.rolloutId),
        eq(managedRolloutStage.ordinal, targetOrdinal),
      ),
    );
  if (!stage) {
    return {
      ok: false,
      reason: "stage_not_found",
      rolloutId: input.rolloutId,
      ordinal: targetOrdinal,
    };
  }
  if (input.expectedTopologyGeneration !== null) {
    const currentGeneration = await readTopologyGeneration(database);
    if (currentGeneration !== input.expectedTopologyGeneration) {
      return {
        ok: false,
        reason: "topology_conflict",
        currentGeneration,
      };
    }
  }
  const [claim] = await database
    .select({ serverId: managedRolloutClaim.serverId })
    .from(managedRolloutClaim)
    .where(eq(managedRolloutClaim.serverId, stage.serverId));
  if (!claim) {
    return {
      ok: false,
      reason: "rollout_claim_missing",
      serverId: stage.serverId,
    };
  }
  if (!("pending" === stage.state || "issued" === stage.state)) {
    return {
      ok: false,
      reason: "stage_conflict",
      currentOrdinal: rollout.currentOrdinal,
      state: rollout.state,
    };
  }
  return null;
}

export async function commitManagedStage(
  input: ManagedStageCommitInput,
  options: ManagedWriteOptions = {},
): Promise<ManagedStageCommitResult> {
  const { database, activationEnabled } = resolveWriter(options);
  if (!activationEnabled) return { ok: false, reason: "activation_disabled" };
  const expectedTopologyGeneration = input.expectedTopologyGeneration ?? null;
  const targetOrdinal = input.expectedOrdinal + 1;
  for (let attempt = 0; attempt < MAX_CONTENTION_RETRIES; attempt += 1) {
    const loaded = await loadStage(database, input.rolloutId, targetOrdinal);
    if (!loaded.ok) {
      if (loaded.reason === "stage_not_found") {
        const [rollout] = await database
          .select({ id: managedRollout.id })
          .from(managedRollout)
          .where(eq(managedRollout.id, input.rolloutId));
        if (!rollout) return { ok: false, reason: "rollout_not_found" };
        return {
          ok: false,
          reason: "stage_not_found",
          rolloutId: input.rolloutId,
          ordinal: targetOrdinal,
        };
      }
      return loaded;
    }
    const parsed = loaded.parsed;
    const statement = stageUpdateBuiltStatement({
      parsed,
      targetOrdinal,
      expectedTopologyGeneration,
      rolloutGuard: input.expectedOrdinal,
    });
    let rows: Record<string, unknown>[];
    try {
      rows = await executeRows(database, statement);
    } catch (error) {
      const intent = parsed.intent;
      const port =
        intent?.kind === "create_node"
          ? (intent.node.listenPort ?? 0)
          : intent?.kind === "update_node"
            ? ((intent.patch.listenPort as number | undefined) ?? 0)
            : 0;
      for (const serverId of parsed.affectedServerIds) {
        const conflict = await resolveListenerConflict(
          database,
          serverId,
          port,
        );
        if (conflict && isListenerConflict(error)) return conflict;
      }
      throw error;
    }
    if (rows[0]) {
      return {
        ok: true,
        ordinal: targetOrdinal,
        serverId: String(rows[0].server_id),
        configVersionId:
          rows[0].config_version_id === null
            ? null
            : String(rows[0].config_version_id),
        revisionSeq: numeric(rows[0].revision_seq),
        changeId: rows[0].change_id === null ? null : String(rows[0].change_id),
        topologyGeneration:
          rows[0].topology_generation === null
            ? null
            : numeric(rows[0].topology_generation),
      };
    }
    const failure = await diagnoseCommitFailure(
      database,
      { ...input, expectedTopologyGeneration },
      targetOrdinal,
    );
    if (failure) return failure;
    // A group-membership writer changed the cascade snapshot between our read
    // and statement. Re-read and retry at the same expected ordinal/generation.
  }
  throw new Error(
    `Managed stage ${input.rolloutId}:${targetOrdinal} did not settle after ${MAX_CONTENTION_RETRIES} attempts`,
  );
}

interface BuiltCompensation {
  statement: SQL;
}

async function buildCompensationStatement(
  database: Database,
  stage: typeof managedRolloutStage.$inferSelect,
  previous: ManagedSubscriberPrevious | null,
  input: ManagedStageCompensationInput,
  expectedGeneration: number | null,
): Promise<
  BuiltCompensation | { ok: false; reason: "invalid_previous"; message: string }
> {
  const recoveryOrdinal = Math.max(stage.ordinal - 1, 0);
  const previousStage =
    stage.previousConfigVersionId === null
      ? null
      : ((
          await database
            .select({
              fingerprint: managedRolloutStage.managedFingerprint,
            })
            .from(managedRolloutStage)
            .where(
              and(
                eq(managedRolloutStage.rolloutId, stage.rolloutId),
                eq(
                  managedRolloutStage.configVersionId,
                  stage.previousConfigVersionId,
                ),
              ),
            )
            .limit(1)
        )[0] ?? null);

  let current: Node | null = null;
  let snapshot: NodeCascadeSnapshot | null = null;
  let affectedServerIds = [stage.serverId];
  if (previous) {
    if (previous.intent.kind === "update_node") {
      const [row] = await database
        .select()
        .from(node)
        .where(eq(node.id, previous.intent.nodeId));
      current = row ?? null;
      if (current) affectedServerIds.push(current.serverId);
      if (previous.node) affectedServerIds.push(previous.node.serverId);
    } else if (previous.intent.kind === "delete_node") {
      if (previous.node) affectedServerIds.push(previous.node.serverId);
    } else {
      snapshot = await readNodeCascadeSnapshot(
        database,
        previous.intent.node.id,
        false,
      );
      if (snapshot) affectedServerIds.push(snapshot.node.serverId);
    }
  }
  affectedServerIds = stableServerIds(affectedServerIds);

  let gate: ParsedStage["gate"] = null;
  if (previous) {
    if (previous.intent.kind === "update_node" && current) {
      const after = previous.node
        ? patchToNodeState(previous.node, {})
        : current;
      const previousState = previous.node
        ? {
            serverId: previous.node.serverId,
            enabled: previous.node.enabled,
            listenPort: previous.node.listenPort,
            protocol: previous.node.protocol,
            settings: previous.node.settings,
            certificateId: previous.node.certificateId,
            tlsServerName: previous.node.tlsServerName,
          }
        : after;
      if (
        isNodeConfigChange(current, previousState) &&
        (current.enabled || previous.node?.enabled)
      ) {
        gate = {
          subjectId: previous.intent.nodeId,
          prevRow: await snapshotNodeForGate(database, current),
          serverIds: stableServerIds([
            current.serverId,
            ...(previous.node ? [previous.node.serverId] : []),
          ]),
          changeId: randomUUID(),
        };
      }
    } else if (
      previous.intent.kind === "delete_node" &&
      previous.node?.enabled
    ) {
      gate = {
        subjectId: previous.node.id,
        prevRow: null,
        serverIds: [previous.node.serverId],
        changeId: randomUUID(),
      };
    } else if (
      previous.intent.kind === "create_node" &&
      snapshot?.node.enabled
    ) {
      gate = {
        subjectId: snapshot.node.id,
        prevRow: null,
        serverIds: [snapshot.node.serverId],
        changeId: randomUUID(),
      };
    }
  }

  const ctes: SQL[] = [];
  ctes.push(sql`stage_guard AS (
    SELECT 1 FROM ${managedRolloutStage}
    WHERE ${managedRolloutStage.rolloutId} = ${stage.rolloutId}::text
      AND ${managedRolloutStage.ordinal} = ${stage.ordinal}::integer
      AND ${managedRolloutStage.state} IN ('pending', 'issued', 'confirmed')
  )`);
  ctes.push(sql`claim_guard AS (
    SELECT 1 FROM ${managedRolloutClaim}
    WHERE ${managedRolloutClaim.serverId} = ${stage.serverId}::text
      AND ${managedRolloutClaim.rolloutId} = ${stage.rolloutId}::text
  )`);
  ctes.push(sql`rollout_guard AS (
    SELECT 1 FROM ${managedRollout}
    WHERE ${managedRollout.id} = ${stage.rolloutId}::text
      AND ${managedRollout.state} IN ${ACTIVE_ROLLOUT_STATES}
  )`);
  const preconditions: SQL[] = [
    sql`EXISTS (SELECT 1 FROM stage_guard)`,
    sql`EXISTS (SELECT 1 FROM claim_guard)`,
    sql`EXISTS (SELECT 1 FROM rollout_guard)`,
  ];
  if (snapshot && previous?.intent.kind === "create_node") {
    const guards = snapshot.plans.map((plan) => ({
      group_id: plan.groupId,
      revision: plan.previousRevision,
    }));
    if (guards.length > 0) {
      preconditions.push(sql`NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset(${jsonParam(guards)}::jsonb)
          AS guards(group_id text, revision integer)
        JOIN ${proxyGroup} ON ${proxyGroup.id} = guards.group_id
        WHERE ${proxyGroup.revision} <> guards.revision
      )`);
    }
  }
  ctes.push(sql`preconditions AS (
    SELECT 1 WHERE ${sql.join(preconditions, sql` AND `)}
  )`);
  if (previous && expectedGeneration !== null) {
    ctes.push(
      topologyGenerationCasCte(
        expectedGeneration,
        sql`EXISTS (SELECT 1 FROM preconditions)`,
      ),
    );
  }
  ctes.push(sql`compensation_gate AS (
    SELECT 1 FROM preconditions
    ${expectedGeneration !== null ? sql`WHERE EXISTS (SELECT 1 FROM topology_cas)` : sql``}
  )`);
  ctes.push(sql`failed_stage AS (
    UPDATE ${managedRolloutStage}
    SET ${sql.identifier(managedRolloutStage.state.name)} = 'failed',
        ${sql.identifier(managedRolloutStage.failureCode.name)} = ${input.failureCode}::text,
        ${sql.identifier(managedRolloutStage.updatedAt.name)} = now()
    WHERE ${managedRolloutStage.rolloutId} = ${stage.rolloutId}::text
      AND ${managedRolloutStage.ordinal} = ${stage.ordinal}::integer
      AND ${managedRolloutStage.state} IN ('pending', 'issued', 'confirmed')
      AND EXISTS (SELECT 1 FROM compensation_gate)
    RETURNING ${managedRolloutStage}.*
  )`);
  ctes.push(sql`run_gate AS (
    SELECT 1 FROM failed_stage
    WHERE EXISTS (SELECT 1 FROM compensation_gate)
  )`);

  let nodeGateName: string | null = null;
  if (previous?.intent.kind === "create_node") {
    nodeGateName = "node_write";
    ctes.push(
      ...deleteNodeCascadeCtes({
        nodeId: previous.intent.node.id,
        plans: snapshot?.plans ?? [],
        guard: sql`EXISTS (SELECT 1 FROM run_gate)`,
        targetName: nodeGateName,
      }),
    );
    ctes.push(sql`mutation_gate AS (
      SELECT 1 FROM run_gate
      WHERE NOT EXISTS (
        SELECT 1 FROM ${node} WHERE ${node.id} = ${previous.intent.node.id}::text
      )
      OR EXISTS (SELECT 1 FROM ${sql.identifier(nodeGateName)})
    )`);
  } else if (previous?.intent.kind === "update_node" && previous.node) {
    nodeGateName = "node_write";
    const values = previous.node as unknown as Record<string, unknown>;
    ctes.push(sql`node_write AS (
      INSERT INTO ${node} (
        ${sql.identifier(node.id.name)},
        ${sql.identifier(node.name.name)},
        ${sql.identifier(node.remark.name)},
        ${sql.identifier(node.tags.name)},
        ${sql.identifier(node.enabled.name)},
        ${sql.identifier(node.serverId.name)},
        ${sql.identifier(node.address.name)},
        ${sql.identifier(node.listenPort.name)},
        ${sql.identifier(node.protocol.name)},
        ${sql.identifier(node.certificateId.name)},
        ${sql.identifier(node.tlsServerName.name)},
        ${sql.identifier(node.settings.name)},
        ${sql.identifier(node.createdAt.name)},
        ${sql.identifier(node.updatedAt.name)}
      )
      ${nodeInsertColumns(values)}
      FROM run_gate
      ON CONFLICT (${sql.identifier(node.id.name)}) DO UPDATE SET
        ${sql.identifier(node.name.name)} = EXCLUDED.${sql.identifier(node.name.name)},
        ${sql.identifier(node.remark.name)} = EXCLUDED.${sql.identifier(node.remark.name)},
        ${sql.identifier(node.tags.name)} = EXCLUDED.${sql.identifier(node.tags.name)},
        ${sql.identifier(node.enabled.name)} = EXCLUDED.${sql.identifier(node.enabled.name)},
        ${sql.identifier(node.serverId.name)} = EXCLUDED.${sql.identifier(node.serverId.name)},
        ${sql.identifier(node.address.name)} = EXCLUDED.${sql.identifier(node.address.name)},
        ${sql.identifier(node.listenPort.name)} = EXCLUDED.${sql.identifier(node.listenPort.name)},
        ${sql.identifier(node.protocol.name)} = EXCLUDED.${sql.identifier(node.protocol.name)},
        ${sql.identifier(node.certificateId.name)} = EXCLUDED.${sql.identifier(node.certificateId.name)},
        ${sql.identifier(node.tlsServerName.name)} = EXCLUDED.${sql.identifier(node.tlsServerName.name)},
        ${sql.identifier(node.settings.name)} = EXCLUDED.${sql.identifier(node.settings.name)},
        ${sql.identifier(node.updatedAt.name)} = now()
      RETURNING ${node}.*
    )`);
    ctes.push(sql`mutation_gate AS (
      SELECT 1 FROM run_gate WHERE EXISTS (SELECT 1 FROM node_write)
    )`);
  } else if (previous?.intent.kind === "delete_node" && previous.node) {
    nodeGateName = "node_write";
    const values = previous.node as unknown as Record<string, unknown>;
    ctes.push(sql`node_write AS (
      INSERT INTO ${node} (
        ${sql.identifier(node.id.name)},
        ${sql.identifier(node.name.name)},
        ${sql.identifier(node.remark.name)},
        ${sql.identifier(node.tags.name)},
        ${sql.identifier(node.enabled.name)},
        ${sql.identifier(node.serverId.name)},
        ${sql.identifier(node.address.name)},
        ${sql.identifier(node.listenPort.name)},
        ${sql.identifier(node.protocol.name)},
        ${sql.identifier(node.certificateId.name)},
        ${sql.identifier(node.tlsServerName.name)},
        ${sql.identifier(node.settings.name)},
        ${sql.identifier(node.createdAt.name)},
        ${sql.identifier(node.updatedAt.name)}
      )
      ${nodeInsertColumns(values)}
      FROM run_gate
      ON CONFLICT (${sql.identifier(node.id.name)}) DO NOTHING
      RETURNING ${node}.*
    )`);
    ctes.push(sql`mutation_gate AS (
      SELECT 1 FROM run_gate
      WHERE EXISTS (SELECT 1 FROM node_write)
         OR EXISTS (SELECT 1 FROM ${node} WHERE ${node.id} = ${previous.node.id}::text)
    )`);
    for (const [index, plan] of previous.plans.entries()) {
      const groupName = `restore_group_${index}`;
      const members = plan.nextNodeIds
        .map((nodeId, position) => ({ node_id: nodeId, position }))
        .filter((member) => member.node_id !== previous.node?.id || true);
      // Restore the exact membership captured before the staged deletion. The
      // original previous members are stored on the plan by the cascade
      // planner; `previousNodeIds` is that ordered pre-delete list.
      const previousMembers = plan.previousNodeIds.map((nodeId, position) => ({
        node_id: nodeId,
        position,
      }));
      ctes.push(sql`${sql.identifier(groupName)} AS (
        UPDATE ${proxyGroup}
        SET ${sql.identifier(proxyGroup.revision.name)} = ${proxyGroup.revision} + 1,
            ${sql.identifier(proxyGroup.updatedAt.name)} = now()
        WHERE ${proxyGroup.id} = ${plan.groupId}::text
          AND ${proxyGroup.revision} = ${plan.previousRevision + 1}::integer
          AND EXISTS (SELECT 1 FROM mutation_gate)
          AND EXISTS (SELECT 1 FROM node_write)
        RETURNING ${proxyGroup.id} AS id
      )`);
      ctes.push(sql`${sql.identifier(`restore_members_${index}`)} AS (
        DELETE FROM ${nodeGroup}
        WHERE ${nodeGroup.groupId} = ${plan.groupId}::text
          AND EXISTS (SELECT 1 FROM ${sql.identifier(groupName)})
        RETURNING 1
      )`);
      ctes.push(sql`${sql.identifier(`restore_insert_${index}`)} AS (
        INSERT INTO ${nodeGroup} (
          ${sql.identifier(nodeGroup.groupId.name)},
          ${sql.identifier(nodeGroup.nodeId.name)},
          ${sql.identifier(nodeGroup.position.name)}
        )
        SELECT ${plan.groupId}::text, members.node_id, members.position
        FROM jsonb_to_recordset(${jsonParam(previousMembers)}::jsonb)
          AS members(node_id text, position integer)
        WHERE EXISTS (SELECT 1 FROM ${sql.identifier(groupName)})
          AND (SELECT count(*) FROM ${sql.identifier(`restore_members_${index}`)}) >= 0
        RETURNING 1
      )`);
      // `members` above is intentionally kept only for its ordered shape; the
      // insert uses the planner's pre-delete order.
      void members;
    }
  } else {
    ctes.push(sql`mutation_gate AS (SELECT 1 FROM run_gate)`);
  }

  const serverBumpedName = "server_bumped";
  ctes.push(sql`${sql.identifier(serverBumpedName)} AS (
    UPDATE ${server}
    SET ${sql.identifier(server.desiredRevisionSeq.name)} = ${server.desiredRevisionSeq} + 1
    WHERE ${server.id} IN (
      SELECT value FROM jsonb_array_elements_text(${jsonParam(affectedServerIds)}::jsonb)
    )
      AND EXISTS (SELECT 1 FROM mutation_gate)
    RETURNING ${server.id} AS id, ${server.desiredRevisionSeq} AS seq
  )`);
  ctes.push(sql`rollout_recovering AS (
    UPDATE ${managedRollout}
    SET ${sql.identifier(managedRollout.state.name)} = 'recovering',
        ${sql.identifier(managedRollout.currentOrdinal.name)} = LEAST(
          ${managedRollout.currentOrdinal}, ${recoveryOrdinal}::integer
        ),
        ${sql.identifier(managedRollout.failureCode.name)} = ${input.failureCode}::text,
        ${sql.identifier(managedRollout.failureMessage.name)} = ${`recovery:${stage.previousConfigVersionId ?? "legacy"}`}::text,
        ${sql.identifier(managedRollout.updatedAt.name)} = now()
    WHERE ${managedRollout.id} = ${stage.rolloutId}::text
      AND EXISTS (SELECT 1 FROM mutation_gate)
    RETURNING ${managedRollout}.*
  )`);
  ctes.push(sql`pointer AS (
    INSERT INTO ${managedServerState} (
      ${sql.identifier(managedServerState.serverId.name)},
      ${sql.identifier(managedServerState.desiredConfigVersionId.name)},
      ${sql.identifier(managedServerState.desiredRolloutId.name)},
      ${sql.identifier(managedServerState.desiredOrdinal.name)},
      ${sql.identifier(managedServerState.desiredMinRevisionSeq.name)},
      ${sql.identifier(managedServerState.desiredManagedFingerprint.name)},
      ${sql.identifier(managedServerState.updatedAt.name)}
    )
    SELECT ${stage.serverId}::text,
           ${stage.previousConfigVersionId}::text,
           ${stage.previousConfigVersionId === null ? null : stage.rolloutId}::text,
           ${recoveryOrdinal}::integer,
           bumped.seq,
           ${previousStage?.fingerprint ?? null}::text,
           now()
    FROM ${sql.identifier(serverBumpedName)} bumped
    WHERE bumped.id = ${stage.serverId}::text
      AND EXISTS (SELECT 1 FROM mutation_gate)
    ON CONFLICT (${sql.identifier(managedServerState.serverId.name)}) DO UPDATE SET
      ${sql.identifier(managedServerState.desiredConfigVersionId.name)} = ${stage.previousConfigVersionId}::text,
      ${sql.identifier(managedServerState.desiredRolloutId.name)} = ${stage.previousConfigVersionId === null ? null : stage.rolloutId}::text,
      ${sql.identifier(managedServerState.desiredOrdinal.name)} = ${recoveryOrdinal}::integer,
      ${sql.identifier(managedServerState.desiredMinRevisionSeq.name)} = (
        SELECT seq FROM ${sql.identifier(serverBumpedName)}
        WHERE id = ${stage.serverId}::text
      ),
      ${sql.identifier(managedServerState.desiredManagedFingerprint.name)} = ${previousStage?.fingerprint ?? null}::text,
      ${sql.identifier(managedServerState.updatedAt.name)} = now()
    RETURNING 1
  )`);
  const gateCtes = stageGateCtes(gate, serverBumpedName, "mutation_gate");
  ctes.push(...gateCtes.ctes);

  return {
    statement: sql`
      WITH ${sql.join(ctes, sql`, `)}
      SELECT ${stage.ordinal}::integer AS ordinal,
             ${stage.serverId}::text AS server_id,
             ${stage.previousConfigVersionId}::text AS config_version_id,
             bumped.seq AS revision_seq,
             ${gateCtes.changeIdSelect} AS change_id,
             ${
               expectedGeneration !== null
                 ? sql`(SELECT generation FROM topology_cas)`
                 : sql`NULL::integer`
             } AS topology_generation
      FROM rollout_recovering
      JOIN ${sql.identifier(serverBumpedName)} bumped
        ON bumped.id = ${stage.serverId}::text
    `,
  };
}

// --- Gate CTE adapter --------------------------------------------------------

export async function compensateManagedStage(
  input: ManagedStageCompensationInput,
  options: ManagedWriteOptions = {},
): Promise<ManagedStageCommitResult> {
  const { database, activationEnabled } = resolveWriter(options);
  if (!activationEnabled) return { ok: false, reason: "activation_disabled" };

  const [stage] = await database
    .select()
    .from(managedRolloutStage)
    .where(
      and(
        eq(managedRolloutStage.rolloutId, input.rolloutId),
        eq(managedRolloutStage.ordinal, input.ordinal),
      ),
    );
  if (!stage) {
    const [rollout] = await database
      .select({ id: managedRollout.id })
      .from(managedRollout)
      .where(eq(managedRollout.id, input.rolloutId));
    if (!rollout) return { ok: false, reason: "rollout_not_found" };
    return {
      ok: false,
      reason: "stage_not_found",
      rolloutId: input.rolloutId,
      ordinal: input.ordinal,
    };
  }

  const persisted = stage.subscriberPrevious;
  const previous = isManagedSubscriberPrevious(persisted) ? persisted : null;
  if (persisted !== null && !previous) {
    return {
      ok: false,
      reason: "invalid_previous",
      message: "subscriber_previous does not match the persisted shape",
    };
  }

  for (let attempt = 0; attempt < MAX_CONTENTION_RETRIES; attempt += 1) {
    const expectedGeneration =
      input.expectedTopologyGeneration !== undefined
        ? input.expectedTopologyGeneration
        : previous
          ? await readTopologyGeneration(database)
          : null;
    const built = await buildCompensationStatement(
      database,
      stage,
      previous,
      input,
      expectedGeneration,
    );
    if (!built || "ok" in built) return built;

    let rows: Record<string, unknown>[];
    try {
      rows = await executeRows(database, built.statement);
    } catch (error) {
      const conflict = await resolveListenerConflict(
        database,
        stage.serverId,
        previous?.node?.listenPort ?? 0,
      );
      if (conflict && isListenerConflict(error)) return conflict;
      throw error;
    }
    if (rows[0]) {
      return {
        ok: true,
        ordinal: input.ordinal,
        serverId: String(rows[0].server_id),
        configVersionId:
          rows[0].config_version_id === null
            ? null
            : String(rows[0].config_version_id),
        revisionSeq: numeric(rows[0].revision_seq),
        changeId: rows[0].change_id === null ? null : String(rows[0].change_id),
        topologyGeneration:
          rows[0].topology_generation === null
            ? null
            : numeric(rows[0].topology_generation),
      };
    }

    const [currentStage] = await database
      .select({ state: managedRolloutStage.state })
      .from(managedRolloutStage)
      .where(
        and(
          eq(managedRolloutStage.rolloutId, input.rolloutId),
          eq(managedRolloutStage.ordinal, input.ordinal),
        ),
      );
    if (
      currentStage &&
      !["pending", "issued", "confirmed"].includes(currentStage.state)
    ) {
      const [rollout] = await database
        .select({ currentOrdinal: managedRollout.currentOrdinal })
        .from(managedRollout)
        .where(eq(managedRollout.id, input.rolloutId));
      return {
        ok: false,
        reason: "stage_conflict",
        currentOrdinal: rollout?.currentOrdinal ?? input.ordinal,
      };
    }
    if (input.expectedTopologyGeneration !== undefined) {
      const currentGeneration = await readTopologyGeneration(database);
      if (currentGeneration !== input.expectedTopologyGeneration) {
        return {
          ok: false,
          reason: "topology_conflict",
          currentGeneration,
        };
      }
    }
    // Group/membership contention: re-read the snapshot and retry.
  }
  throw new Error(
    `Managed stage compensation ${input.rolloutId}:${input.ordinal} did not settle after ${MAX_CONTENTION_RETRIES} attempts`,
  );
}

export function createManagedStageWriter(
  options: ManagedWriteOptions = {},
): ManagedStageWriter {
  return {
    commitStage: (input) => commitManagedStage(input, options),
    compensateStage: (input) => compensateManagedStage(input, options),
  };
}

/** Default writer bound to the lazily resolved app database. */
export const managedStageWriter: ManagedStageWriter = {
  commitStage: (input) => commitManagedStage(input),
  compensateStage: (input) => compensateManagedStage(input),
};
