import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { type Database, db } from "@/db";
import { planGroup, subscription } from "@/db/plan-schema";
import {
  certificateServer,
  configChange,
  type ConfigChangeKind,
  configChangeServer,
  node,
  nodeGroup,
  server,
} from "@/db/proxy-schema";
import type { PendingConfigChange } from "@/lib/publish-gate";

/**
 * Write side of the config publish gate (see `@/lib/publish-gate` for the
 * read-side rules). Every mutation that changes the agent-facing config or
 * the subscription payload in a way the gate must replay records a
 * `config_change` row here and bumps `server.desiredRevisionSeq` for each
 * affected server — inside the same transaction (or the same ordered
 * statement sequence on neon-http) as the mutation itself, so the gate can
 * never observe a mutation without its change record.
 *
 * Not every mutation is recorded — only those the gate replays. Changes that
 * affect only the agent (certificate material rotation) are carried by the
 * revision *hash* and need no gate record; changes that only affect
 * client-side fields with no agent-side state (address overrides, names) need
 * none either. See docs/config-versioning.md.
 */

export type DbHandle = Database;

export interface RecordConfigChangeInput {
  kind: ConfigChangeKind;
  subjectId: string;
  /** Pre-change snapshot for gate replay; null for creations. */
  prevRow: unknown;
  serverIds: readonly string[];
}

/**
 * Records one change and links it to every affected server at that server's
 * next revision sequence. No-op when no server is affected (e.g. a change to
 * a plan with no nodes).
 */
export async function recordConfigChange(
  tx: DbHandle,
  input: RecordConfigChangeInput,
): Promise<void> {
  const serverIds = [...new Set(input.serverIds)];
  if (serverIds.length === 0) {
    return;
  }
  // Bump the desired seq FIRST. Callers record after the mutation itself, and
  // on neon-http (no interactive transactions) each statement commits
  // individually — an agent polling in between compiles the NEW content under
  // the OLD seq, applies it, and its heartbeat then can't distinguish that
  // from having applied the recorded change. Keeping the bump as the first
  // statement shrinks that drift window to a single statement; any residual
  // drift self-heals on the agent's next poll (revision string still differs
  // by hash). On node-postgres the caller's transaction makes all of this
  // atomic and the ordering is irrelevant.
  const seqByServer = new Map<string, number>();
  for (const serverId of serverIds) {
    const [row] = await tx
      .update(server)
      .set({ desiredRevisionSeq: sql`${server.desiredRevisionSeq} + 1` })
      .where(eq(server.id, serverId))
      .returning({ seq: server.desiredRevisionSeq });
    if (row) {
      seqByServer.set(serverId, row.seq);
    }
  }
  if (seqByServer.size === 0) {
    return;
  }
  const changeId = randomUUID();
  await tx.insert(configChange).values({
    id: changeId,
    kind: input.kind,
    subjectId: input.subjectId,
    prevRow: input.prevRow ?? null,
  });
  await tx.insert(configChangeServer).values(
    [...seqByServer].map(([serverId, revisionSeq]) => ({
      changeId,
      serverId,
      revisionSeq,
    })),
  );
}

// --- Affected-server resolution ---------------------------------------------
// Every helper answers "which servers' agent configs does this subject touch?",
// i.e. the servers hosting the nodes the subject can reach. Enabled filtering
// mirrors the config compilers: only enabled nodes materialize into either
// payload.

/** Servers hosting any of the given nodes (regardless of enabled: callers use
 * this for node mutations where the node row itself is the subject). */
export async function listServerIdsForNodeIds(
  tx: DbHandle,
  nodeIds: readonly string[],
): Promise<string[]> {
  if (nodeIds.length === 0) {
    return [];
  }
  const rows = await tx
    .selectDistinct({ serverId: node.serverId })
    .from(node)
    .where(inArray(node.id, [...nodeIds]));
  return rows.map((row) => row.serverId);
}

/** Servers hosting enabled nodes reachable from any of the given groups. */
export async function listServerIdsForGroupIds(
  tx: DbHandle,
  groupIds: readonly string[],
): Promise<string[]> {
  if (groupIds.length === 0) {
    return [];
  }
  const rows = await tx
    .selectDistinct({ serverId: node.serverId })
    .from(nodeGroup)
    .innerJoin(node, eq(node.id, nodeGroup.nodeId))
    .where(
      and(inArray(nodeGroup.groupId, [...groupIds]), eq(node.enabled, true)),
    );
  return rows.map((row) => row.serverId);
}

/** Servers hosting enabled nodes reachable from any of the given plans. */
export async function listServerIdsForPlanIds(
  tx: DbHandle,
  planIds: readonly string[],
): Promise<string[]> {
  if (planIds.length === 0) {
    return [];
  }
  const rows = await tx
    .selectDistinct({ serverId: node.serverId })
    .from(planGroup)
    .innerJoin(nodeGroup, eq(nodeGroup.groupId, planGroup.groupId))
    .innerJoin(node, eq(node.id, nodeGroup.nodeId))
    .where(
      and(inArray(planGroup.planId, [...planIds]), eq(node.enabled, true)),
    );
  return rows.map((row) => row.serverId);
}

