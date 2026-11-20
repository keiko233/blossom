/**
 * Client-safe presentation and planning model for the Networking workspace
 * (Task 09). It consumes loaded rows and draft values only: no database, agent
 * transport, rollout writer or credential material. The server's stage planner
 * and the editor preview share these functions so the screen never claims an
 * ordering the compiler would not emit.
 */
import type { ManagedIntentRouteRule } from "@blossom/contracts/agent-config-v3";
import type {
  ManageableOutboundIpFamily,
  PeerProtocol,
} from "@blossom/domain/managed-networking";

import type { NetworkingIssue } from "./networking-schema";

export type RoutingNetwork = "tcp" | "udp";
export type RoutingAction = "route" | "reject";
export type RoutingOutboundKind =
  | "builtin_direct"
  | "direct_profile"
  | "peer_link";

export interface RoutingInboundOption {
  tag: string;
  name: string;
  protocol: string;
  /** Peer listeners are excluded from subscriber exports and groups. */
  peer: boolean;
  enabled: boolean;
}

export interface RoutingOutboundOption {
  tag: string;
  name: string;
  kind: RoutingOutboundKind;
  linkId: string | null;
  destinationServerId: string | null;
  destinationServerName: string | null;
  protocol: PeerProtocol | null;
  ipFamily: ManageableOutboundIpFamily | null;
}

export interface RoutingRuleSetOption {
  runtimeTag: string;
  ruleSetId: string;
  version: string;
  format: "binary";
  sizeBytes: number;
}

export interface RoutingMatchSummary {
  domains: string[];
  domainSuffixes: string[];
  domainKeywords: string[];
  ipCidrs: string[];
  ports: number[];
  ruleSetTags: string[];
}

export interface RoutingPreviewAction {
  /** Stable React/table key, unique within one preview. */
  key: string;
  ruleId: string | null;
  action: "sniff" | "resolve" | "route" | "reject";
  inboundTags: string[];
  network: RoutingNetwork | null;
  outboundTag: string | null;
  match: RoutingMatchSummary;
  origin: "rule" | "peer_default_reject" | "fallback";
  /** A compiler-generated companion action, localized by the UI. */
  note: "peer_udp_reject" | "peer_default_reject" | "final_fallback" | null;
}

export interface RoutingPreview {
  actions: RoutingPreviewAction[];
  fallbackOutboundTag: string;
  affectedInboundTags: string[];
  peerOutboundTags: string[];
  ruleSetTags: string[];
  /** Rules that survive the compiler's inbound-scope intersection. */
  effectiveRuleIds: string[];
  issues: NetworkingIssue[];
}

function emptyMatch(): RoutingMatchSummary {
  return {
    domains: [],
    domainSuffixes: [],
    domainKeywords: [],
    ipCidrs: [],
    ports: [],
    ruleSetTags: [],
  };
}

function matchSummary(rule: ManagedIntentRouteRule): RoutingMatchSummary {
  return {
    domains: [...rule.domains],
    domainSuffixes: [...rule.domainSuffixes],
    domainKeywords: [...rule.domainKeywords],
    ipCidrs: [...rule.ipCidrs],
    ports: [...rule.ports],
    ruleSetTags: [...rule.ruleSetTags],
  };
}

function hasMatch(match: RoutingMatchSummary): boolean {
  return (
    match.domains.length > 0 ||
    match.domainSuffixes.length > 0 ||
    match.domainKeywords.length > 0 ||
    match.ipCidrs.length > 0 ||
    match.ports.length > 0 ||
    match.ruleSetTags.length > 0
  );
}

function ruleMatchSummary(rule: ManagedIntentRouteRule): RoutingMatchSummary {
  return matchSummary(rule);
}

function ruleHasVertex(rule: ManagedIntentRouteRule): boolean {
  return (
    hasMatch(ruleMatchSummary(rule)) ||
    rule.sniff ||
    rule.resolveStrategy !== null
  );
}

function ruleSignature(rule: ManagedIntentRouteRule): string {
  return JSON.stringify({
    action: rule.action,
    inboundTags: [...rule.inboundTags].sort(),
    sniff: rule.sniff,
    resolveStrategy: rule.resolveStrategy,
    network: rule.network,
    domains: [...rule.domains].sort(),
    domainSuffixes: [...rule.domainSuffixes].sort(),
    domainKeywords: [...rule.domainKeywords].sort(),
    ipCidrs: [...rule.ipCidrs].sort(),
    ports: [...rule.ports].sort((a, b) => a - b),
    ruleSetTags: [...rule.ruleSetTags].sort(),
    outboundTag: rule.outboundTag,
  });
}

