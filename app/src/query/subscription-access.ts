import {
  buildEntranceOrderRanks,
  orderGatedEntrances,
} from "@blossom/domain/group-membership";
import { and, asc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";

import { type Database, db } from "@/db";
import { user } from "@/db/auth-schema";
import { planGroup, subscription } from "@/db/plan-schema";
import type { Subscription } from "@/db/plan-schema";
import {
  type CertificateKind,
  managedCertificate,
  type Node,
  node,
  nodeGroup,
  proxyGroup,
  server,
} from "@/db/proxy-schema";
import {
  applyPortForwardOverlay,
  type PortForwardRelay,
} from "@/lib/port-forward-relay";
import {
  applyPublishGate,
  type GateResult,
  type PlanAuthzPrevRow,
  type SubscriptionAuthzPrevRow,
} from "@/lib/publish-gate";
import { listPendingConfigChanges } from "@/query/config-change";
import { listSubscriptionPortForwards } from "@/query/port-forward-store";

/**
 * Minimal, never-secret-bearing summary of the server a node lives on. Only
 * what the client-facing config and audit UI need: the public address (the
 * node's fallback when it has no override) and an identity for display. The
 * agent token hash/prefix, heartbeat, and version are deliberately excluded
 * so this struct is safe to thread through subscription/Clash compilation
 * paths without surprising leak paths. `enabled` is omitted because the access
 * queries already filtered on it; carrying it here would be redundant.
 */
export interface ServerSummary {
  id: string;
  name: string;
  address: string;
  /**
   * Present when a caller already loaded the row. Subscription access queries
   * filter disabled servers, so this is normally `true`.
   */
  enabled?: boolean;
}

/**
 * A node paired with the owning server's public summary after the access
 * queries. `address` is the resolved client-facing endpoint
 * (`node.address ?? server.address`); callers that emit client configs use
 * this single field instead of touching the raw columns so the
 * override/fallback rule lives in one place.
 */
export interface ResolvedNode {
  node: Node;
  server: ServerSummary;
  /** Final client-facing address: per-node override or server fallback. */
  address: string;
  certificateKind: CertificateKind | null;
  /** L4 port forward: client-facing port inherited from the transit server. */
  portOverride?: number;
  /** L4 port forward: display name emitted instead of the exit node's name. */
  nameOverride?: string;
  /** Set only when this entrance was produced by an L4 port forward relay. */
  portForward?: PortForwardRelay;
}

export { applyPortForwardOverlay };
export type { PortForwardRelay };

function resolve(
  nodeRow: Node,
  serverRow: ServerSummary,
  certificateKind: CertificateKind | null,
): ResolvedNode {
  return {
    node: nodeRow,
    server: serverRow,
    address: nodeRow.address ?? serverRow.address,
    certificateKind,
  };
}

/**
 * Finds an active subscription by its public link token. Returns the
 * subscription together with the user row so callers can enforce bans.
 */
export async function findSubscriptionByToken(token: string): Promise<{
  subscription: Subscription;
  user: { banned: boolean | null; banExpires: Date | null };
} | null> {
  const [row] = await db
    .select({
      subscription,
      user: { banned: user.banned, banExpires: user.banExpires },
    })
    .from(subscription)
    .innerJoin(user, eq(user.id, subscription.userId))
    .where(eq(subscription.token, token));

  return row ?? null;
}

/**
 * Resolves the nodes a single subscription may access right now. The caller is
 * expected to have already validated the subscription status, expiration, ban
 * state, and traffic quota. This only filters the node/server side
 * (`node.enabled = true`, `server.enabled = true`, and the subscription's plan
 * groups) and resolves the per-node address fallback.
 */
export async function getSubscriptionAccessibleNodes(
  subscriptionId: string,
): Promise<ResolvedNode[]> {
  const rows = await db
    .select({
      node,
      server: {
        id: server.id,
        name: server.name,
        address: server.address,
      },
      certificateKind: managedCertificate.kind,
      groupId: proxyGroup.id,
      groupSortOrder: proxyGroup.sortOrder,
      position: nodeGroup.position,
    })
    .from(subscription)
    .innerJoin(planGroup, eq(planGroup.planId, subscription.planId))
    .innerJoin(proxyGroup, eq(proxyGroup.id, planGroup.groupId))
    .innerJoin(nodeGroup, eq(nodeGroup.groupId, planGroup.groupId))
    .innerJoin(node, eq(node.id, nodeGroup.nodeId))
    .innerJoin(server, eq(server.id, node.serverId))
    .leftJoin(managedCertificate, eq(managedCertificate.id, node.certificateId))
    .where(
      and(
        eq(subscription.id, subscriptionId),
        eq(node.enabled, true),
        eq(server.enabled, true),
      ),
    );

  // Subscription order: plan groups by (sort_order, group id), then each
  // group's member positions with the stable node id as the final tie-breaker.
  // Rank only this currently visible set; the publish gate later filters it
  // without adding a pending, revoked, or disabled entrance back.
  const ranks = buildEntranceOrderRanks(
    rows.map((row) => ({
      groupId: row.groupId,
      groupSortOrder: row.groupSortOrder,
      nodeId: row.node.id,
      position: row.position,
    })),
  );
  const byId = new Map<string, ResolvedNode>();
  for (const { node: n, server: s, certificateKind } of rows) {
    byId.set(n.id, resolve(n, s, certificateKind));
  }
  const visible = orderGatedEntrances(
    [...byId.values()],
    ranks,
    (resolved) => resolved.node.id,
  );

  // L4 port forwards on an enabled transit server expose the same exit-node
  // protocol, TLS/Reality settings and credentials at the transit endpoint. The
  // publish gate withholds them until both servers have applied their config.
  const forwards = await listSubscriptionPortForwards([...byId.keys()]);
  const relayed = forwards.flatMap(({ forward, transitServer }) => {
    const exitNode = byId.get(forward.targetNodeId ?? "");
    return exitNode
      ? [applyPortForwardOverlay(exitNode, forward, transitServer)]
      : [];
  });

  return [...visible, ...relayed];
}

/**
 * Applies the publish gate (`@/lib/publish-gate`) to a subscription's
 * currently visible nodes: fetches the changes not yet confirmed applied on
 * the hosting servers plus — only when authorization changes pend — the
 * current plan/group bindings the visibility replay needs, then replays each
 * node to the state its server is actually serving.
 */
export async function getGatedSubscriptionView(input: {
  subscription: Subscription;
  user: { banned: boolean | null; banExpires: Date | null };
  nodes: ResolvedNode[];
}): Promise<GateResult> {
  const { subscription: sub, user: userRow, nodes } = input;
  const serverIds = [...new Set(nodes.map((resolved) => resolved.server.id))];
  const pending = await listPendingConfigChanges(serverIds);
  if (pending.length === 0) {
    return {
      eligible: true,
      nodes,
      credentialsByNodeId: new Map(),
    };
  }

  // Current bindings are only needed to replay visibility when authorization
  // changes pend. Collect the involved plans/groups: the subscription's
  // current plan, any previous plan from a pending plan switch, and every
  // group named by a pending plan/group change.
  const planIds = new Set<string>([sub.planId]);
  const groupIds = new Set<string>();
  for (const change of pending) {
    if (change.kind !== "authorization") {
      continue;
    }
    if (change.subjectId === sub.id && change.prevRow) {
      const prev = change.prevRow as SubscriptionAuthzPrevRow;
      if (prev.planId) {
        planIds.add(prev.planId);
      }
    }
    const prevGroups = (change.prevRow as PlanAuthzPrevRow | undefined)
      ?.groupIds;
    if (prevGroups) {
      for (const groupId of prevGroups) {
        groupIds.add(groupId);
      }
    }
  }

  const planRows = await db
    .select({ planId: planGroup.planId, groupId: planGroup.groupId })
    .from(planGroup)
    .where(inArray(planGroup.planId, [...planIds]));
  const planGroupIds = new Map<string, string[]>();
  for (const row of planRows) {
    const list = planGroupIds.get(row.planId) ?? [];
    list.push(row.groupId);
    planGroupIds.set(row.planId, list);
    groupIds.add(row.groupId);
  }

  const groupNodeIds = new Map<string, string[]>();
  if (groupIds.size > 0) {
    const groupRows = await db
      .select({ groupId: nodeGroup.groupId, nodeId: nodeGroup.nodeId })
      .from(nodeGroup)
      .where(inArray(nodeGroup.groupId, [...groupIds]));
    for (const row of groupRows) {
      const list = groupNodeIds.get(row.groupId) ?? [];
      list.push(row.nodeId);
      groupNodeIds.set(row.groupId, list);
    }
  }

  return applyPublishGate({
    now: new Date(),
    subscription: sub,
    user: userRow,
    nodes,
    pending,
    planGroupIds,
    groupNodeIds,
  });
}

/**
 * Resolves the nodes a user may access right now: the union of nodes across
 * all groups bound to the plans of the user's active, unexpired subscriptions.
 * Multiple subscriptions stack. Both server- and node-level `enabled` flags
 * are filters here — a disabled server hides all of its nodes, and a disabled
 * node is hidden individually. Traffic exhaustion is deliberately not
 * filtered here yet — enforcement is a separate concern.
 *
 * Callers are user-facing endpoints and the subscription compiler, which
 * bring their own auth.
 */
export async function getUserAccessibleNodes(
  userId: string,
): Promise<ResolvedNode[]> {
  const rows = await db
    .select({
      node,
      server: {
        id: server.id,
        name: server.name,
        address: server.address,
      },
      certificateKind: managedCertificate.kind,
    })
    .from(subscription)
    .innerJoin(planGroup, eq(planGroup.planId, subscription.planId))
    .innerJoin(proxyGroup, eq(proxyGroup.id, planGroup.groupId))
    .innerJoin(nodeGroup, eq(nodeGroup.groupId, planGroup.groupId))
    .innerJoin(node, eq(node.id, nodeGroup.nodeId))
    .innerJoin(server, eq(server.id, node.serverId))
    .leftJoin(managedCertificate, eq(managedCertificate.id, node.certificateId))
    .where(
      and(
        eq(subscription.userId, userId),
        eq(subscription.status, "active"),
        gt(subscription.expiresAt, new Date()),
        eq(node.enabled, true),
        eq(server.enabled, true),
      ),
    )
    .orderBy(
      asc(subscription.id),
      asc(proxyGroup.sortOrder),
      asc(proxyGroup.id),
      asc(nodeGroup.position),
      asc(nodeGroup.nodeId),
    );

  // Dedupe in JS: DISTINCT over jsonb columns is awkward, and overlapping
  // groups across plans produce duplicates.
  const byId = new Map<string, ResolvedNode>();
  for (const { node: n, server: s, certificateKind } of rows) {
    byId.set(n.id, resolve(n, s, certificateKind));
  }
  return [...byId.values()];
}

/**
 * Inverse of `getUserAccessibleNodes`: the subscriptions entitled to use a node
 * right now, i.e. the entries to embed as sing-box inbound users when compiling
 * that node's config. Filters out expired/cancelled subscriptions, banned users
 * (`banned` is trusted only alongside `banExpires` — better-auth clears expired
 * bans lazily), and exhausted quotas (0 means unlimited, mirroring deviceLimit).
 * Enforcement is exactly this filter: a dropped subscription disappears from the
 * config on the agent's next pull. Server-level disable is enforced upstream —
 * the agent endpoint compiles the config for an enabled server and walks every
 * enabled node through this resolver — so we only re-check the node here.
 *
 * The caller is the token-authenticated agent endpoint.
 */
export async function getNodeActiveSubscriptions(
  nodeId: string,
  database: Database = db,
): Promise<Subscription[]> {
  const rows = await activeSubscriptionRows([nodeId], database);

  // Overlapping groups across plans produce duplicate rows; dedupe by id.
  const byId = new Map<string, Subscription>();
  for (const row of rows) {
    byId.set(row.subscription.id, row.subscription);
  }
  return [...byId.values()];
}

/**
 * Batch form of {@link getNodeActiveSubscriptions}: the subscriptions entitled
 * to use each of `nodeIds` right now, resolved with ONE query instead of one
 * per node. Config compilation uses this so a server with many nodes does not
 * pay an N+1 round trip per compile.
 *
 * Nodes with no active subscriptions are absent from the map; callers treat a
 * missing entry as an empty list. Each list keeps the same deterministic
 * `asc(subscription.id)` ordering as the single-node query, and duplicate rows
 * from overlapping groups are collapsed per node.
 */
export async function getServerActiveSubscriptionsByNode(
  nodeIds: readonly string[],
  database: Database = db,
): Promise<Map<string, Subscription[]>> {
  const rows = await activeSubscriptionRows(nodeIds, database);

  const byNode = new Map<string, Map<string, Subscription>>();
  for (const row of rows) {
    let nodeSubscriptions = byNode.get(row.nodeId);
    if (!nodeSubscriptions) {
      nodeSubscriptions = new Map();
      byNode.set(row.nodeId, nodeSubscriptions);
    }
    nodeSubscriptions.set(row.subscription.id, row.subscription);
  }

  const result = new Map<string, Subscription[]>();
  for (const [nodeId, nodeSubscriptions] of byNode) {
    result.set(nodeId, [...nodeSubscriptions.values()]);
  }
  return result;
}

/**
 * One query for the active subscriptions of every node in `nodeIds`, ordered
 * by node and then subscription id. Entitlement, active-window, ban and quota
 * filters are shared with the single-node query, so both callers compile
 * identical user arrays.
 */
async function activeSubscriptionRows(
  nodeIds: readonly string[],
  database: Database,
): Promise<{ nodeId: string; subscription: Subscription }[]> {
  if (nodeIds.length === 0) {
    return [];
  }
  const now = new Date();
  return (
    database
      .select({ nodeId: nodeGroup.nodeId, subscription })
      .from(nodeGroup)
      .innerJoin(planGroup, eq(planGroup.groupId, nodeGroup.groupId))
      .innerJoin(subscription, eq(subscription.planId, planGroup.planId))
      .innerJoin(user, eq(user.id, subscription.userId))
      .where(
        and(
          inArray(nodeGroup.nodeId, [...nodeIds]),
          eq(subscription.status, "active"),
          gt(subscription.expiresAt, now),
          or(
            isNull(user.banned),
            eq(user.banned, false),
            // Expired temp ban not yet cleared by better-auth. NULL banExpires
            // (permanent ban) yields SQL NULL here, i.e. stays excluded.
            lt(user.banExpires, now),
          ),
          or(
            eq(subscription.trafficQuotaBytes, 0),
            lt(subscription.trafficUsedBytes, subscription.trafficQuotaBytes),
          ),
        ),
      )
      // Deterministic user ordering: the compiled sing-box `users` array feeds
      // the V3 desired revision, so identical entitlement snapshots must produce
      // byte-identical output regardless of query plan.
      .orderBy(asc(nodeGroup.nodeId), asc(subscription.id))
  );
}