/** Servers hosting enabled nodes a subscription can reach (its plan's groups). */
export async function listServerIdsForSubscriptionId(
  tx: DbHandle,
  subscriptionId: string,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ serverId: node.serverId })
    .from(subscription)
    .innerJoin(planGroup, eq(planGroup.planId, subscription.planId))
    .innerJoin(nodeGroup, eq(nodeGroup.groupId, planGroup.groupId))
    .innerJoin(node, eq(node.id, nodeGroup.nodeId))
    .where(and(eq(subscription.id, subscriptionId), eq(node.enabled, true)));
  return rows.map((row) => row.serverId);
}

/** Servers hosting enabled nodes reachable by any active plan of the user. */
export async function listServerIdsForUserId(
  tx: DbHandle,
  userId: string,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ serverId: node.serverId })
    .from(subscription)
    .innerJoin(planGroup, eq(planGroup.planId, subscription.planId))
    .innerJoin(nodeGroup, eq(nodeGroup.groupId, planGroup.groupId))
    .innerJoin(node, eq(node.id, nodeGroup.nodeId))
    .where(and(eq(subscription.userId, userId), eq(node.enabled, true)));
  return rows.map((row) => row.serverId);
}

/** Servers with an enabled deployment binding for the certificate. */
export async function listServerIdsForCertificateId(
  tx: DbHandle,
  certificateId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ serverId: certificateServer.serverId })
    .from(certificateServer)
    .where(
      and(
        eq(certificateServer.certificateId, certificateId),
        eq(certificateServer.enabled, true),
      ),
    );
  return rows.map((row) => row.serverId);
}

// --- Gate read side -----------------------------------------------------------

/**
 * All changes recorded against the given servers that the server has not yet
 * confirmed applied (`revisionSeq > appliedRevisionSeq`). The result set is
 * bounded by the poll window — normally a handful of rows.
 */
export async function listPendingConfigChanges(
  serverIds: readonly string[],
): Promise<PendingConfigChange[]> {
  if (serverIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      kind: configChange.kind,
      subjectId: configChange.subjectId,
      prevRow: configChange.prevRow,
      serverId: configChangeServer.serverId,
      revisionSeq: configChangeServer.revisionSeq,
    })
    .from(configChangeServer)
    .innerJoin(configChange, eq(configChange.id, configChangeServer.changeId))
    .innerJoin(server, eq(server.id, configChangeServer.serverId))
    .where(
      and(
        inArray(configChangeServer.serverId, [...serverIds]),
        gt(configChangeServer.revisionSeq, server.appliedRevisionSeq),
      ),
    );
  return rows;
}

/** Pending-change count per server, for the admin "awaiting apply" indicator. */
export async function countPendingConfigChangesByServer(
  serverIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (serverIds.length === 0) {
    return counts;
  }
  const rows = await db
    .select({
      serverId: configChangeServer.serverId,
      count: sql<number>`count(*)::int`,
    })
    .from(configChangeServer)
    .innerJoin(server, eq(server.id, configChangeServer.serverId))
    .where(
      and(
        inArray(configChangeServer.serverId, [...serverIds]),
        gt(configChangeServer.revisionSeq, server.appliedRevisionSeq),
      ),
    )
    .groupBy(configChangeServer.serverId);
  for (const row of rows) {
    counts.set(row.serverId, row.count);
  }
  return counts;
}

/**
 * Garbage collection: once a server's applied seq passes a change's revision
 * seq the link can never gate again. Called from the heartbeat handler, where
 * `appliedRevisionSeq` moves forward. Orphaned `config_change` rows cascade
 * away with their last link.
 */
export async function pruneAppliedConfigChanges(
  serverId: string,
  appliedRevisionSeq: number,
): Promise<void> {
  await db
    .delete(configChangeServer)
    .where(
      and(
        eq(configChangeServer.serverId, serverId),
        sql`${configChangeServer.revisionSeq} <= ${appliedRevisionSeq}`,
      ),
    );
  // Orphaned change rows (no server links left) are garbage: prune via an
  // explicit left join rather than a raw NOT EXISTS template.
  const orphans = await db
    .select({ id: configChange.id })
    .from(configChange)
    .leftJoin(
      configChangeServer,
      eq(configChangeServer.changeId, configChange.id),
    )
    .where(isNull(configChangeServer.changeId));
  if (orphans.length > 0) {
    await db.delete(configChange).where(
      inArray(
        configChange.id,
        orphans.map((orphan) => orphan.id),
      ),
    );
  }
}
