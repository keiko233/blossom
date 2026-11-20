import {
  type AgentStatusLike,
  deriveNodeHealth,
  type NodeHealth,
} from "@blossom/domain/agent-status";

/**
 * Pure helpers behind the group, plan and subscription admin pages: which
 * unique nodes a set of groups resolves to, what an edit or delete would
 * touch, and how plan snapshots relate to existing subscriptions. They only
 * restate what the control plane stores (memberships, enabled flags and the
 * agent's last report). None of them claims that a client can connect or that
 * an agent has already applied a change, and the server stays authoritative.
 */

export interface PreviewNodeServer extends AgentStatusLike {
  id: string;
  name: string;
}

/** The subset of the admin node list the preview reads. */
export interface PreviewNode {
  id: string;
  name: string;
  enabled: boolean;
  protocol: string;
  listenPort: number;
  resolvedAddress: string;
  serverSummary: PreviewNodeServer;
}

export interface PreviewGroup {
  id: string;
  name: string;
  /** Lower sorts first; ties fall back to the stable group id. */
  sortOrder?: number;
  /** Current membership order (`position ASC, nodeId ASC`). */
  nodeIds: readonly string[];
}

export interface EffectiveNode {
  node: PreviewNode;
  /** The node-level view of the agent's last report; not client reachability. */
  health: NodeHealth;
  /**
   * Disabled node or disabled server: the subscription query drops it, so it
   * is not handed to any subscription however the groups are set up.
   */
  filtered: boolean;
  /** Selected groups that contain this node (empty for a direct selection). */
  groupIds: string[];
}

export interface EffectiveNodePreview {
  /**
   * Unique nodes. Group previews sort by server name, node name and id;
   * direct selections keep their first-occurrence membership order.
   */
  nodes: EffectiveNode[];
  /** Nodes dropped from subscriptions because the node or server is disabled. */
  filteredCount: number;
  /** Not filtered, but the last agent report does not show it serving or idle. */
  needsAttentionCount: number;
  /** Member ids with no matching node (stale list or a concurrent delete). */
  missingNodeIds: string[];
  /** Selected group ids with no matching group. */
  unknownGroupIds: string[];
  /** Selected groups that exist but hold no nodes. */
  emptyGroupIds: string[];
}

const FILTERED_HEALTH: ReadonlySet<NodeHealth> = new Set([
  "server_disabled",
  "disabled",
]);
const SETTLED_HEALTH: ReadonlySet<NodeHealth> = new Set(["serving", "idle"]);

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function buildPreview(input: {
  /** group id → member node ids; "" is the direct-selection pseudo group. */
  memberships: ReadonlyArray<{ groupId: string; nodeIds: readonly string[] }>;
  nodes: readonly PreviewNode[];
  now: number;
  /** Keeps membership order when false; group previews stay deterministic. */
  sortNodes?: boolean;
}): Pick<EffectiveNodePreview, "nodes" | "missingNodeIds"> {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const viaGroups = new Map<string, string[]>();
  const missing: string[] = [];

  for (const { groupId, nodeIds } of input.memberships) {
    for (const nodeId of dedupe(nodeIds)) {
      if (!nodeById.has(nodeId)) {
        missing.push(nodeId);
        continue;
      }
      const list = viaGroups.get(nodeId) ?? [];
      if (groupId) list.push(groupId);
      viaGroups.set(nodeId, list);
    }
  }

  const nodes = [...viaGroups.entries()].map(([nodeId, groupIds]) => {
    const node = nodeById.get(nodeId)!;
    const health = deriveNodeHealth(
      node.id,
      node.enabled,
      node.serverSummary,
      input.now,
    );
    return {
      node,
      health,
      filtered: FILTERED_HEALTH.has(health),
      groupIds,
    };
  });
  if (input.sortNodes !== false) {
    nodes.sort(
      (a, b) =>
        a.node.serverSummary.name.localeCompare(b.node.serverSummary.name) ||
        a.node.name.localeCompare(b.node.name) ||
        a.node.id.localeCompare(b.node.id),
    );
  }
  return { nodes, missingNodeIds: dedupe(missing) };
}

function finish(
  base: Pick<EffectiveNodePreview, "nodes" | "missingNodeIds">,
  groups: Pick<EffectiveNodePreview, "unknownGroupIds" | "emptyGroupIds">,
): EffectiveNodePreview {
  return {
    ...base,
    ...groups,
    filteredCount: base.nodes.filter((entry) => entry.filtered).length,
    needsAttentionCount: base.nodes.filter(
      (entry) => !entry.filtered && !SETTLED_HEALTH.has(entry.health),
    ).length,
  };
}

/**
 * The unique nodes the selected groups resolve to. A node reachable through
 * several groups appears once and lists each group that reaches it. Unknown
 * groups and members without a node are reported instead of silently skipped.
 */
export function previewEffectiveNodes(input: {
  groupIds: readonly string[];
  groups: readonly PreviewGroup[];
  nodes: readonly PreviewNode[];
  now?: number;
}): EffectiveNodePreview {
  const groupById = new Map(input.groups.map((group) => [group.id, group]));
  const selected = dedupe(input.groupIds);
  const known = selected
    .flatMap((id) => {
      const group = groupById.get(id);
      return group ? [group] : [];
    })
    .sort(
      (a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id),
    );
  return finish(
    buildPreview({
      memberships: known.map((group) => ({
        groupId: group.id,
        nodeIds: group.nodeIds,
      })),
      nodes: input.nodes,
      now: input.now ?? Date.now(),
      sortNodes: false,
    }),
    {
      unknownGroupIds: selected.filter((id) => !groupById.has(id)),
      emptyGroupIds: known
        .filter((group) => group.nodeIds.length === 0)
        .map((group) => group.id),
    },
  );
}

