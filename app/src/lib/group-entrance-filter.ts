import {
  type AgentStatusLike,
  deriveNodeHealth,
  type NodeHealth,
} from "@blossom/domain/agent-status";

import {
  splitMembershipColumns,
  type MembershipColumns,
} from "./group-membership-draft";

/**
 * Readiness and filtering for the group editor's available column.
 *
 * Readiness only restates the agent's last report:
 *  - withheld: the node or its server is disabled, so subscriptions drop it.
 *  - ready: the agent reports the node in its applied config (serving or
 *    serving a previous config).
 *  - pending: everything else that still exists, because no applied report
 *    confirms it.
 *
 * Publication is kept separate from readiness so the selected column can say
 * whether the member is currently applied without claiming client reachability.
 * Filters apply only to the available column; selected members never hide.
 */

export type EntranceReadiness = "ready" | "pending" | "withheld";

export type EntrancePublication =
  | "withheld"
  | "applied"
  | "pending"
  | "unconfirmed";

export interface EntranceStatusNode {
  id: string;
  enabled: boolean;
  protocol: string;
  name: string;
  serverSummary: AgentStatusLike & {
    id: string;
    name: string;
  };
}

export interface EntranceStatus {
  health: NodeHealth;
  readiness: EntranceReadiness;
  publication: EntrancePublication;
}

const WITHHELD_HEALTH: ReadonlySet<NodeHealth> = new Set([
  "disabled",
  "server_disabled",
]);

const APPLIED_HEALTH: ReadonlySet<NodeHealth> = new Set([
  "serving",
  "serving_stale",
]);

const UNCONFIRMED_HEALTH: ReadonlySet<NodeHealth> = new Set([
  "agent_offline",
  "runtime_error",
  "unknown",
]);

export function deriveEntranceStatus(
  node: EntranceStatusNode,
  now = Date.now(),
): EntranceStatus {
  const health = deriveNodeHealth(
    node.id,
    node.enabled,
    node.serverSummary,
    now,
  );
  if (WITHHELD_HEALTH.has(health)) {
    return { health, readiness: "withheld", publication: "withheld" };
  }
  if (APPLIED_HEALTH.has(health)) {
    return { health, readiness: "ready", publication: "applied" };
  }
  return {
    health,
    readiness: "pending",
    publication: UNCONFIRMED_HEALTH.has(health) ? "unconfirmed" : "pending",
  };
}

export interface EntranceFilter {
  /** Case-insensitive substring over the node name or its server name. */
  query?: string;
  protocol?: string;
  readiness?: EntranceReadiness;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function matchesQuery(node: EntranceStatusNode, query: string): boolean {
  const term = normalized(query);
  if (term.length === 0) return true;
  return (
    normalized(node.name).includes(term) ||
    normalized(node.serverSummary.name).includes(term)
  );
}

/** Protocols present in the full node list, sorted for a stable select. */
export function listEntranceProtocols(
  nodes: readonly Pick<EntranceStatusNode, "protocol">[],
): string[] {
  return [...new Set(nodes.map((node) => node.protocol))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * The available column: nodes not selected by the draft, narrowed by the
 * search, protocol and readiness filters. Selected IDs stay in the draft and
 * therefore never disappear from the selected column.
 */
export function filterAvailableEntrances<T extends EntranceStatusNode>(
  nodes: readonly T[],
  draft: readonly string[],
  filter: EntranceFilter,
  now = Date.now(),
): T[] {
  const selected = new Set(draft);
  return nodes.filter((node) => {
    if (selected.has(node.id)) return false;
    if (filter.protocol && node.protocol !== filter.protocol) return false;
    if (!matchesQuery(node, filter.query ?? "")) return false;
    if (filter.readiness) {
      const { readiness } = deriveEntranceStatus(node, now);
      if (readiness !== filter.readiness) return false;
    }
    return true;
  });
}

export interface MembershipDisplayColumns<
  T extends { id: string },
> extends MembershipColumns<T> {
  /** IDs exactly as the editor renders them, for dnd-kit `move`. */
  columnIds: {
    available: string[];
    selected: string[];
  };
}

/**
 * Resolves the displayed columns once. Drag handling feeds dnd-kit exactly
 * these IDs, so hidden available rows can never be reordered or resurrected by
 * a move event.
 */
export function membershipDisplayColumns<T extends EntranceStatusNode>(
  nodes: readonly T[],
  draft: readonly string[],
  filter: EntranceFilter,
  now = Date.now(),
): MembershipDisplayColumns<T> {
  const columns = splitMembershipColumns(nodes, draft);
  const available = filterAvailableEntrances(nodes, draft, filter, now);
  return {
    ...columns,
    available,
    columnIds: {
      available: available.map((node) => node.id),
      selected: columns.selected.map((entry) => entry.id),
    },
  };
}
