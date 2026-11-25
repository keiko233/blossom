/**
 * Presentation model for the Networking topology and its accessible list
 * equivalent (Task 09). Pure and client-safe: it takes already-loaded view
 * inputs and never reads the database, rollout tables or agent state.
 *
 * Handoff: the production loader maps managed persistence (Task 06) and
 * rollout/probe outcomes (Task 08) onto `TopologyInput`. `TopologyLinkPhase`
 * and `TopologyLinkHealth` are presentation states and are deliberately kept
 * independent, as the design tracks rollout progress apart from peer health.
 */
import type { PeerProtocol } from "@blossom/domain/managed-networking";

export const TOPOLOGY_LINK_PHASES = [
  "draft",
  "pending",
  "applying",
  "stalled",
  "failed",
  "applied",
  "removing",
] as const;
export type TopologyLinkPhase = (typeof TOPOLOGY_LINK_PHASES)[number];

export const TOPOLOGY_LINK_HEALTH = ["unknown", "healthy", "degraded"] as const;
export type TopologyLinkHealth = (typeof TOPOLOGY_LINK_HEALTH)[number];

export type TopologyTone = "info" | "warning" | "error" | "success" | "outline";

export interface TopologyServerInput {
  id: string;
  name: string;
  enabled: boolean;
}

export interface TopologyPeerInboundInput {
  id: string;
  serverId: string;
  name: string;
  protocol: PeerProtocol;
}

export interface TopologyLinkInput {
  id: string;
  sourceServerId: string;
  destinationInboundId: string;
  phase: TopologyLinkPhase;
  health: TopologyLinkHealth;
}

export interface TopologyInput {
  servers: readonly TopologyServerInput[];
  peerInbounds: readonly TopologyPeerInboundInput[];
  links: readonly TopologyLinkInput[];
}

export interface TopologyListLink {
  id: string;
  direction: "outgoing" | "incoming";
  /** The server at the other end of the link. */
  peerServerId: string;
  peerServerName: string;
  /** The destination peer inbound, on this or the peer server. */
  inboundName: string;
  protocol: PeerProtocol;
  phase: TopologyLinkPhase;
  health: TopologyLinkHealth;
}

export interface TopologyListServer {
  id: string;
  name: string;
  enabled: boolean;
  outgoing: TopologyListLink[];
  incoming: TopologyListLink[];
}

export interface TopologyList {
  servers: TopologyListServer[];
  /** Links whose source server or destination inbound is not in the input. */
  unresolvedLinkIds: string[];
}

export type TopologySelection =
  | { kind: "server"; id: string }
  | { kind: "link"; id: string };

const PHASE_TONE: Record<TopologyLinkPhase, TopologyTone> = {
  draft: "outline",
  pending: "info",
  applying: "info",
  stalled: "warning",
  failed: "error",
  applied: "success",
  removing: "info",
};

const HEALTH_TONE: Record<TopologyLinkHealth, TopologyTone> = {
  unknown: "outline",
  healthy: "success",
  degraded: "warning",
};

export function linkPhaseTone(phase: TopologyLinkPhase): TopologyTone {
  return PHASE_TONE[phase];
}

export function linkHealthTone(health: TopologyLinkHealth): TopologyTone {
  return HEALTH_TONE[health];
}

