import {
  MANAGED_TOPOLOGY_ID,
  managedRuntimeTag,
} from "@blossom/domain/managed-networking";
import { createServerFn } from "@tanstack/react-start";
import type { SQL } from "drizzle-orm";
import { and, eq, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { Database } from "@/db";
import { db } from "@/db";
import {
  listenerClaim,
  managedTopology,
  peerInbound,
  portForward,
} from "@/db/managed-network-schema";
import {
  configChange,
  configChangeServer,
  node,
  server,
} from "@/db/proxy-schema";
import { fromInput, fromResult } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  deletePortForwardSchema,
  type SavePortForwardInput,
  savePortForwardSchema,
} from "@/lib/port-forward-schema";

/**
 * L4 port forwarding writes and reads (`relay-in-<id>`).
 *
 * Every write is a single statement: the graph change, the singleton
 * `managed_topology` generation compare-and-swap, the shared `listener_claim`
 * reservation and the publish-gate record commit together on both
 * `node-postgres` and `neon-http`.
 */

const PORT_FORWARD_WRITE_REASONS = [
  "not_found",
  "port_conflict",
  "self_forward",
  "stale_topology",
  "target_not_found",
  "topology_conflict",
] as const;
type PortForwardWriteReason = (typeof PORT_FORWARD_WRITE_REASONS)[number];

export type PortForwardWriteResult =
  | {
      ok: true;
      generation: number;
      forwardId: string;
      runtimeTag: string;
    }
  | { ok: false; reason: PortForwardWriteReason; message?: string };

async function executeRows<T extends Record<string, unknown>>(
  database: Database,
  statement: SQL,
): Promise<T[]> {
  const result = await database.execute<T>(statement, "objects");
  if (Array.isArray(result)) return result;
  const wrapped = result as unknown as { rows?: T[] };
  return wrapped.rows ?? [];
}