/** The same preview for nodes picked directly, as in the group editor. */
export function previewNodeSelection(input: {
  nodeIds: readonly string[];
  nodes: readonly PreviewNode[];
  now?: number;
}): EffectiveNodePreview {
  return finish(
    buildPreview({
      memberships: [{ groupId: "", nodeIds: input.nodeIds }],
      nodes: input.nodes,
      now: input.now ?? Date.now(),
      sortNodes: false,
    }),
    { unknownGroupIds: [], emptyGroupIds: [] },
  );
}

/** Nodes in the preview that a subscription query would still return. */
export function distributableCount(preview: EffectiveNodePreview): number {
  return preview.nodes.length - preview.filteredCount;
}

export interface SelectionDiff {
  added: string[];
  removed: string[];
}

/** Ids gained and lost between two selections; order and duplicates ignored. */
export function diffSelection(
  before: readonly string[],
  after: readonly string[],
): SelectionDiff {
  const previous = new Set(before);
  const next = new Set(after);
  return {
    added: [...next].filter((id) => !previous.has(id)),
    removed: [...previous].filter((id) => !next.has(id)),
  };
}

function effectiveNodeIds(
  groupIds: readonly string[],
  groups: readonly PreviewGroup[],
): Set<string> {
  const selected = new Set(groupIds);
  const ids = new Set<string>();
  for (const group of groups) {
    if (!selected.has(group.id)) continue;
    for (const nodeId of group.nodeIds) ids.add(nodeId);
  }
  return ids;
}

/**
 * Nodes a plan gains or loses when its group list changes. A node removed
 * with one group but still reached through another stays and is not reported.
 */
export function diffEffectiveNodes(input: {
  beforeGroupIds: readonly string[];
  afterGroupIds: readonly string[];
  groups: readonly PreviewGroup[];
}): SelectionDiff {
  return diffSelection(
    [...effectiveNodeIds(input.beforeGroupIds, input.groups)],
    [...effectiveNodeIds(input.afterGroupIds, input.groups)],
  );
}

// --- plans and snapshots -----------------------------------------------------

export interface PlanSnapshotFields {
  trafficBytes: number;
  deviceLimit: number;
  durationDays: number;
}

export type PlanSnapshotField = "traffic" | "devices" | "duration";

/**
 * Plan fields an edit changes that existing subscriptions have already copied
 * (traffic quota, device limit) or computed from (duration → expiry). Saving a
 * plan never rewrites them; they only apply to subscriptions created or moved
 * onto the plan afterwards.
 */
export function changedSnapshotFields(
  saved: PlanSnapshotFields,
  next: PlanSnapshotFields,
): PlanSnapshotField[] {
  const changed: PlanSnapshotField[] = [];
  if (saved.trafficBytes !== next.trafficBytes) changed.push("traffic");
  if (saved.deviceLimit !== next.deviceLimit) changed.push("devices");
  if (saved.durationDays !== next.durationDays) changed.push("duration");
  return changed;
}

/**
 * Whether a subscription's stored quota or device limit differs from its
 * plan's current values (the plan was edited, or the subscription was
 * adjusted by hand) so the list can say so instead of implying they are tied.
 */
export function snapshotDrift(
  subscription: { trafficQuotaBytes: number; deviceLimit: number },
  plan: { trafficBytes: number; deviceLimit: number },
): { traffic: boolean; devices: boolean } {
  return {
    traffic: subscription.trafficQuotaBytes !== plan.trafficBytes,
    devices: subscription.deviceLimit !== plan.deviceLimit,
  };
}

export interface PlanImpact {
  subscriptionCount: number;
  activeSubscriptionCount: number;
  redeemBatchCount: number;
  isTrialPlan: boolean;
}

export type PlanDeleteBlocker = "trial" | "subscriptions" | "redeem_batches";

/**
 * Why `deletePlan` will refuse, in the order the server checks them. This is
 * advisory: the server re-checks at delete time and may disagree if something
 * changed since the counts were read.
 */
export function planDeleteBlockers(impact: PlanImpact): PlanDeleteBlocker[] {
  const blockers: PlanDeleteBlocker[] = [];
  if (impact.isTrialPlan) blockers.push("trial");
  if (impact.subscriptionCount > 0) blockers.push("subscriptions");
  if (impact.redeemBatchCount > 0) blockers.push("redeem_batches");
  return blockers;
}

// --- groups --------------------------------------------------------------------

export interface GroupPlanUsage {
  id: string;
  name: string;
  subscriptionCount: number;
}

export interface GroupImpact {
  plans: GroupPlanUsage[];
  /**
   * Subscriptions whose plan uses the group. Each subscription has exactly one
   * plan, so summing per plan counts each subscription once.
   */
  subscriptionCount: number;
}

export function summarizeGroupImpact(plans: GroupPlanUsage[]): GroupImpact {
  return {
    plans,
    subscriptionCount: plans.reduce(
      (total, plan) => total + plan.subscriptionCount,
      0,
    ),
  };
}

/** A group is unused when no plan binds it, so editing it affects nobody yet. */
export function isGroupUnused(impact: GroupImpact): boolean {
  return impact.plans.length === 0;
}