function compareByName(
  a: { name: string; id: string },
  b: { name: string; id: string },
): number {
  return (
    a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function compareLinks(a: TopologyListLink, b: TopologyListLink): number {
  return (
    compareByName(
      { name: a.peerServerName, id: a.peerServerId },
      { name: b.peerServerName, id: b.peerServerId },
    ) ||
    compareByName(
      { name: a.inboundName, id: a.id },
      { name: b.inboundName, id: b.id },
    )
  );
}

function matches(text: string, needle: string): boolean {
  return text.toLocaleLowerCase().includes(needle);
}

/**
 * Groups every server, including isolated ones, with its outgoing and incoming
 * links in a stable name order. A non-empty `query` keeps a server with all of
 * its links when its name matches, and otherwise keeps only the links whose
 * peer server or inbound name matches.
 */
export function buildTopologyList(
  input: TopologyInput,
  query = "",
): TopologyList {
  const serversById = new Map(input.servers.map((s) => [s.id, s]));
  const inboundsById = new Map(input.peerInbounds.map((i) => [i.id, i]));
  const outgoing = new Map<string, TopologyListLink[]>();
  const incoming = new Map<string, TopologyListLink[]>();
  const unresolvedLinkIds: string[] = [];

  for (const link of input.links) {
    const source = serversById.get(link.sourceServerId);
    const inbound = inboundsById.get(link.destinationInboundId);
    const destination = inbound && serversById.get(inbound.serverId);
    if (!source || !inbound || !destination) {
      unresolvedLinkIds.push(link.id);
      continue;
    }

    const shared = {
      id: link.id,
      inboundName: inbound.name,
      protocol: inbound.protocol,
      phase: link.phase,
      health: link.health,
    };
    const out = outgoing.get(source.id) ?? [];
    out.push({
      ...shared,
      direction: "outgoing",
      peerServerId: destination.id,
      peerServerName: destination.name,
    });
    outgoing.set(source.id, out);
    const into = incoming.get(destination.id) ?? [];
    into.push({
      ...shared,
      direction: "incoming",
      peerServerId: source.id,
      peerServerName: source.name,
    });
    incoming.set(destination.id, into);
  }

  const needle = query.trim().toLocaleLowerCase();
  const keepLink = (link: TopologyListLink) =>
    matches(link.peerServerName, needle) || matches(link.inboundName, needle);

  const servers: TopologyListServer[] = [];
  for (const server of [...input.servers].sort(compareByName)) {
    let serverOutgoing = (outgoing.get(server.id) ?? []).sort(compareLinks);
    let serverIncoming = (incoming.get(server.id) ?? []).sort(compareLinks);
    if (needle && !matches(server.name, needle)) {
      serverOutgoing = serverOutgoing.filter(keepLink);
      serverIncoming = serverIncoming.filter(keepLink);
      if (serverOutgoing.length === 0 && serverIncoming.length === 0) continue;
    }
    servers.push({
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      outgoing: serverOutgoing,
      incoming: serverIncoming,
    });
  }

  return { servers, unresolvedLinkIds: unresolvedLinkIds.sort() };
}

/**
 * Selection targets in visual list order: each server, then its outgoing
 * links. A link is selectable under its source server only; the destination
 * lists it as an incoming summary. Search keeps both ends symmetric, so a
 * visible link always has a visible source entry.
 */
export function topologySelectionOrder(
  servers: readonly TopologyListServer[],
): TopologySelection[] {
  return servers.flatMap((server): TopologySelection[] => [
    { kind: "server", id: server.id },
    ...server.outgoing.map((link) => ({ kind: "link" as const, id: link.id })),
  ]);
}

export function isSameSelection(
  a: TopologySelection | null,
  b: TopologySelection | null,
): boolean {
  return a?.kind === b?.kind && a?.id === b?.id;
}

/** Drops a selection that the current list (for example after search) hides. */
export function visibleSelection(
  servers: readonly TopologyListServer[],
  selection: TopologySelection | null,
): TopologySelection | null {
  if (!selection) return null;
  return topologySelectionOrder(servers).some((item) =>
    isSameSelection(item, selection),
  )
    ? selection
    : null;
}

export type TopologyMove = "next" | "previous" | "first" | "last";

/** Roving-selection step for keyboard navigation; clamps at both ends. */
export function moveTopologySelection(
  servers: readonly TopologyListServer[],
  current: TopologySelection | null,
  move: TopologyMove,
): TopologySelection | null {
  const order = topologySelectionOrder(servers);
  if (order.length === 0) return null;
  if (move === "first") return order[0];
  if (move === "last") return order[order.length - 1];

  const index = order.findIndex((item) => isSameSelection(item, current));
  if (index === -1) return move === "next" ? order[0] : order[order.length - 1];
  const nextIndex = move === "next" ? index + 1 : index - 1;
  return order[Math.min(Math.max(nextIndex, 0), order.length - 1)];
}

/* ------------------------------------------------------------------------- */
/* Interactive graph model                                                    */
/* ------------------------------------------------------------------------- */

export type EdgeTone = "success" | "info" | "warning" | "danger" | "muted";
export type EdgeDash = "solid" | "dashed" | "dotted";
export type TopologyNodeTone = "success" | "warning" | "danger" | "muted";

export interface LinkEdgeStyle {
  tone: EdgeTone;
  dash: EdgeDash;
  width: 1.5 | 2;
  /** In-flight work only: applying and removing. */
  animated: boolean;
}

/**
 * Single source of truth for edge appearance, shared by the edge component,
 * the legend and the tests. Phase wins over health: health only refines a
 * settled (`applied`) link.
 */
export function linkEdgeStyle(
  phase: TopologyLinkPhase,
  health: TopologyLinkHealth,
): LinkEdgeStyle {
  switch (phase) {
    case "failed":
      return { tone: "danger", dash: "solid", width: 2, animated: false };
    case "stalled":
      return { tone: "warning", dash: "dashed", width: 1.5, animated: false };
    case "applied":
      if (health === "degraded") {
        return { tone: "warning", dash: "solid", width: 2, animated: false };
      }
      if (health === "healthy") {
        return { tone: "success", dash: "solid", width: 1.5, animated: false };
      }
      return { tone: "muted", dash: "solid", width: 1.5, animated: false };
    case "pending":
      return { tone: "info", dash: "dashed", width: 1.5, animated: false };
    case "applying":
      return { tone: "info", dash: "dashed", width: 1.5, animated: true };
    case "removing":
      return { tone: "muted", dash: "dashed", width: 1.5, animated: true };
    case "draft":
      return { tone: "muted", dash: "dotted", width: 1.5, animated: false };
  }
}

export interface TopologyEdgeLegendEntry {
  key: string;
  style: LinkEdgeStyle;
}

/** Every distinct edge style the graph can render, in legend order. */
export const TOPOLOGY_EDGE_LEGEND: readonly TopologyEdgeLegendEntry[] = [
  { key: "applied_healthy", style: linkEdgeStyle("applied", "healthy") },
  { key: "applied_unknown", style: linkEdgeStyle("applied", "unknown") },
  { key: "degraded", style: linkEdgeStyle("applied", "degraded") },
  { key: "pending", style: linkEdgeStyle("pending", "unknown") },
  { key: "applying", style: linkEdgeStyle("applying", "unknown") },
  { key: "stalled", style: linkEdgeStyle("stalled", "unknown") },
  { key: "failed", style: linkEdgeStyle("failed", "unknown") },
  { key: "draft", style: linkEdgeStyle("draft", "unknown") },
  { key: "removing", style: linkEdgeStyle("removing", "unknown") },
];

export type TopologyGraphNodeData = {
  serverId: string;
  name: string;
  enabled: boolean;
  tone: TopologyNodeTone;
  incoming: number;
  outgoing: number;
  selected: boolean;
  dimmed: boolean;
};

export type TopologyGraphEdgeData = {
  linkId: string;
  protocol: PeerProtocol;
  style: LinkEdgeStyle;
  phase: TopologyLinkPhase;
  health: TopologyLinkHealth;
  sourceServerName: string;
  destinationServerName: string;
  destinationInboundName: string;
  selected: boolean;
  dimmed: boolean;
  parallelIndex: number;
  parallelCount: number;
};

export interface TopologyGraphNode {
  id: string;
  data: TopologyGraphNodeData;
}

export interface TopologyGraphEdge {
  id: string;
  source: string;
  target: string;
  data: TopologyGraphEdgeData;
}

export interface TopologyGraph {
  nodes: TopologyGraphNode[];
  edges: TopologyGraphEdge[];
}

export interface TopologyRuntimeState {
  runtimeState: string;
  configState: string;
}

/**
 * Server ids a search query keeps. `null` means "no query": nothing is
 * dimmed. A server matches by its own name, or because one of its links
 * matches by peer server or inbound name, so both ends of a matching link stay
 * lit.
 */
export function matchedServerIds(
  list: TopologyList,
  query: string,
): ReadonlySet<string> | null {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return null;

  const matched = new Set<string>();
  for (const server of list.servers) {
    if (server.name.toLocaleLowerCase().includes(needle)) {
      matched.add(server.id);
      continue;
    }
    const linkMatches = (link: TopologyListLink) =>
      link.peerServerName.toLocaleLowerCase().includes(needle) ||
      link.inboundName.toLocaleLowerCase().includes(needle);
    if (
      server.outgoing.some(linkMatches) ||
      server.incoming.some(linkMatches)
    ) {
      matched.add(server.id);
    }
  }
  return matched;
}

function nodeTone(
  enabled: boolean,
  runtime: TopologyRuntimeState | undefined,
): TopologyNodeTone {
  if (!enabled) return "muted";
  if (!runtime) return "success";
  if (RUNTIME_ERROR_STATES.has(runtime.runtimeState)) return "danger";
  if (CONFIG_ERROR_STATES.has(runtime.configState)) return "danger";
  if (
    runtime.runtimeState === "unknown" ||
    runtime.runtimeState === "starting" ||
    runtime.configState === "unknown"
  ) {
    return "warning";
  }
  // Values from a newer agent are unknown, not healthy.
  return RUNTIME_OK_STATES.has(runtime.runtimeState) &&
    CONFIG_OK_STATES.has(runtime.configState)
    ? "success"
    : "muted";
}

const RUNTIME_ERROR_STATES: ReadonlySet<string> = new Set([
  "stopped",
  "crash_loop",
]);
const CONFIG_ERROR_STATES: ReadonlySet<string> = new Set([
  "rejected",
  "apply_failed",
]);
const RUNTIME_OK_STATES: ReadonlySet<string> = new Set(["running"]);
const CONFIG_OK_STATES: ReadonlySet<string> = new Set(["applied"]);

/**
 * Turns the list model into a node/edge graph. Only resolved links become
 * edges (`list` already contains them); links that share an ordered server
 * pair get `parallelIndex`/`parallelCount` so the edge component can fan them
 * out.
 */
export function buildTopologyGraph(
  input: TopologyInput,
  list: TopologyList,
  selection: TopologySelection | null,
  matched: ReadonlySet<string> | null,
  runtime?: ReadonlyMap<string, TopologyRuntimeState>,
): TopologyGraph {
  const isSelected = (kind: "server" | "link", id: string) =>
    selection?.kind === kind && selection.id === id;
  const isDimmed = (id: string) => matched !== null && !matched.has(id);

  const nodes: TopologyGraphNode[] = list.servers.map((server) => ({
    id: server.id,
    data: {
      serverId: server.id,
      name: server.name,
      enabled: server.enabled,
      tone: nodeTone(server.enabled, runtime?.get(server.id)),
      incoming: server.incoming.length,
      outgoing: server.outgoing.length,
      selected: isSelected("server", server.id),
      dimmed: isDimmed(server.id),
    },
  }));

  const inboundById = new Map(
    input.peerInbounds.map((inbound) => [inbound.id, inbound]),
  );
  const serverNameById = new Map(
    input.servers.map((server) => [server.id, server.name]),
  );

  const pairCounts = new Map<string, number>();
  for (const link of input.links) {
    const inbound = inboundById.get(link.destinationInboundId);
    const destinationServerId = inbound?.serverId;
    if (!destinationServerId) continue;
    if (!serverNameById.has(link.sourceServerId)) continue;
    const key = `${link.sourceServerId}\u0000${destinationServerId}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  const pairSeen = new Map<string, number>();
  const orderedLinks = [...input.links].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const edges: TopologyGraphEdge[] = [];
  for (const link of orderedLinks) {
    const inbound = inboundById.get(link.destinationInboundId);
    if (!inbound) continue;
    const destinationServerId = inbound.serverId;
    const sourceName = serverNameById.get(link.sourceServerId);
    const destinationName = serverNameById.get(destinationServerId);
    if (!sourceName || !destinationName) continue;

    const key = `${link.sourceServerId}\u0000${destinationServerId}`;
    const parallelIndex = pairSeen.get(key) ?? 0;
    pairSeen.set(key, parallelIndex + 1);
    const sourceMatches = matched === null || matched.has(link.sourceServerId);
    const destinationMatches =
      matched === null || matched.has(destinationServerId);

    edges.push({
      id: link.id,
      source: link.sourceServerId,
      target: destinationServerId,
      data: {
        linkId: link.id,
        protocol: inbound.protocol,
        style: linkEdgeStyle(link.phase, link.health),
        phase: link.phase,
        health: link.health,
        sourceServerName: sourceName,
        destinationServerName: destinationName,
        destinationInboundName: inbound.name,
        selected: isSelected("link", link.id),
        dimmed: !sourceMatches && !destinationMatches,
        parallelIndex,
        parallelCount: pairCounts.get(key) ?? 1,
      },
    });
  }

  return { nodes, edges };
}
