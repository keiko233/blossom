import type { Subscription, SubscriptionStatus } from "@/db/plan-schema";
import type {
  CertificateKind,
  ConfigChangeKind,
  Node,
} from "@/db/proxy-schema";
import type { ResolvedNode, ServerSummary } from "@/query/subscription-access";

/**
 * Subscription publish gate — the pure half.
 *
 * Problem: the subscription endpoint and the server-agent both compile from
 * the same desired-state rows, but the agent only learns about changes on its
 * next poll. Without a gate, a subscription fetched inside that window
 * describes config the agent is not serving yet, and the user cannot connect.
 *
 * Rule: a subscription publishes, per node, the state that the node's server
 * has *confirmed applied* (heartbeat `appliedRevision` → per-server
 * `appliedRevisionSeq`). Changes recorded in `config_change` that are still
 * ahead of a server's applied seq are replayed backwards from their `prevRow`
 * snapshot:
 *
 *  - node updated        → emit the node's pre-change snapshot
 *  - node created        → omit (the applied state has no such node)
 *  - node enabled        → omit (was disabled); node disabled → already
 *                          filtered by the access query (safe direction)
 *  - node deleted        → omitted immediately (safe direction: the agent may
 *                          still serve it, but offering nothing new can never
 *                          strand a client — we deliberately do not resurrect)
 *  - credential rotated  → per-node fallback to the previous credentials on
 *                          servers that have not applied the rotation
 *  - subscription created→ omit nodes on unapplied servers (the applied agent
 *                          config has no such user at all)
 *  - authorization added → omit newly visible nodes until applied; removals
 *                          take effect immediately (safe direction)
 *  - re-activation (subscription un-cancelled/extended, user unbanned)
 *                        → subscription stays ineligible until applied
 *  - server enabled      → its nodes stay hidden until applied; server
 *                          disabled hides them immediately (safe direction)
 *
 * Certificate rotations are intentionally absent: they change the agent's
 * desired state (driven by the revision hash, not the gate) but never the
 * client-facing payload — a renewed certificate keeps the same domains/SNI.
 * Node/server *address* changes are also ungated: the address is resolved
 * client-side (DNS) and the agent listens on a wildcard, so there is no
 * agent-side state to wait for.
 *
 * This module is pure for testability; `@/query/config-change` assembles the
 * inputs from the database.
 */

export interface PendingConfigChange {
  kind: ConfigChangeKind;
  subjectId: string;
  prevRow: unknown;
  /** The server this change is still unapplied on. */
  serverId: string;
  revisionSeq: number;
}

// --- prevRow shapes (written by the mutation paths, read here) --------------

/** Pre-change snapshot of a node as the subscription compiler saw it. */
export interface NodeChangePrevRow {
  node: Node;
  server: ServerSummary;
  certificateKind: CertificateKind | null;
}

export interface CredentialChangePrevRow {
  credentialUuid: string;
  credentialPassword: string;
}

export interface ServerChangePrevRow {
  enabled: boolean;
}

/**
 * Authorization prevRows by subject:
 *  - subject = subscriptionId → `{ planId?, status?, expiresAt? }`
 *  - subject = planId         → `{ groupIds }` (previous plan_group bindings)
 *  - subject = groupId        → `{ nodeIds }`  (previous node_group members)
 *  - subject = userId         → `{ banned, banExpires }`
 */
export interface SubscriptionAuthzPrevRow {
  planId?: string;
  status?: SubscriptionStatus;
  /** ISO string (JSON round-trip). */
  expiresAt?: string;
}
export interface PlanAuthzPrevRow {
  groupIds: string[];
}
export interface GroupAuthzPrevRow {
  nodeIds: string[];
}
export interface UserAuthzPrevRow {
  banned: boolean | null;
  /** ISO string (JSON round-trip). */
  banExpires?: string | null;
}

export interface SubscriptionCredentials {
  uuid: string;
  password: string;
}

export interface GateInput {
  now: Date;
  subscription: Pick<
    Subscription,
    | "id"
    | "userId"
    | "planId"
    | "status"
    | "expiresAt"
    | "credentialUuid"
    | "credentialPassword"
  >;
  user: { banned: boolean | null; banExpires: Date | null };
  /** Currently visible nodes (the access query's fresh result). */
  nodes: ResolvedNode[];
  /** All changes not yet applied on the servers hosting `nodes`. */
  pending: PendingConfigChange[];
  /** Current plan → group bindings; consulted when authorization changes pend. */
  planGroupIds: ReadonlyMap<string, string[]>;
  /** Current group → node memberships; consulted when authorization changes pend. */
  groupNodeIds: ReadonlyMap<string, string[]>;
}

export interface GateResult {
  /** False ⇒ the subscription must answer as ineligible until agents apply. */
  eligible: boolean;
  nodes: ResolvedNode[];
  /** Per-node credential overrides; nodes absent from the map use the current. */
  credentialsByNodeId: ReadonlyMap<string, SubscriptionCredentials>;
}

function keyOf(change: PendingConfigChange): string {
  return `${change.kind}:${change.subjectId}:${change.serverId}`;
}

/**
 * Keeps only the oldest (lowest revisionSeq) pending change per
 * (kind, subject, server): replaying to the oldest unapplied snapshot
 * subsumes every later change on that server.
 */