/**
 * Renders the rules the managed compiler will emit for one server: ingress
 * scoped sniff/resolve actions first, terminal route/reject matches, the
 * compiler-generated UDP reject that keeps a peer catch-all TCP-only, the
 * peer-inbound default reject, then the server fallback.
 */
export function buildRoutingPreview(input: {
  rules: readonly ManagedIntentRouteRule[];
  finalOutboundTag: string;
  inbounds: readonly RoutingInboundOption[];
  outbounds: readonly RoutingOutboundOption[];
  ruleSets: readonly RoutingRuleSetOption[];
}): RoutingPreview {
  const inboundTags = new Set(input.inbounds.map((inbound) => inbound.tag));
  const outboundTags = new Set(input.outbounds.map((outbound) => outbound.tag));
  const ruleSetTags = new Set(
    input.ruleSets.map((ruleSet) => ruleSet.runtimeTag),
  );
  const issues: NetworkingIssue[] = [];
  const actions: RoutingPreviewAction[] = [];
  const effectiveRuleIds: string[] = [];
  const affected = new Set<string>();
  const peerTags = new Set<string>();
  const usedRuleSets = new Set<string>();
  let keyIndex = 0;

  const addIssue = (issue: NetworkingIssue) => issues.push(issue);
  const nextKey = (prefix: string) => `${prefix}-${keyIndex++}`;

  for (const rule of input.rules) {
    const knownInboundTags = rule.inboundTags.filter((tag) =>
      inboundTags.has(tag),
    );
    for (const tag of rule.inboundTags) {
      if (!inboundTags.has(tag)) {
        addIssue({ code: "inbound_not_found", params: { tag } });
      }
    }
    if (knownInboundTags.length === 0) {
      addIssue({ code: "empty_rule_scope", subjectId: rule.ruleId });
      continue;
    }
    for (const tag of rule.ruleSetTags) {
      if (!ruleSetTags.has(tag)) {
        addIssue({ code: "unknown_rule_set", params: { tag } });
      } else {
        usedRuleSets.add(tag);
      }
    }
    if (
      rule.action === "route" &&
      rule.outboundTag !== null &&
      !outboundTags.has(rule.outboundTag)
    ) {
      addIssue({
        code: "outbound_not_found",
        params: { tag: rule.outboundTag },
      });
    }
    if (
      rule.ipCidrs.length > 0 &&
      (rule.domains.length > 0 ||
        rule.domainSuffixes.length > 0 ||
        rule.domainKeywords.length > 0) &&
      rule.resolveStrategy === null
    ) {
      addIssue({ code: "unresolved_destination_ip" });
    }

    effectiveRuleIds.push(rule.ruleId);
    for (const tag of knownInboundTags) affected.add(tag);
    const match = matchSummary(rule);
    const base = {
      ruleId: rule.ruleId,
      inboundTags: knownInboundTags,
      match,
      origin: "rule" as const,
    };

    if (rule.sniff) {
      actions.push({
        ...base,
        key: nextKey("sniff"),
        action: "sniff",
        network: rule.network,
        outboundTag: null,
        note: null,
      });
    }
    if (rule.resolveStrategy !== null) {
      actions.push({
        ...base,
        key: nextKey("resolve"),
        action: "resolve",
        network: rule.network,
        outboundTag: null,
        note: null,
      });
    }

    if (rule.action === "reject") {
      actions.push({
        ...base,
        key: nextKey("reject"),
        action: "reject",
        network: rule.network,
        outboundTag: null,
        note: null,
      });
      continue;
    }

    const outboundTag = rule.outboundTag;
    if (outboundTag === null || !outboundTags.has(outboundTag)) continue;

    if (outboundTag.startsWith("peer-out-")) {
      peerTags.add(outboundTag);
      if (rule.network === "udp") {
        addIssue({ code: "udp_peer_route", subjectId: rule.ruleId });
        continue;
      }
      actions.push({
        ...base,
        key: nextKey("peer-tcp"),
        action: "route",
        network: "tcp",
        outboundTag,
        note: null,
      });
      if (rule.network === null) {
        actions.push({
          ...base,
          key: nextKey("peer-udp-reject"),
          action: "reject",
          network: "udp",
          outboundTag: null,
          note: "peer_udp_reject",
        });
      }
      continue;
    }

    actions.push({
      ...base,
      key: nextKey("route"),
      action: "route",
      network: rule.network,
      outboundTag,
      note: null,
    });
  }

  for (const inbound of input.inbounds) {
    if (!inbound.peer) continue;
    actions.push({
      key: nextKey("peer-default"),
      ruleId: null,
      action: "reject",
      inboundTags: [inbound.tag],
      network: null,
      outboundTag: null,
      match: emptyMatch(),
      origin: "peer_default_reject",
      note: "peer_default_reject",
    });
  }

  if (!outboundTags.has(input.finalOutboundTag)) {
    addIssue({
      code: "unknown_final_outbound",
      params: { tag: input.finalOutboundTag },
    });
  } else if (input.finalOutboundTag.startsWith("peer-out-")) {
    addIssue({ code: "final_outbound_is_peer" });
  }
  actions.push({
    key: nextKey("fallback"),
    ruleId: null,
    action: "route",
    inboundTags: [...inboundTags],
    network: null,
    outboundTag: input.finalOutboundTag,
    match: emptyMatch(),
    origin: "fallback",
    note: "final_fallback",
  });

  // A terminal catch-all for one ingress shadows every later terminal rule for
  // that same ingress. Sniff/resolve-only rows do not shadow by themselves.
  const catchAll = new Map<string, string>();
  for (const rule of input.rules) {
    if (!ruleHasVertex(rule)) {
      for (const tag of rule.inboundTags) {
        if (!catchAll.has(tag)) catchAll.set(tag, rule.ruleId);
      }
      continue;
    }
    for (const tag of rule.inboundTags) {
      const earlier = catchAll.get(tag);
      if (earlier) {
        addIssue({
          code: "shadowed_rule",
          params: { rule: rule.ruleId, earlier },
          subjectId: rule.ruleId,
        });
        break;
      }
    }
    // A rule with terminal action but no match fields is itself a catch-all
    // only when its terminal action is reached; sniff/resolve-only rows are not.
    if (!hasMatch(ruleMatchSummary(rule))) {
      for (const tag of rule.inboundTags) {
        if (!catchAll.has(tag)) catchAll.set(tag, rule.ruleId);
      }
    }
  }

  return {
    actions,
    fallbackOutboundTag: input.finalOutboundTag,
    affectedInboundTags: [...affected].sort(),
    peerOutboundTags: [...peerTags].sort(),
    ruleSetTags: [...usedRuleSets].sort(),
    effectiveRuleIds,
    issues,
  };
}