function numeric(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

async function readGeneration(database: Database): Promise<number> {
  const [row] = await database
    .select({ generation: managedTopology.generation })
    .from(managedTopology)
    .where(eq(managedTopology.id, MANAGED_TOPOLOGY_ID));
  return row?.generation ?? 0;
}

async function topologyConflict(
  database: Database,
): Promise<PortForwardWriteResult> {
  return {
    ok: false,
    reason: "topology_conflict",
    message: `A newer topology generation (${await readGeneration(database)}) replaced this draft`,
  };
}

function topologyCasCte(expected: number): SQL {
  return sql`topology_cas AS (
    UPDATE ${managedTopology}
    SET generation = generation + 1,
        updated_at = now()
    WHERE id = ${MANAGED_TOPOLOGY_ID}
      AND generation = ${expected}
      AND EXISTS (SELECT 1 FROM guard)
    RETURNING generation
  )`;
}

function targetGuard(input: SavePortForwardInput): SQL {
  if (input.targetNodeId !== undefined) {
    return sql`EXISTS (
      SELECT 1 FROM ${node} target_node
      WHERE target_node.id = ${input.targetNodeId}::text
    )
    AND NOT EXISTS (
      SELECT 1 FROM ${node} target_node
      WHERE target_node.id = ${input.targetNodeId}::text
        AND target_node.server_id = ${input.serverId}::text
        AND target_node.listen_port = ${input.listenPort}::integer
    )`;
  }
  return sql`(${input.targetAddress ?? null}::text IS NOT NULL
    AND ${input.targetPort ?? null}::integer BETWEEN 1 AND 65535)`;
}

function listenerConflictGuard(input: SavePortForwardInput, id: string): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${listenerClaim} claim
    WHERE claim.server_id = ${input.serverId}::text
      AND claim.port = ${input.listenPort}::integer
      AND NOT (
        claim.owner_kind = 'port_forward'
        AND claim.owner_id = ${id}::text
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM ${node} subscriber
    WHERE subscriber.server_id = ${input.serverId}::text
      AND subscriber.listen_port = ${input.listenPort}::integer
  )
  AND NOT EXISTS (
    SELECT 1 FROM ${peerInbound} peer
    WHERE peer.server_id = ${input.serverId}::text
      AND peer.listen_port = ${input.listenPort}::integer
  )
  AND NOT EXISTS (
    SELECT 1 FROM ${portForward} forward
    WHERE forward.server_id = ${input.serverId}::text
      AND forward.listen_port = ${input.listenPort}::integer
      AND forward.id <> ${id}::text
  )`;
}

async function diagnoseSaveFailure(
  database: Database,
  input: SavePortForwardInput,
  id: string,
): Promise<PortForwardWriteResult> {
  if ((await readGeneration(database)) !== input.expectedTopologyGeneration) {
    return topologyConflict(database);
  }
  if (input.id) {
    const [existing] = await database
      .select({ id: portForward.id })
      .from(portForward)
      .where(eq(portForward.id, input.id));
    if (!existing) {
      return {
        ok: false,
        reason: "not_found",
        message: "Port forward not found",
      };
    }
  }
  if (input.targetNodeId !== undefined) {
    const [target] = await database
      .select({ serverId: node.serverId, listenPort: node.listenPort })
      .from(node)
      .where(eq(node.id, input.targetNodeId));
    if (!target) {
      return {
        ok: false,
        reason: "target_not_found",
        message: "The target node no longer exists",
      };
    }
    if (
      target.serverId === input.serverId &&
      target.listenPort === input.listenPort
    ) {
      return {
        ok: false,
        reason: "self_forward",
        message:
          "A port forward cannot target a node listening on the same server and port",
      };
    }
  }

  const [claim] = await database
    .select({
      ownerKind: listenerClaim.ownerKind,
      ownerId: listenerClaim.ownerId,
    })
    .from(listenerClaim)
    .where(
      and(
        eq(listenerClaim.serverId, input.serverId),
        eq(listenerClaim.port, input.listenPort),
      ),
    );
  if (claim && !(claim.ownerKind === "port_forward" && claim.ownerId === id)) {
    return {
      ok: false,
      reason: "port_conflict",
      message: `Port ${input.listenPort} is already reserved on this server`,
    };
  }

  const [subscriber] = await database
    .select({ id: node.id })
    .from(node)
    .where(
      and(
        eq(node.serverId, input.serverId),
        eq(node.listenPort, input.listenPort),
      ),
    );
  if (subscriber) {
    return {
      ok: false,
      reason: "port_conflict",
      message: `Port ${input.listenPort} is already used by a subscriber inbound`,
    };
  }

  const [peer] = await database
    .select({ id: peerInbound.id })
    .from(peerInbound)
    .where(
      and(
        eq(peerInbound.serverId, input.serverId),
        eq(peerInbound.listenPort, input.listenPort),
      ),
    );
  if (peer) {
    return {
      ok: false,
      reason: "port_conflict",
      message: `Port ${input.listenPort} is already used by a peer inbound`,
    };
  }

  const [otherForward] = await database
    .select({ id: portForward.id })
    .from(portForward)
    .where(
      and(
        eq(portForward.serverId, input.serverId),
        eq(portForward.listenPort, input.listenPort),
        input.id ? ne(portForward.id, input.id) : sql`TRUE`,
      ),
    );
  if (otherForward) {
    return {
      ok: false,
      reason: "port_conflict",
      message: `Port ${input.listenPort} is already used by another port forward`,
    };
  }

  return {
    ok: false,
    reason: "stale_topology",
    message: "The topology guard rejected this draft",
  };
}

async function savePortForwardDraft(
  input: SavePortForwardInput,
  database: Database = db,
): Promise<PortForwardWriteResult> {
  const id = input.id ?? randomUUID();
  const runtimeTag = managedRuntimeTag("port_forward", id);
  const targetNodeId = input.targetNodeId ?? null;
  const targetAddress =
    targetNodeId === null ? (input.targetAddress ?? null) : null;
  const targetPort = targetNodeId === null ? (input.targetPort ?? null) : null;
  const outboundTag = input.outboundTag ?? null;
  const changeId = randomUUID();
  const isUpdate = input.id !== undefined;

  const existingGuard = isUpdate
    ? sql`EXISTS (SELECT 1 FROM ${portForward} existing WHERE existing.id = ${id}::text)`
    : sql`TRUE`;

  const mutatedCte = isUpdate
    ? sql`mutated AS (
        UPDATE ${portForward}
        SET server_id = ${input.serverId},
            name = ${input.name},
            runtime_tag = ${runtimeTag},
            enabled = ${input.enabled},
            listen_address = ${input.listenAddress},
            listen_port = ${input.listenPort},
            network = ${input.network},
            target_node_id = ${targetNodeId},
            target_address = ${targetAddress},
            target_port = ${targetPort},
            outbound_tag = ${outboundTag},
            revision = revision + 1,
            updated_at = now()
        WHERE id = ${id}::text
          AND EXISTS (SELECT 1 FROM topology_cas)
        RETURNING *
      )`
    : sql`mutated AS (
        INSERT INTO ${portForward} (
          id, server_id, name, runtime_tag, enabled,
          listen_address, listen_port, network,
          target_node_id, target_address, target_port, outbound_tag
        )
        SELECT ${id}::text,
               ${input.serverId}::text,
               ${input.name}::text,
               ${runtimeTag}::text,
               ${input.enabled}::boolean,
               ${input.listenAddress}::text,
               ${input.listenPort}::integer,
               ${input.network}::text,
               ${targetNodeId}::text,
               ${targetAddress}::text,
               ${targetPort}::integer,
               ${outboundTag}::text
        FROM topology_cas
        RETURNING *
      )`;

  const rows = await executeRows(
    database,
    sql`
      WITH existing AS (
        SELECT * FROM ${portForward} WHERE id = ${id}::text
      ),
      guard AS (
        SELECT 1
        WHERE EXISTS (
          SELECT 1 FROM ${server} target_server
          WHERE target_server.id = ${input.serverId}::text
        )
        AND ${existingGuard}
        AND ${listenerConflictGuard(input, id)}
        AND ${targetGuard(input)}
      ),
      ${topologyCasCte(input.expectedTopologyGeneration)},
      ${mutatedCte},
      server_bumped AS (
        UPDATE ${server}
        SET desired_revision_seq = desired_revision_seq + 1
        WHERE id IN (
          SELECT server_id FROM mutated
          UNION
          SELECT server_id FROM existing
        )
        AND EXISTS (SELECT 1 FROM mutated)
        RETURNING id, desired_revision_seq AS seq
      ),
      change AS (
        INSERT INTO ${configChange} (id, kind, subject_id, prev_row)
        SELECT ${changeId}::text,
               'port_forward',
               ${id}::text,
               CASE
                 WHEN ${isUpdate} THEN (SELECT to_jsonb(existing_row) FROM existing existing_row LIMIT 1)
                 ELSE NULL
               END
        FROM mutated
        RETURNING id
      ),
      change_link AS (
        INSERT INTO ${configChangeServer} (change_id, server_id, revision_seq)
        SELECT change.id, bumped.id, bumped.seq
        FROM change
        CROSS JOIN server_bumped bumped
        WHERE bumped.id = ${input.serverId}::text
        RETURNING 1
      ),
      claim_cleanup AS (
        DELETE FROM ${listenerClaim}
        WHERE owner_kind = 'port_forward'
          AND owner_id = ${id}::text
          AND NOT (
            server_id = ${input.serverId}::text
            AND port = ${input.listenPort}::integer
          )
          AND EXISTS (SELECT 1 FROM mutated)
        RETURNING 1
      ),
      claim_upsert AS (
        INSERT INTO ${listenerClaim} (server_id, port, owner_kind, owner_id)
        SELECT ${input.serverId}::text,
               ${input.listenPort}::integer,
               'port_forward',
               ${id}::text
        FROM mutated
        ON CONFLICT (server_id, port) DO UPDATE SET
          owner_kind = EXCLUDED.owner_kind,
          owner_id = EXCLUDED.owner_id
        WHERE ${listenerClaim}.owner_kind = 'port_forward'
          AND ${listenerClaim}.owner_id = EXCLUDED.owner_id
        RETURNING 1
      )
      SELECT mutated.id AS id,
             mutated.runtime_tag AS runtime_tag,
             topology_cas.generation AS generation,
             change.id AS change_id,
             (SELECT count(*) FROM change_link) AS change_links,
             (SELECT count(*) FROM claim_upsert) AS claims
      FROM mutated
      CROSS JOIN topology_cas
      CROSS JOIN change
    `,
  );

  if (rows[0]) {
    return {
      ok: true,
      generation: numeric(rows[0].generation),
      forwardId: String(rows[0].id),
      runtimeTag: String(rows[0].runtime_tag),
    };
  }
  return diagnoseSaveFailure(database, input, id);
}

async function deletePortForwardDraft(
  id: string,
  expectedTopologyGeneration: number,
  database: Database = db,
): Promise<PortForwardWriteResult> {
  const rows = await executeRows(
    database,
    sql`
      WITH existing AS (
        SELECT * FROM ${portForward} WHERE id = ${id}::text
      ),
      guard AS (
        SELECT 1 FROM existing
      ),
      ${topologyCasCte(expectedTopologyGeneration)},
      removed AS (
        DELETE FROM ${portForward}
        WHERE id = ${id}::text
          AND EXISTS (SELECT 1 FROM topology_cas)
        RETURNING *
      ),
      claim_delete AS (
        DELETE FROM ${listenerClaim}
        WHERE owner_kind = 'port_forward'
          AND owner_id = ${id}::text
          AND EXISTS (SELECT 1 FROM removed)
        RETURNING 1
      ),
      server_bumped AS (
        UPDATE ${server}
        SET desired_revision_seq = desired_revision_seq + 1
        WHERE id IN (SELECT server_id FROM existing)
          AND EXISTS (SELECT 1 FROM removed)
        RETURNING id, desired_revision_seq AS seq
      )
      SELECT removed.id AS id,
             removed.runtime_tag AS runtime_tag,
             topology_cas.generation AS generation,
             (SELECT count(*) FROM claim_delete) AS claims,
             (SELECT count(*) FROM server_bumped) AS servers
      FROM removed
      CROSS JOIN topology_cas
    `,
  );
  if (rows[0]) {
    return {
      ok: true,
      generation: numeric(rows[0].generation),
      forwardId: String(rows[0].id),
      runtimeTag: String(rows[0].runtime_tag),
    };
  }
  if ((await readGeneration(database)) !== expectedTopologyGeneration) {
    return topologyConflict(database);
  }
  return {
    ok: false,
    reason: "not_found",
    message: "Port forward not found",
  };
}

// --- Reads ------------------------------------------------------------------

export const PORT_FORWARDS_QUERY_KEY = [
  "admin",
  "networking",
  "port-forwards",
] as const;

export const listPortForwards = createServerFn({ method: "GET" }).handler(
  async () => {
    await ensureAdmin();
    return db
      .select()
      .from(portForward)
      .orderBy(portForward.serverId, portForward.name, portForward.id);
  },
);

export const savePortForward = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.port_forward_save", {
      targetType: "port_forward",
      targetId: fromResult("forwardId"),
    }),
  ])
  .validator(savePortForwardSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return savePortForwardDraft(data, db);
  });

export const deletePortForward = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.port_forward_delete", {
      targetType: "port_forward",
      targetId: fromInput("id"),
    }),
  ])
  .validator(deletePortForwardSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return deletePortForwardDraft(data.id, data.expectedTopologyGeneration, db);
  });

export type { SubscriptionPortForward } from "@/query/port-forward-store";