function oldestChanges(
  pending: PendingConfigChange[],
): Map<string, PendingConfigChange> {
  const oldest = new Map<string, PendingConfigChange>();
  for (const change of pending) {
    const key = keyOf(change);
    const existing = oldest.get(key);
    if (!existing || change.revisionSeq < existing.revisionSeq) {
      oldest.set(key, change);
    }
  }
  return oldest;
}

/** Mirrors the ban check in the subscription route's eligibility test. */
function isEffectivelyBanned(
  banned: boolean | null,
  banExpires: Date | null,
  now: Date,
): boolean {
  return Boolean(banned) && !(banExpires !== null && banExpires < now);
}

export function applyPublishGate(input: GateInput): GateResult {
  const { now, subscription, user, nodes, pending } = input;
  const oldest = oldestChanges(pending);
  const find = (kind: ConfigChangeKind, subjectId: string, serverId?: string) =>
    oldest.get(`${kind}:${subjectId}:${serverId ?? ""}`) ??
    (serverId === undefined
      ? // Subject-scoped lookups (subscription/user/plan/group) apply to the
        // subscription as a whole: the change is pending if it is unapplied on
        // ANY server, so fall back to the oldest across servers.
        pending
          .filter((c) => c.kind === kind && c.subjectId === subjectId)
          .sort((a, b) => a.revisionSeq - b.revisionSeq)[0]
      : undefined);

  // --- Eligibility replay ---------------------------------------------------
  //
  // Re-activation directions wait for the agent; de-activation directions are
  // already enforced against the current rows by the caller (safe direction).
  let eligible = true;

  const subChange = find("authorization", subscription.id);
  if (subChange?.prevRow) {
    const prev = subChange.prevRow as SubscriptionAuthzPrevRow;
    const wasEligible =
      (prev.status ?? subscription.status) === "active" &&
      new Date(prev.expiresAt ?? subscription.expiresAt) > now;
    const isEligible =
      subscription.status === "active" && subscription.expiresAt > now;
    if (isEligible && !wasEligible) {
      eligible = false;
    }
  }

  const userChange = find("authorization", subscription.userId);
  if (userChange?.prevRow) {
    const prev = userChange.prevRow as UserAuthzPrevRow;
    const wasBanned = isEffectivelyBanned(
      prev.banned ?? null,
      prev.banExpires ? new Date(prev.banExpires) : null,
      now,
    );
    const isBanned = isEffectivelyBanned(user.banned, user.banExpires, now);
    if (!isBanned && wasBanned) {
      eligible = false;
    }
  }

  // --- Authorization visibility replay --------------------------------------
  //
  // Rebuilds "was this node visible in the applied state?" using each changed
  // relation's prevRow, falling back to current bindings for untouched links.
  const prevPlanId =
    (subChange?.prevRow as SubscriptionAuthzPrevRow | undefined)?.planId ??
    subscription.planId;
  const planChange = find("authorization", prevPlanId);
  const visibleGroupIds =
    (planChange?.prevRow as PlanAuthzPrevRow | undefined)?.groupIds ??
    input.planGroupIds.get(prevPlanId) ??
    [];
  const appliedVisibleNodeIds = new Set<string>();
  for (const groupId of visibleGroupIds) {
    const groupChange = find("authorization", groupId);
    const memberIds =
      (groupChange?.prevRow as GroupAuthzPrevRow | undefined)?.nodeIds ??
      input.groupNodeIds.get(groupId) ??
      [];
    for (const nodeId of memberIds) {
      appliedVisibleNodeIds.add(nodeId);
    }
  }
  const hasAuthzReplay =
    subChange !== undefined ||
    planChange !== undefined ||
    pending.some(
      (c) =>
        c.kind === "authorization" && visibleGroupIds.includes(c.subjectId),
    );

  // --- Per-node replay --------------------------------------------------------
  const gatedNodes: ResolvedNode[] = [];
  const credentialsByNodeId = new Map<string, SubscriptionCredentials>();

  for (const resolved of nodes) {
    const serverId = resolved.server.id;

    // Server freshly (re)enabled: the applied agent state still has it off.
    const serverChange = find("server", serverId, serverId);
    if (
      serverChange?.prevRow &&
      (serverChange.prevRow as ServerChangePrevRow).enabled === false
    ) {
      continue;
    }

    // Newly visible nodes wait for the agent to materialize them.
    if (hasAuthzReplay && !appliedVisibleNodeIds.has(resolved.node.id)) {
      continue;
    }

    // Node-level replay to the applied snapshot.
    let emitted = resolved;
    const nodeChange = find("node", resolved.node.id, serverId);
    if (nodeChange) {
      if (!nodeChange.prevRow) {
        continue; // creation pending: no such node in the applied state
      }
      const prev = nodeChange.prevRow as NodeChangePrevRow;
      if (!prev.node.enabled) {
        continue; // enable pending: node was dark in the applied state
      }
      emitted = {
        node: prev.node,
        server: prev.server,
        address: prev.node.address ?? prev.server.address,
        certificateKind: prev.certificateKind,
      };
    }

    // Credential replay: creation pending means the user is absent from the
    // applied agent config on this server — the node is unusable either way.
    const credChange = find("credential", subscription.id, serverId);
    if (credChange) {
      if (!credChange.prevRow) {
        continue;
      }
      const prev = credChange.prevRow as CredentialChangePrevRow;
      credentialsByNodeId.set(emitted.node.id, {
        uuid: prev.credentialUuid,
        password: prev.credentialPassword,
      });
    }

    gatedNodes.push(emitted);
  }

  return { eligible, nodes: gatedNodes, credentialsByNodeId };
}