export interface RoutingDiff {
  addedRuleIds: string[];
  removedRuleIds: string[];
  changedRuleIds: string[];
  reordered: boolean;
  finalOutboundChanged: boolean;
  previousFinalOutboundTag: string;
  nextFinalOutboundTag: string;
  affectedInboundTagsAdded: string[];
  affectedInboundTagsRemoved: string[];
  peerOutboundTagsAdded: string[];
  peerOutboundTagsRemoved: string[];
}

export interface RoutingDraftSnapshot {
  finalOutboundTag: string;
  rules: readonly ManagedIntentRouteRule[];
}

function ruleFingerprint(rule: ManagedIntentRouteRule): string {
  return ruleSignature(rule);
}

/** Redacted, identifier-only diff between the saved draft and this preview. */
export function diffRoutingDrafts(
  previous: RoutingDraftSnapshot | null,
  next: RoutingDraftSnapshot,
): RoutingDiff {
  const previousRules = previous?.rules ?? [];
  const previousById = new Map(
    previousRules.map((rule) => [rule.ruleId, rule]),
  );
  const nextById = new Map(next.rules.map((rule) => [rule.ruleId, rule]));
  const addedRuleIds = next.rules
    .filter((rule) => !previousById.has(rule.ruleId))
    .map((rule) => rule.ruleId);
  const removedRuleIds = previousRules
    .filter((rule) => !nextById.has(rule.ruleId))
    .map((rule) => rule.ruleId);
  const changedRuleIds = next.rules
    .filter((rule) => {
      const before = previousById.get(rule.ruleId);
      return before && ruleFingerprint(before) !== ruleFingerprint(rule);
    })
    .map((rule) => rule.ruleId);
  const previousOrder = previousRules.map((rule) => rule.ruleId);
  const nextOrder = next.rules.map((rule) => rule.ruleId);
  const common = new Set(previousOrder.filter((id) => nextById.has(id)));
  const previousCommon = previousOrder.filter((id) => common.has(id));
  const nextCommon = nextOrder.filter((id) => common.has(id));
  const reordered =
    previousCommon.length > 1 &&
    previousCommon.some((id, index) => nextCommon[index] !== id);

  const previousInbounds = new Set(
    previousRules.flatMap((rule) => rule.inboundTags),
  );
  const nextInbounds = new Set(next.rules.flatMap((rule) => rule.inboundTags));
  const previousPeers = new Set(
    previousRules
      .filter((rule) => rule.action === "route")
      .map((rule) => rule.outboundTag)
      .filter(
        (tag): tag is string => tag !== null && tag.startsWith("peer-out-"),
      ),
  );
  const nextPeers = new Set(
    next.rules
      .filter((rule) => rule.action === "route")
      .map((rule) => rule.outboundTag)
      .filter(
        (tag): tag is string => tag !== null && tag.startsWith("peer-out-"),
      ),
  );

  return {
    addedRuleIds,
    removedRuleIds,
    changedRuleIds,
    reordered,
    finalOutboundChanged:
      previous?.finalOutboundTag !== undefined &&
      previous.finalOutboundTag !== next.finalOutboundTag,
    previousFinalOutboundTag: previous?.finalOutboundTag ?? "direct",
    nextFinalOutboundTag: next.finalOutboundTag,
    affectedInboundTagsAdded: [...nextInbounds]
      .filter((tag) => !previousInbounds.has(tag))
      .sort(),
    affectedInboundTagsRemoved: [...previousInbounds]
      .filter((tag) => !nextInbounds.has(tag))
      .sort(),
    peerOutboundTagsAdded: [...nextPeers]
      .filter((tag) => !previousPeers.has(tag))
      .sort(),
    peerOutboundTagsRemoved: [...previousPeers]
      .filter((tag) => !nextPeers.has(tag))
      .sort(),
  };
}

