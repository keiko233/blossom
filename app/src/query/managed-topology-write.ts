import { MANAGED_TOPOLOGY_ID } from "@blossom/domain/managed-networking";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";

import { type Database, db } from "@/db";
import {
  type ListenerClaim,
  listenerClaim,
  managedTopology,
} from "@/db/managed-network-schema";

/**
 * Shared persistence boundary for managed networking (Task 06: managed
 * persistence and writer boundary). This module owns the topology fence and
 * the typed contract of the atomic stage writer; the writer itself and the
 * legacy UI/MCP cutover build on it.
 *
 * Invariants for every writer:
 *  - Managed activation stays off while `MANAGED_NETWORKING_ACTIVATION_ENABLED`
 *    is false: no rollout, stage pointer or peer claim may be written, and
 *    `commitStage` answers `activation_disabled`.
 *  - Any write that adds or removes a managed forwarding edge, reservation or
 *    rollout claim compares and bumps `managed_topology.generation` in the
 *    same node-postgres transaction or, on neon-http, in the same
 *    data-modifying statement via `topologyGenerationCasCte`, gating its other
 *    CTEs on `EXISTS (SELECT 1 FROM topology_cas)`. A conflict repeats graph
 *    validation; it is never retried blindly.
 *  - Rollout claims (`managed_rollout_claim`) are inserted in stable server ID
 *    order in the same atomic unit as the topology CAS.
 *  - Subscriber listener claims are derived from `node` by trigger. Writers
 *    never insert them; peer claims are written only by the managed writer.
 *  - For staged subscriber changes only `commitStage` writes subscriber rows.
 *    It composes the rollout ordinal CAS, node and membership writes (through
 *    the group-membership statements, never a second node-delete path), the
 *    stage pointer, `server.desired_revision_seq` bumps, the publish-gate
 *    record and the replaced rows in `subscriber_previous` atomically.
 *    Compensation uses the same path.
 *  - Legacy structural node writers (UI `nodes.ts`, MCP `mcp-tools.ts`)
 *    return a `LegacyStructuralWriteRejection` instead of writing a node that
 *    a pointed-to `managed_config_version.subscriber_node_ids` references or
 *    whose server holds a rollout claim. Credential rotation and entitlement
 *    revocation are never blocked.
 */

export type TopologyGenerationResult =
  | { ok: true; generation: number }
  | { ok: false; reason: "topology_conflict"; currentGeneration: number };

/**
 * `topology_cas` CTE: bumps the singleton generation only if it still equals
 * `expectedGeneration` and returns the new value. Compose it first in a
 * data-modifying statement and gate later CTEs on its row.
 */
export function topologyGenerationCasCte(expectedGeneration: number): SQL {
  return sql`topology_cas AS (
    UPDATE ${managedTopology}
    SET ${sql.identifier(managedTopology.generation.name)} = ${managedTopology.generation} + 1,
        ${sql.identifier(managedTopology.updatedAt.name)} = now()
    WHERE ${managedTopology.id} = ${MANAGED_TOPOLOGY_ID}
      AND ${managedTopology.generation} = ${expectedGeneration}::integer
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

// --- Stage writer contract ---------------------------------------------------

export interface ManagedStageCommitInput {
  rolloutId: string;
  /** `managed_rollout.current_ordinal` the caller read; the advance CAS token. */
  expectedOrdinal: number;
  /**
   * Required when the stage adds or removes a managed forwarding edge or
   * releases a reservation; null otherwise.
   */
  expectedTopologyGeneration: number | null;
}

export interface ManagedStageCompensationInput {
  rolloutId: string;
  ordinal: number;
  failureCode: string;
}

export type ManagedStageCommitResult =
  | {
      ok: true;
      ordinal: number;
      serverId: string;
      configVersionId: string;
      /** `server.desired_revision_seq` after the bump; the stage minimum. */
      revisionSeq: number;
      /** Publish-gate record for a staged subscriber change, if any. */
      changeId: string | null;
      topologyGeneration: number | null;
    }
  | { ok: false; reason: "activation_disabled" }
  | { ok: false; reason: "rollout_not_found" }
  | { ok: false; reason: "stage_conflict"; currentOrdinal: number }
  | { ok: false; reason: "topology_conflict"; currentGeneration: number }
  | { ok: false; reason: "rollout_claim_missing"; serverId: string };

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

/**
 * Atomic stage writer. node-postgres implements each method in one
 * interactive transaction with row locks; neon-http in one data-modifying
 * statement. Both return the same results for the same races.
 */
export interface ManagedStageWriter {
  commitStage(
    input: ManagedStageCommitInput,
  ): Promise<ManagedStageCommitResult>;
  compensateStage(
    input: ManagedStageCompensationInput,
  ): Promise<ManagedStageCommitResult>;
}