export type RolloutDirection = "apply" | "remove";
export type PlannedStageRole = "receiver" | "sender" | "routing";

export interface PlanLinkEdge {
  id: string;
  sourceServerId: string;
  destinationServerId: string;
}

export interface PlannedStage {
  ordinal: number;
  serverId: string;
  roles: PlannedStageRole[];
  probeLinkIds: string[];
  dependsOnServerIds: string[];
}

export interface RolloutStagePlan {
  ok: boolean;
  direction: RolloutDirection;
  stages: PlannedStage[];
  /** Servers left outside the order because of a managed forwarding cycle. */
  cycleServerIds: string[];
}

/**
 * Receiver-first ordering for a managed change and source-first ordering for a
 * removal. Edges only cover links whose two servers are both being changed;
 * stable server id ordering breaks ties and reports cycles instead of silently
 * emitting an unsafe order.
 */
export function planManagedRolloutStages(input: {
  serverIds: readonly string[];
  links: readonly PlanLinkEdge[];
  direction: RolloutDirection;
  /** Restrict dependency edges to these links (for routing-only previews). */
  linkIds?: readonly string[];
}): RolloutStagePlan {
  const selected = new Set(input.serverIds);
  const linkIds = input.linkIds ? new Set(input.linkIds) : null;
  const activeLinks = input.links.filter(
    (link) =>
      selected.has(link.sourceServerId) &&
      selected.has(link.destinationServerId) &&
      (linkIds === null || linkIds.has(link.id)),
  );
  const prerequisites = new Map<string, Set<string>>();
  const allServers = new Set<string>();
  const linksBySource = new Map<string, string[]>();
  const linksByDestination = new Map<string, string[]>();
  for (const serverId of selected) {
    prerequisites.set(serverId, new Set());
    allServers.add(serverId);
  }
  for (const link of activeLinks) {
    const before =
      input.direction === "apply"
        ? link.destinationServerId
        : link.sourceServerId;
    const after =
      input.direction === "apply"
        ? link.sourceServerId
        : link.destinationServerId;
    prerequisites.get(after)?.add(before);
    const sourceLinks = linksBySource.get(link.sourceServerId) ?? [];
    sourceLinks.push(link.id);
    linksBySource.set(link.sourceServerId, sourceLinks);
    const destinationLinks =
      linksByDestination.get(link.destinationServerId) ?? [];
    destinationLinks.push(link.id);
    linksByDestination.set(link.destinationServerId, destinationLinks);
  }

  const ordered: string[] = [];
  const placed = new Set<string>();
  while (placed.size < allServers.size) {
    const ready = [...allServers]
      .filter((serverId) => !placed.has(serverId))
      .filter((serverId) =>
        [...(prerequisites.get(serverId) ?? [])].every((before) =>
          placed.has(before),
        ),
      )
      .sort();
    if (ready.length === 0) break;
    for (const serverId of ready) {
      placed.add(serverId);
      ordered.push(serverId);
    }
  }

  const cycleServerIds = [...allServers]
    .filter((serverId) => !placed.has(serverId))
    .sort();
  if (cycleServerIds.length > 0) {
    return {
      ok: false,
      direction: input.direction,
      stages: [],
      cycleServerIds,
    };
  }

  const stages = ordered.map((serverId, index): PlannedStage => {
    const incoming = linksByDestination.get(serverId) ?? [];
    const outgoing = linksBySource.get(serverId) ?? [];
    const roles: PlannedStageRole[] = [];
    if (incoming.length > 0) roles.push("receiver");
    if (outgoing.length > 0) roles.push("sender");
    if (roles.length === 0) roles.push("routing");
    const dependsOn = new Set<string>();
    for (const linkId of incoming) {
      const link = activeLinks.find((candidate) => candidate.id === linkId);
      const before =
        input.direction === "apply"
          ? link?.destinationServerId
          : link?.sourceServerId;
      if (before && before !== serverId) dependsOn.add(before);
    }
    for (const linkId of outgoing) {
      const link = activeLinks.find((candidate) => candidate.id === linkId);
      const before =
        input.direction === "apply"
          ? link?.destinationServerId
          : link?.sourceServerId;
      if (before && before !== serverId) dependsOn.add(before);
    }
    return {
      ordinal: index + 1,
      serverId,
      roles,
      probeLinkIds: outgoing.sort(),
      dependsOnServerIds: [...dependsOn].sort(),
    };
  });

  return {
    ok: true,
    direction: input.direction,
    stages,
    cycleServerIds: [],
  };
}

export interface ManagedRuleSetPreset {
  id: string;
  nameKey:
    | "admin_networking_preset_geoip_cn"
    | "admin_networking_preset_geosite_cn"
    | "admin_networking_preset_geoip_private"
    | "admin_networking_preset_geosite_private";
  suggestedVersion: string;
  source: string;
  descriptionKey:
    | "admin_networking_preset_geoip_cn_description"
    | "admin_networking_preset_geosite_cn_description"
    | "admin_networking_preset_geoip_private_description"
    | "admin_networking_preset_geosite_private_description";
}

/**
 * Curated rule-set presets are metadata, not remote downloads. An operator
 * attaches the exact pinned binary asset; the server records its SHA-256 and
 * rejects URLs, paths and over-budget content.
 */
export const MANAGED_RULE_SET_PRESET_CATALOG: readonly ManagedRuleSetPreset[] =
  [
    {
      id: "geoip-cn",
      nameKey: "admin_networking_preset_geoip_cn",
      suggestedVersion: "2026.11.20",
      source: "curated/geoip/cn",
      descriptionKey: "admin_networking_preset_geoip_cn_description",
    },
    {
      id: "geosite-cn",
      nameKey: "admin_networking_preset_geosite_cn",
      suggestedVersion: "2026.11.20",
      source: "curated/geosite/cn",
      descriptionKey: "admin_networking_preset_geosite_cn_description",
    },
    {
      id: "geoip-private",
      nameKey: "admin_networking_preset_geoip_private",
      suggestedVersion: "2026.11.20",
      source: "curated/geoip/private",
      descriptionKey: "admin_networking_preset_geoip_private_description",
    },
    {
      id: "geosite-private",
      nameKey: "admin_networking_preset_geosite_private",
      suggestedVersion: "2026.11.20",
      source: "curated/geosite/private",
      descriptionKey: "admin_networking_preset_geosite_private_description",
    },
  ];

export interface OutboundRouteReference {
  ruleId: string;
  inboundTags: string[];
}

/**
 * Route rules that reference a named or peer outbound. Used by the Outbounds
 * view to show dependent rules before an edit or delete.
 */
export function outboundRouteReferences(
  rules: readonly ManagedIntentRouteRule[],
): Map<string, OutboundRouteReference[]> {
  const references = new Map<string, OutboundRouteReference[]>();
  for (const rule of rules) {
    if (rule.action !== "route" || rule.outboundTag === null) continue;
    const rows = references.get(rule.outboundTag) ?? [];
    rows.push({ ruleId: rule.ruleId, inboundTags: [...rule.inboundTags] });
    references.set(rule.outboundTag, rows);
  }
  return references;
}

export interface RoutingEditorIssueInput {
  code: string;
  params?: Record<string, string | number>;
  subjectId?: string;
}

/**
 * Converts compiler/preview issues into the editor's stable code shape. Unknown
 * codes are returned as `unknown_final_outbound` only when they describe an
 * outbound; otherwise callers keep the localized generic message.
 */
export function issueParams(issue: NetworkingIssue): Record<string, string> {
  return Object.fromEntries(
    Object.entries(issue.params ?? {}).map(([key, value]) => [
      key,
      String(value),
    ]),
  );
}
