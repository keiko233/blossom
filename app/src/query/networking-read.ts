import {
  MANAGED_STAGE_INTENT_SCHEMA_VERSION,
  managedStageIntentSchema,
  type ManagedIntentOutbound,
  type ManagedIntentPeerInbound,
  type ManagedIntentRouteRule,
  type ManagedRuleSetBinding,
  type ManagedStageIntent,
} from "@blossom/contracts/agent-config-v3";
import {
  MANAGED_TOPOLOGY_ID,
  managedRuntimeTag,
  peerProtocolCapability,
  type ManagedOutboundKind,
  type PeerProtocol,
} from "@blossom/domain/managed-networking";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { Database } from "@/db";
import { db } from "@/db";
import {
  managedConfigVersion,
  managedRuleSetAsset,
  managedServerState,
  managedTopology,
  peerInbound,
  peerLink,
  peerLinkCredential,
  managedOutbound,
} from "@/db/managed-network-schema";
import {
  certificateMaterial,
  managedCertificate,
  node,
  server,
} from "@/db/proxy-schema";
import type { NetworkingIssue } from "@/lib/networking-schema";
import {
  buildRoutingPreview,
  outboundRouteReferences,
  type RoutingInboundOption,
  type RoutingOutboundOption,
  type RoutingPreview,
  type RoutingRuleSetOption,
} from "@/lib/networking-workspace";
import type { JsonValue } from "@/orpc/proxy/schema";
import {
  computeManagedStageIntentDigest,
  computeManagedStateFingerprint,
  canonicalize,
} from "@/orpc/proxy/singbox";
import {
  listManagedRolloutDetails,
  listManagedLinkProbes,
  readManagedRolloutSnapshot,
  type ManagedRolloutDetail,
} from "@/query/managed-rollout-write";
import { loadServerPortForwards } from "@/query/port-forward-store";

/**
 * Read model for the Networking workspace (Task 09). It only reads managed
 * persistence and compiles in-memory stage intents; it never claims a server,
 * advances a pointer or talks to an agent. Writers live in `networking-write.ts`
 * and the admin server functions in `networking.ts`.
 */

export interface NetworkingServerView {
  id: string;
  name: string;
  address: string;
  enabled: boolean;
  lastSeenAt: Date | null;
  runtimeState: string;
  configState: string;
  appliedRevision: string | null;
  desiredRevisionSeq: number;
  appliedRevisionSeq: number;
  desiredConfigVersionId: string | null;
  appliedConfigVersionId: string | null;
  desiredManagedFingerprint: string | null;
}

export interface NetworkingNodeView {
  id: string;
  serverId: string;
  name: string;
  enabled: boolean;
  protocol: string;
  listenPort: number;
  certificateId: string | null;
  tlsServerName: string | null;
  settings: Record<string, JsonValue>;
}

export interface NetworkingPeerInboundView {
  id: string;
  serverId: string;
  name: string;
  runtimeTag: string;
  protocol: PeerProtocol;
  listenAddress: string;
  listenPort: number;
  advertisedAddress: string;
  advertisedPort: number;
  network: "tcp" | "udp" | "both";
  tlsServerName: string | null;
  certificateId: string | null;
  certificateName: string | null;
  certificateKind: string | null;
  certificateGeneration: number | null;
  certificateFingerprint: string | null;
  settings: Record<string, JsonValue>;
  sourceNodeId: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  linkIds: string[];
}

export interface NetworkingLinkView {
  id: string;
  sourceServerId: string;
  sourceServerName: string;
  destinationInboundId: string;
  destinationInboundName: string;
  destinationServerId: string;
  destinationServerName: string;
  protocol: PeerProtocol;
  revision: number;
  outboundId: string;
  outboundName: string;
  outboundTag: string;
  credentialGeneration: number | null;
  credentialRevision: number;
  phase:
    | "draft"
    | "pending"
    | "applying"
    | "stalled"
    | "failed"
    | "applied"
    | "removing";
  health: "unknown" | "healthy" | "degraded";
  routeRuleIds: string[];
  /** Latest authenticated probe outcome; bounded, never endpoint material. */
  probeOutcome: string | null;
  probeAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NetworkingOutboundView {
  id: string | null;
  serverId: string;
  kind: ManagedOutboundKind | "builtin_direct";
  name: string;
  runtimeTag: string;
  linkId: string | null;
  protocol?: string | null;
  settings?: Record<string, JsonValue>;
  memberOutboundTags?: string[];
  revision: number;
  ipFamily: string | null;
  bindInterface: string | null;
  routeRuleIds: string[];
}

export interface NetworkingRuleSetAssetView {
  ruleSetId: string;
  version: string;
  format: "binary";
  source: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
  usedByServerIds: string[];
}

export interface NetworkingRoutingDraftView {
  configVersionId: string;
  serverId: string;
  version: number;
  createdAt: Date;
  intentDigest: string;
  managedFingerprint: string;
  finalOutboundTag: string;
  rules: ManagedIntentRouteRule[];
  ruleSets: ManagedRuleSetBinding[];
  subscriberNodeIds: string[];
}

export interface NetworkingRolloutStageView {
  ordinal: number;
  serverId: string;
  serverName: string;
  status: string;
  deadlineAt: Date | null;
  probeLinkId: string | null;
}

export interface NetworkingRolloutView {
  rolloutId: string;
  status: string;
  lastConfirmedOrdinal: number;
  stages: NetworkingRolloutStageView[];
  actions: { retry: boolean; abort: boolean };
  claimsHeld: boolean;
  claimedServerIds: string[];
  paused: boolean;
  failureCode: string | null;
  updatedAt: Date;
  createdAt: Date;
}

export interface NetworkingWorkspaceData {
  servers: NetworkingServerView[];
  nodes: NetworkingNodeView[];
  peerInbounds: NetworkingPeerInboundView[];
  links: NetworkingLinkView[];
  outbounds: NetworkingOutboundView[];
  ruleSets: NetworkingRuleSetAssetView[];
  routingDrafts: NetworkingRoutingDraftView[];
  rollouts: NetworkingRolloutView[];
  topologyGeneration: number;
  activationEnabled: boolean;
}

export interface ServerRoutingView {
  server: NetworkingServerView;
  servers: NetworkingServerView[];
  nodes: NetworkingNodeView[];
  peerInbounds: NetworkingPeerInboundView[];
  links: NetworkingLinkView[];
  outbounds: NetworkingOutboundView[];
  ruleSets: NetworkingRuleSetAssetView[];
  routing: NetworkingRoutingDraftView | null;
  topologyGeneration: number;
  activationEnabled: boolean;
  inbounds: RoutingInboundOption[];
  outboundOptions: RoutingOutboundOption[];
  ruleSetOptions: RoutingRuleSetOption[];
  rollouts: NetworkingRolloutView[];
  managedState: {
    desiredConfigVersionId: string | null;
    appliedConfigVersionId: string | null;
    desiredManagedFingerprint: string | null;
    appliedManagedFingerprint: string | null;
  } | null;
}

interface DraftRow {
  id: string;
  serverId: string;
  version: number;
  intent: ManagedStageIntent;
  intentDigest: string;
  subscriberNodeIds: string[];
  createdAt: Date;
}

interface CertificateView {
  id: string;
  name: string;
  kind: string;
  activeGeneration: number | null;
  fingerprint: string | null;
}

interface RuleSetAssetMeta {
  ruleSetId: string;
  version: string;
  format: "binary";
  source: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
}

interface LinkSourceRow {
  link: typeof peerLink.$inferSelect;
  inbound: typeof peerInbound.$inferSelect;
  sourceServerName: string;
  destinationServerName: string;
  certificate: CertificateView | null;
  outbound: typeof managedOutbound.$inferSelect;
  credentialGeneration: number | null;
  credentialRevision: number;
  /** Active and retiring generations a receiver may still admit. */
  credentialGenerations: number[];
}

function sha256Digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

async function readTopologyGeneration(database: Database): Promise<number> {
  const [row] = await database
    .select({ generation: managedTopology.generation })
    .from(managedTopology)
    .where(eq(managedTopology.id, MANAGED_TOPOLOGY_ID));
  return row?.generation ?? 0;
}

function parseIntent(row: typeof managedConfigVersion.$inferSelect): {
  intent: ManagedStageIntent | null;
  issues: NetworkingIssue[];
} {
  const parsed = managedStageIntentSchema.safeParse(row.intent);
  if (!parsed.success) {
    return {
      intent: null,
      issues: [
        {
          code: "stale_topology",
          params: { version: row.version },
          subjectId: row.id,
        },
      ],
    };
  }
  return { intent: parsed.data, issues: [] };
}

async function loadLatestDrafts(
  database: Database,
): Promise<Map<string, DraftRow>> {
  const rows = await database
    .select()
    .from(managedConfigVersion)
    .orderBy(
      asc(managedConfigVersion.serverId),
      desc(managedConfigVersion.version),
      desc(managedConfigVersion.createdAt),
    );
  const latest = new Map<string, DraftRow>();
  for (const row of rows) {
    if (latest.has(row.serverId)) continue;
    const parsed = parseIntent(row);
    if (!parsed.intent) continue;
    latest.set(row.serverId, {
      id: row.id,
      serverId: row.serverId,
      version: row.version,
      intent: parsed.intent,
      intentDigest: row.intentDigest,
      subscriberNodeIds: row.subscriberNodeIds,
      createdAt: row.createdAt,
    });
  }
  return latest;
}

async function loadServers(
  database: Database,
): Promise<NetworkingServerView[]> {
  const rows = await database
    .select({
      server,
      managed: managedServerState,
    })
    .from(server)
    .leftJoin(managedServerState, eq(managedServerState.serverId, server.id))
    .orderBy(asc(server.name), asc(server.id));
  return rows.map(({ server: row, managed }) => ({
    id: row.id,
    name: row.name,
    address: row.address,
    enabled: row.enabled,
    lastSeenAt: row.lastSeenAt,
    runtimeState: row.runtimeState,
    configState: row.configState,
    appliedRevision: row.appliedRevision,
    desiredRevisionSeq: row.desiredRevisionSeq,
    appliedRevisionSeq: row.appliedRevisionSeq,
    desiredConfigVersionId: managed?.desiredConfigVersionId ?? null,
    appliedConfigVersionId: managed?.appliedConfigVersionId ?? null,
    desiredManagedFingerprint: managed?.desiredManagedFingerprint ?? null,
  }));
}

async function loadNodes(database: Database): Promise<NetworkingNodeView[]> {
  const rows = await database
    .select({
      id: node.id,
      serverId: node.serverId,
      name: node.name,
      enabled: node.enabled,
      protocol: node.protocol,
      listenPort: node.listenPort,
      certificateId: node.certificateId,
      tlsServerName: node.tlsServerName,
      settings: node.settings,
    })
    .from(node)
    .orderBy(asc(node.name), asc(node.id));
  return rows;
}

async function loadCertificates(
  database: Database,
  certificateIds: readonly string[],
): Promise<Map<string, CertificateView>> {
  const unique = [...new Set(certificateIds)];
  if (unique.length === 0) return new Map();
  const rows = await database
    .select({
      id: managedCertificate.id,
      name: managedCertificate.name,
      kind: managedCertificate.kind,
      activeMaterialVersion: managedCertificate.activeMaterialVersion,
      materialVersion: certificateMaterial.version,
      fingerprint: certificateMaterial.fingerprintSha256,
    })
    .from(managedCertificate)
    .leftJoin(
      certificateMaterial,
      and(
        eq(certificateMaterial.certificateId, managedCertificate.id),
        eq(
          certificateMaterial.version,
          managedCertificate.activeMaterialVersion,
        ),
      ),
    )
    .where(inArray(managedCertificate.id, unique));
  const map = new Map<string, CertificateView>();
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      name: row.name,
      kind: row.kind,
      activeGeneration:
        row.activeMaterialVersion ?? row.materialVersion ?? null,
      fingerprint: row.fingerprint ?? null,
    });
  }
  return map;
}

async function loadPeerInbounds(
  database: Database,
  serverId?: string,
): Promise<NetworkingPeerInboundView[]> {
  const rows = await database
    .select({
      inbound: peerInbound,
      certificateId: managedCertificate.id,
      certificateName: managedCertificate.name,
      certificateKind: managedCertificate.kind,
      certificateGeneration: managedCertificate.activeMaterialVersion,
      materialVersion: certificateMaterial.version,
      fingerprint: certificateMaterial.fingerprintSha256,
    })
    .from(peerInbound)
    .leftJoin(
      managedCertificate,
      eq(managedCertificate.id, peerInbound.certificateId),
    )
    .leftJoin(
      certificateMaterial,
      and(
        eq(certificateMaterial.certificateId, managedCertificate.id),
        eq(
          certificateMaterial.version,
          managedCertificate.activeMaterialVersion,
        ),
      ),
    )
    .where(serverId ? eq(peerInbound.serverId, serverId) : sql`TRUE`)
    .orderBy(asc(peerInbound.name), asc(peerInbound.id));
  return rows.map((row) => ({
    id: row.inbound.id,
    serverId: row.inbound.serverId,
    name: row.inbound.name,
    runtimeTag: row.inbound.runtimeTag,
    protocol: row.inbound.protocol,
    listenAddress: row.inbound.listenAddress,
    listenPort: row.inbound.listenPort,
    advertisedAddress: row.inbound.advertisedAddress,
    advertisedPort: row.inbound.advertisedPort,
    network: row.inbound.network,
    tlsServerName: row.inbound.tlsServerName,
    certificateId: row.inbound.certificateId,
    certificateName: row.certificateName ?? null,
    certificateKind: row.certificateKind ?? null,
    certificateGeneration:
      row.certificateGeneration ?? row.materialVersion ?? null,
    certificateFingerprint: row.fingerprint ?? null,
    settings: row.inbound.settings,
    sourceNodeId: row.inbound.sourceNodeId,
    revision: row.inbound.revision,
    createdAt: row.inbound.createdAt,
    updatedAt: row.inbound.updatedAt,
    linkIds: [],
  }));
}

async function loadCredentialSummaries(
  database: Database,
  linkIds: readonly string[],
): Promise<
  Map<
    string,
    {
      active: number | null;
      max: number;
      revisions: number;
      admissions: number[];
    }
  >
> {
  if (linkIds.length === 0) return new Map();
  const rows = await database
    .select({
      linkId: peerLinkCredential.linkId,
      generation: peerLinkCredential.generation,
      state: peerLinkCredential.state,
    })
    .from(peerLinkCredential)
    .where(inArray(peerLinkCredential.linkId, [...linkIds]))
    .orderBy(
      asc(peerLinkCredential.linkId),
      desc(peerLinkCredential.generation),
    );
  const map = new Map<
    string,
    {
      active: number | null;
      max: number;
      revisions: number;
      admissions: number[];
    }
  >();
  for (const row of rows) {
    const current = map.get(row.linkId) ?? {
      active: null,
      max: 0,
      revisions: 0,
      admissions: [],
    };
    if (row.state === "active" && current.active === null) {
      current.active = row.generation;
    }
    if (row.state !== "retired") {
      current.admissions.push(row.generation);
    }
    current.max = Math.max(current.max, row.generation);
    current.revisions += 1;
    map.set(row.linkId, current);
  }
  return map;
}

async function loadLinkSources(
  database: Database,
  serverId?: string,
): Promise<LinkSourceRow[]> {
  const rows = await database
    .select({
      link: peerLink,
      inbound: peerInbound,
      source: server,
      outbound: managedOutbound,
    })
    .from(peerLink)
    .innerJoin(peerInbound, eq(peerInbound.id, peerLink.destinationInboundId))
    .innerJoin(server, eq(server.id, peerLink.sourceServerId))
    .innerJoin(managedOutbound, eq(managedOutbound.linkId, peerLink.id))
    .where(serverId ? eq(peerLink.sourceServerId, serverId) : sql`TRUE`)
    .orderBy(asc(peerLink.id));
  const destinationServers =
    rows.length === 0
      ? []
      : await database
          .select({ id: server.id, name: server.name })
          .from(server)
          .where(
            inArray(server.id, [
              ...new Set(rows.map((row) => row.inbound.serverId)),
            ]),
          );
  const destinationNames = new Map(
    destinationServers.map((row) => [row.id, row.name]),
  );
  const certificateIds = rows
    .map((row) => row.inbound.certificateId)
    .filter((id): id is string => id !== null);
  const [certificates, credentials] = await Promise.all([
    loadCertificates(database, certificateIds),
    loadCredentialSummaries(
      database,
      rows.map((row) => row.link.id),
    ),
  ]);
  return rows.map((row) => {
    const summary = credentials.get(row.link.id);
    return {
      link: row.link,
      inbound: row.inbound,
      sourceServerName: row.source.name,
      destinationServerName:
        destinationNames.get(row.inbound.serverId) ?? row.inbound.serverId,
      certificate: row.inbound.certificateId
        ? (certificates.get(row.inbound.certificateId) ?? null)
        : null,
      outbound: row.outbound,
      credentialGeneration: summary?.active ?? null,
      credentialRevision: summary?.revisions ?? 0,
      credentialGenerations: summary?.admissions ?? [],
    };
  });
}

async function loadOutbounds(
  database: Database,
  serverId: string,
  routeRules: readonly ManagedIntentRouteRule[],
): Promise<NetworkingOutboundView[]> {
  const [rows, links] = await Promise.all([
    database
      .select()
      .from(managedOutbound)
      .where(eq(managedOutbound.serverId, serverId))
      .orderBy(asc(managedOutbound.name), asc(managedOutbound.id)),
    database
      .select({ id: peerLink.id })
      .from(peerLink)
      .where(eq(peerLink.sourceServerId, serverId)),
  ]);
  const references = outboundRouteReferences(routeRules);
  const result: NetworkingOutboundView[] = [
    {
      id: null,
      serverId,
      kind: "builtin_direct",
      name: "direct",
      runtimeTag: "direct",
      linkId: null,
      revision: 1,
      ipFamily: null,
      bindInterface: null,
      routeRuleIds: (references.get("direct") ?? []).map((ref) => ref.ruleId),
    },
  ];
  const linkById = new Map(links.map((link) => [link.id, link]));
  for (const row of rows) {
    const options = row.dialOptions as Record<string, unknown>;
    result.push({
      id: row.id,
      serverId: row.serverId,
      kind: row.kind,
      name: row.name,
      runtimeTag: row.runtimeTag,
      linkId: row.linkId,
      protocol: row.protocol,
      settings: row.settings,
      memberOutboundTags: row.memberOutboundTags,
      revision: row.revision,
      ipFamily:
        options.inet6 === false
          ? "ipv4"
          : options.inet4 === false
            ? "ipv6"
            : "any",
      bindInterface:
        typeof options.bind_interface === "string"
          ? options.bind_interface
          : null,
      routeRuleIds: (references.get(row.runtimeTag) ?? []).map(
        (ref) => ref.ruleId,
      ),
    });
    if (row.kind === "peer_link" && row.linkId && !linkById.has(row.linkId)) {
      throw new Error("managed outbound references a missing link");
    }
  }
  return result;
}

async function loadRuleSets(
  database: Database,
  drafts: ReadonlyMap<string, DraftRow>,
): Promise<NetworkingRuleSetAssetView[]> {
  const rows: RuleSetAssetMeta[] = await database
    .select({
      ruleSetId: managedRuleSetAsset.ruleSetId,
      version: managedRuleSetAsset.version,
      format: managedRuleSetAsset.format,
      source: managedRuleSetAsset.source,
      sizeBytes: managedRuleSetAsset.sizeBytes,
      sha256: managedRuleSetAsset.sha256,
      createdAt: managedRuleSetAsset.createdAt,
    })
    .from(managedRuleSetAsset)
    .orderBy(
      asc(managedRuleSetAsset.ruleSetId),
      desc(managedRuleSetAsset.createdAt),
      desc(managedRuleSetAsset.version),
    );
  const used = new Map<string, Set<string>>();
  for (const draft of drafts.values()) {
    for (const binding of draft.intent.ruleSets) {
      const key = `${binding.ruleSetId}:${binding.version}`;
      const set = used.get(key) ?? new Set<string>();
      set.add(draft.serverId);
      used.set(key, set);
    }
  }
  return rows.map((row) => ({
    ruleSetId: row.ruleSetId,
    version: row.version,
    format: row.format,
    source: row.source,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    createdAt: row.createdAt,
    usedByServerIds: [...(used.get(`${row.ruleSetId}:${row.version}`) ?? [])],
  }));
}

function draftToView(row: DraftRow): NetworkingRoutingDraftView {
  return {
    configVersionId: row.id,
    serverId: row.serverId,
    version: row.version,
    createdAt: row.createdAt,
    intentDigest: row.intentDigest,
    managedFingerprint: computeManagedStateFingerprint(row.intent),
    finalOutboundTag: row.intent.routingPolicy.finalOutboundTag,
    rules: row.intent.routingPolicy.rules,
    ruleSets: row.intent.ruleSets,
    subscriberNodeIds: row.subscriberNodeIds,
  };
}

function linkPhaseFor(
  link: typeof peerLink.$inferSelect,
  rollouts: readonly {
    rollout: { state: string };
    view: ManagedRolloutDetail["view"];
    rawStages: (typeof import("@/db/managed-network-schema"))["managedRolloutStage"]["$inferSelect"][];
  }[],
  probes: readonly {
    linkId: string;
    outcome: string | null;
    completedAt: Date | null;
    issuedAt: Date;
  }[],
  destinationServerId: string,
): {
  phase: NetworkingLinkView["phase"];
  health: NetworkingLinkView["health"];
  probeOutcome: string | null;
  probeAt: Date | null;
} {
  const probe = probes.find((row) => row.linkId === link.id);
  const health: NetworkingLinkView["health"] = !probe
    ? "unknown"
    : probe.outcome === "succeeded"
      ? "healthy"
      : probe.outcome === null
        ? "unknown"
        : "degraded";
  const probeOutcome = probe?.outcome ?? null;
  const probeAt = probe ? (probe.completedAt ?? probe.issuedAt) : null;

  for (const rollout of rollouts) {
    const stages = rollout.view.stages;
    const sourceStage = stages.find(
      (stage) => stage.serverId === link.sourceServerId,
    );
    const destinationStage = stages.find(
      (stage) => stage.serverId === destinationServerId,
    );
    if (!sourceStage && !destinationStage) continue;
    const sourceStatus = sourceStage?.status;
    const destinationStatus = destinationStage?.status;
    if (sourceStatus === "recovering" || destinationStatus === "recovering") {
      return { phase: "removing", health, probeOutcome, probeAt };
    }
    if (sourceStatus === "probe_failed") {
      return { phase: "failed", health, probeOutcome, probeAt };
    }
    if (sourceStatus === "stalled" || destinationStatus === "stalled") {
      return { phase: "stalled", health, probeOutcome, probeAt };
    }
    if (
      sourceStatus === "awaiting_proof" ||
      sourceStatus === "awaiting_probe" ||
      sourceStatus === "pending" ||
      destinationStatus === "awaiting_proof" ||
      destinationStatus === "pending"
    ) {
      return { phase: "applying", health, probeOutcome, probeAt };
    }
    if (
      sourceStatus === "confirmed" &&
      (destinationStatus === "confirmed" || destinationStage === undefined)
    ) {
      return { phase: "applied", health, probeOutcome, probeAt };
    }
    if (sourceStatus === "confirmed") {
      return { phase: "applying", health, probeOutcome, probeAt };
    }
  }
  return { phase: "draft", health, probeOutcome, probeAt };
}

export async function readNetworkingWorkspace(
  database: Database = db,
  activationEnabled: boolean,
): Promise<NetworkingWorkspaceData> {
  const [servers, nodes, peerInbounds, drafts, generation] = await Promise.all([
    loadServers(database),
    loadNodes(database),
    loadPeerInbounds(database),
    loadLatestDrafts(database),
    readTopologyGeneration(database),
  ]);
  const links = await loadLinkSources(database);
  const linkIds = links.map((row) => row.link.id);
  const [credentials, ruleSets, rolloutDetails] = await Promise.all([
    loadCredentialSummaries(database, linkIds),
    loadRuleSets(database, drafts),
    listManagedRolloutDetails({ limit: 20 }, new Date(), database),
  ]);
  const rollouts = await Promise.all(
    rolloutDetails.map(async (detail) => {
      const snapshot = await readManagedRolloutSnapshot(
        detail.rolloutId,
        database,
      );
      const probes = await listManagedLinkProbes(detail.rolloutId, database);
      const serverNames = new Map(servers.map((row) => [row.id, row.name]));
      return {
        detail,
        snapshot,
        probes,
        serverNames,
      };
    }),
  );

  const linksView: NetworkingLinkView[] = links.map((row) => {
    const summary = credentials.get(row.link.id);
    const detail = rollouts
      .filter(({ snapshot }) => snapshot !== null)
      .map(({ detail, snapshot, probes }) => ({
        rollout: snapshot!.rollout,
        view: detail.view,
        rawStages: snapshot!.rawStages,
        probes,
      }));
    const destinationServerId = row.inbound.serverId;
    const probeRows = rollouts
      .flatMap(({ probes }) => probes)
      .filter((probe) => probe.linkId === row.link.id)
      .sort(
        (a, b) =>
          b.issuedAt.getTime() - a.issuedAt.getTime() ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
    const phase = linkPhaseFor(
      row.link,
      detail,
      probeRows,
      destinationServerId,
    );
    const routeRules = drafts.get(row.link.sourceServerId)?.intent.routingPolicy
      .rules;
    const references = routeRules
      ? (outboundRouteReferences(routeRules).get(row.outbound.runtimeTag) ?? [])
      : [];
    return {
      id: row.link.id,
      sourceServerId: row.link.sourceServerId,
      sourceServerName: row.sourceServerName,
      destinationInboundId: row.link.destinationInboundId,
      destinationInboundName: row.inbound.name,
      destinationServerId,
      destinationServerName: row.destinationServerName,
      protocol: row.inbound.protocol,
      revision: row.link.revision,
      outboundId: row.outbound.id,
      outboundName: row.outbound.name,
      outboundTag: row.outbound.runtimeTag,
      credentialGeneration: summary?.active ?? row.credentialGeneration,
      credentialRevision: summary?.revisions ?? row.credentialRevision,
      phase: phase.phase,
      health: phase.health,
      routeRuleIds: references.map((ref) => ref.ruleId),
      probeOutcome: phase.probeOutcome,
      probeAt: phase.probeAt,
      createdAt: row.link.createdAt,
      updatedAt: row.link.updatedAt,
    };
  });

  const peerInboundLinks = new Map<string, string[]>();
  for (const link of linksView) {
    const rows = peerInboundLinks.get(link.destinationInboundId) ?? [];
    rows.push(link.id);
    peerInboundLinks.set(link.destinationInboundId, rows);
  }
  for (const inbound of peerInbounds) {
    inbound.linkIds = peerInboundLinks.get(inbound.id) ?? [];
  }

  const outbounds = await Promise.all(
    servers.map((row) =>
      loadOutbounds(
        database,
        row.id,
        drafts.get(row.id)?.intent.routingPolicy.rules ?? [],
      ),
    ),
  );

  return {
    servers,
    nodes,
    peerInbounds,
    links: linksView,
    outbounds: outbounds.flat(),
    ruleSets,
    routingDrafts: [...drafts.values()].map(draftToView),
    rollouts: rollouts.map(({ detail, snapshot, serverNames }) => ({
      rolloutId: detail.rolloutId,
      status: detail.view.status,
      lastConfirmedOrdinal: detail.view.lastConfirmedOrdinal,
      stages: detail.view.stages.map((stage) => ({
        ordinal: stage.ordinal,
        serverId: stage.serverId,
        serverName: serverNames.get(stage.serverId) ?? stage.serverId,
        status: stage.status,
        deadlineAt: stage.deadlineAt,
        probeLinkId:
          snapshot?.rawStages.find((row) => row.ordinal === stage.ordinal)
            ?.probeLinkId ?? null,
      })),
      actions: detail.view.actions,
      claimsHeld: detail.view.claimsHeld,
      claimedServerIds: detail.claimedServerIds,
      paused: detail.paused,
      failureCode: snapshot?.rollout.failureCode ?? null,
      updatedAt: snapshot?.rollout.updatedAt ?? new Date(0),
      createdAt: snapshot?.rollout.createdAt ?? new Date(0),
    })),
    topologyGeneration: generation,
    activationEnabled,
  };
}

export interface RoutingContextData {
  server: NetworkingServerView;
  servers: NetworkingServerView[];
  nodes: NetworkingNodeView[];
  peerInbounds: NetworkingPeerInboundView[];
  links: NetworkingLinkView[];
  outbounds: NetworkingOutboundView[];
  ruleSets: NetworkingRuleSetAssetView[];
  routing: NetworkingRoutingDraftView | null;
  topologyGeneration: number;
  activationEnabled: boolean;
  rollouts: NetworkingRolloutView[];
  managedState: ServerRoutingView["managedState"];
  routes: {
    sourceLinks: LinkSourceRow[];
    destinationLinks: LinkSourceRow[];
  };
  certificates: Map<string, CertificateView>;
  assets: Map<string, RuleSetAssetMeta>;
  previousIntent: ManagedStageIntent | null;
}

async function loadServerRoutingContext(
  serverId: string,
  database: Database,
  activationEnabled: boolean,
): Promise<RoutingContextData> {
  const [servers, nodes, peerInbounds, drafts, generation, managedStateRows] =
    await Promise.all([
      loadServers(database),
      loadNodes(database),
      loadPeerInbounds(database),
      loadLatestDrafts(database),
      readTopologyGeneration(database),
      database
        .select()
        .from(managedServerState)
        .where(eq(managedServerState.serverId, serverId)),
    ]);
  const serverRow = servers.find((row) => row.id === serverId);
  if (!serverRow) throw new Error("Not found");

  const sourceLinks = await loadLinkSources(database, serverId);
  const destinationRows = await database
    .select({
      link: peerLink,
      inbound: peerInbound,
      source: server,
      outbound: managedOutbound,
    })
    .from(peerLink)
    .innerJoin(peerInbound, eq(peerInbound.id, peerLink.destinationInboundId))
    .innerJoin(server, eq(server.id, peerLink.sourceServerId))
    .innerJoin(managedOutbound, eq(managedOutbound.linkId, peerLink.id))
    .where(eq(peerInbound.serverId, serverId))
    .orderBy(asc(peerLink.id));

  const linkIds = [
    ...new Set([
      ...sourceLinks.map((row) => row.link.id),
      ...destinationRows.map((row) => row.link.id),
    ]),
  ];
  const credentials = await loadCredentialSummaries(database, linkIds);
  const certificateIds = [
    ...peerInbounds
      .filter((row) => row.serverId === serverId)
      .map((row) => row.certificateId),
    ...sourceLinks.map((row) => row.inbound.certificateId),
  ].filter((id): id is string => id !== null);
  const certificates = await loadCertificates(database, certificateIds);
  const assetsRows: RuleSetAssetMeta[] = await database
    .select({
      ruleSetId: managedRuleSetAsset.ruleSetId,
      version: managedRuleSetAsset.version,
      format: managedRuleSetAsset.format,
      source: managedRuleSetAsset.source,
      sizeBytes: managedRuleSetAsset.sizeBytes,
      sha256: managedRuleSetAsset.sha256,
      createdAt: managedRuleSetAsset.createdAt,
    })
    .from(managedRuleSetAsset)
    .orderBy(
      asc(managedRuleSetAsset.ruleSetId),
      desc(managedRuleSetAsset.createdAt),
      desc(managedRuleSetAsset.version),
    );
  const assets = new Map(
    assetsRows.map((row) => [`${row.ruleSetId}:${row.version}`, row]),
  );

  const routingDraft = drafts.get(serverId) ?? null;
  const destinationLinks = destinationRows.map((row) => {
    const summary = credentials.get(row.link.id);
    return {
      link: row.link,
      inbound: row.inbound,
      sourceServerName: row.source.name,
      destinationServerName: serverRow.name,
      certificate: row.inbound.certificateId
        ? (certificates.get(row.inbound.certificateId) ?? null)
        : null,
      outbound: row.outbound,
      credentialGeneration: summary?.active ?? null,
      credentialRevision: summary?.revisions ?? 0,
      credentialGenerations: summary?.admissions ?? [],
    } satisfies LinkSourceRow;
  });
  const rollouts = await readServerRollouts(database, serverId, servers);
  const linkViews = linkViewsForServer(
    sourceLinks,
    routingDraft?.intent.routingPolicy.rules ?? [],
    rollouts,
  );

  const outbounds = await loadOutbounds(
    database,
    serverId,
    routingDraft?.intent.routingPolicy.rules ?? [],
  );
  const ruleSetView = await loadRuleSets(database, drafts);
  const managedState = managedStateRows[0]
    ? {
        desiredConfigVersionId:
          managedStateRows[0].desiredConfigVersionId ?? null,
        appliedConfigVersionId:
          managedStateRows[0].appliedConfigVersionId ?? null,
        desiredManagedFingerprint:
          managedStateRows[0].desiredManagedFingerprint ?? null,
        appliedManagedFingerprint:
          managedStateRows[0].appliedManagedFingerprint ?? null,
      }
    : null;
  return {
    server: serverRow,
    servers,
    nodes: nodes.filter((row) => row.serverId === serverId),
    peerInbounds: peerInbounds.filter((row) => row.serverId === serverId),
    links: linkViews,
    outbounds,
    ruleSets: ruleSetView,
    routing: routingDraft ? draftToView(routingDraft) : null,
    topologyGeneration: generation,
    activationEnabled,
    rollouts,
    managedState,
    routes: {
      sourceLinks,
      destinationLinks,
    },
    certificates,
    assets,
    previousIntent: routingDraft?.intent ?? null,
  };
}

function linkStatusFromRollouts(
  linkId: string,
  sourceServerId: string,
  destinationServerId: string,
  rollouts: readonly NetworkingRolloutView[],
): NetworkingLinkView["phase"] {
  for (const rollout of rollouts) {
    const sourceStage = rollout.stages.find(
      (stage) => stage.serverId === sourceServerId,
    );
    const destinationStage = rollout.stages.find(
      (stage) => stage.serverId === destinationServerId,
    );
    const linkedStage = rollout.stages.find(
      (stage) => stage.probeLinkId === linkId,
    );
    if (!sourceStage && !destinationStage && !linkedStage) continue;
    const statuses = [sourceStage?.status, destinationStage?.status].filter(
      Boolean,
    );
    if (statuses.includes("recovering")) return "removing";
    if (sourceStage?.status === "probe_failed") return "failed";
    if (statuses.includes("stalled")) return "stalled";
    if (
      statuses.includes("pending") ||
      statuses.includes("awaiting_proof") ||
      statuses.includes("awaiting_probe")
    ) {
      return "applying";
    }
    if (
      statuses.includes("confirmed") &&
      sourceStage?.status === "confirmed" &&
      (!destinationStage || destinationStage.status === "confirmed")
    ) {
      return "applied";
    }
    if (sourceStage?.status === "confirmed") return "applying";
  }
  return "draft";
}

function linkViewsForServer(
  sourceLinks: readonly LinkSourceRow[],
  rules: readonly ManagedIntentRouteRule[],
  rollouts: readonly NetworkingRolloutView[],
): NetworkingLinkView[] {
  const references = outboundRouteReferences(rules);
  return sourceLinks.map((row) => ({
    id: row.link.id,
    sourceServerId: row.link.sourceServerId,
    sourceServerName: row.sourceServerName,
    destinationInboundId: row.link.destinationInboundId,
    destinationInboundName: row.inbound.name,
    destinationServerId: row.inbound.serverId,
    destinationServerName: row.destinationServerName,
    protocol: row.inbound.protocol,
    revision: row.link.revision,
    outboundId: row.outbound.id,
    outboundName: row.outbound.name,
    outboundTag: row.outbound.runtimeTag,
    credentialGeneration: row.credentialGeneration,
    credentialRevision: row.credentialRevision,
    phase: linkStatusFromRollouts(
      row.link.id,
      row.link.sourceServerId,
      row.inbound.serverId,
      rollouts,
    ),
    health: "unknown",
    routeRuleIds: (references.get(row.outbound.runtimeTag) ?? []).map(
      (ref) => ref.ruleId,
    ),
    probeOutcome: null,
    probeAt: null,
    createdAt: row.link.createdAt,
    updatedAt: row.link.updatedAt,
  }));
}

async function readServerRollouts(
  database: Database,
  serverId: string,
  servers: readonly NetworkingServerView[],
): Promise<NetworkingRolloutView[]> {
  const details = await listManagedRolloutDetails(
    { serverId, limit: 20 },
    new Date(),
    database,
  );
  const serverNames = new Map(servers.map((row) => [row.id, row.name]));
  return Promise.all(
    details.map(async (detail) => {
      const snapshot = await readManagedRolloutSnapshot(
        detail.rolloutId,
        database,
      );
      return {
        rolloutId: detail.rolloutId,
        status: detail.view.status,
        lastConfirmedOrdinal: detail.view.lastConfirmedOrdinal,
        stages: detail.view.stages.map((stage) => ({
          ordinal: stage.ordinal,
          serverId: stage.serverId,
          serverName: serverNames.get(stage.serverId) ?? stage.serverId,
          status: stage.status,
          deadlineAt: stage.deadlineAt,
          probeLinkId:
            snapshot?.rawStages.find((row) => row.ordinal === stage.ordinal)
              ?.probeLinkId ?? null,
        })),
        actions: detail.view.actions,
        claimsHeld: detail.view.claimsHeld,
        claimedServerIds: detail.claimedServerIds,
        paused: detail.paused,
        failureCode: snapshot?.rollout.failureCode ?? null,
        updatedAt: snapshot?.rollout.updatedAt ?? new Date(0),
        createdAt: snapshot?.rollout.createdAt ?? new Date(0),
      };
    }),
  );
}

function routingOptions(context: RoutingContextData): {
  inbounds: RoutingInboundOption[];
  outboundOptions: RoutingOutboundOption[];
  ruleSetOptions: RoutingRuleSetOption[];
} {
  const inbounds: RoutingInboundOption[] = [
    ...context.nodes.map((row) => ({
      tag: `node-${row.id}`,
      name: row.name,
      protocol: row.protocol,
      peer: false,
      enabled: row.enabled,
    })),
    ...context.peerInbounds.map((row) => ({
      tag: row.runtimeTag,
      name: row.name,
      protocol: row.protocol,
      peer: true,
      enabled: true,
    })),
  ];
  const outboundOptions: RoutingOutboundOption[] = context.outbounds.map(
    (row) => {
      const link = context.links.find(
        (candidate) => candidate.id === row.linkId,
      );
      const destination = link
        ? context.peerInbounds.find(
            (inbound) => inbound.id === link.destinationInboundId,
          )
        : null;
      const destinationServer = link
        ? context.servers.find((s) => s.id === link.destinationServerId)
        : null;
      return {
        tag: row.runtimeTag,
        name: row.name,
        kind:
          row.kind === "builtin_direct"
            ? "builtin_direct"
            : row.kind === "direct_profile"
              ? "direct_profile"
              : "peer_link",
        linkId: row.linkId,
        destinationServerId: link?.destinationServerId ?? null,
        destinationServerName: destinationServer?.name ?? null,
        protocol: destination?.protocol ?? null,
        ipFamily: row.ipFamily as RoutingOutboundOption["ipFamily"],
      };
    },
  );
  const ruleSetOptions: RoutingRuleSetOption[] = context.ruleSets.map(
    (row) => ({
      runtimeTag: managedRuntimeTag("rule_set", row.ruleSetId),
      ruleSetId: row.ruleSetId,
      version: row.version,
      format: row.format,
      sizeBytes: row.sizeBytes,
    }),
  );
  return { inbounds, outboundOptions, ruleSetOptions };
}

export async function readServerRouting(
  serverId: string,
  database: Database = db,
  activationEnabled: boolean,
): Promise<ServerRoutingView> {
  const context = await loadServerRoutingContext(
    serverId,
    database,
    activationEnabled,
  );
  const options = routingOptions(context);
  return {
    server: context.server,
    servers: context.servers,
    nodes: context.nodes,
    peerInbounds: context.peerInbounds,
    links: context.links,
    outbounds: context.outbounds,
    ruleSets: context.ruleSets,
    routing: context.routing,
    topologyGeneration: context.topologyGeneration,
    activationEnabled,
    inbounds: options.inbounds,
    outboundOptions: options.outboundOptions,
    ruleSetOptions: options.ruleSetOptions,
    rollouts: context.rollouts,
    managedState: context.managedState,
  };
}

export interface BuildIntentOptions {
  configVersionId: string;
  version: number;
  topologyGeneration: number;
  rules: readonly ManagedIntentRouteRule[];
  finalOutboundTag: string;
}

export interface IntentBuildResult {
  ok: boolean;
  context: RoutingContextData;
  intent: ManagedStageIntent | null;
  preview: RoutingPreview;
  issues: NetworkingIssue[];
  intentDigest: string | null;
  managedFingerprint: string | null;
}

function latestAssetForRuleSet(
  ruleSetId: string,
  assets: ReadonlyMap<string, RuleSetAssetMeta>,
): RuleSetAssetMeta | null {
  let latest: RuleSetAssetMeta | null = null;
  for (const [key, asset] of assets) {
    if (asset.ruleSetId !== ruleSetId) continue;
    if (
      !latest ||
      asset.createdAt.getTime() > latest.createdAt.getTime() ||
      (asset.createdAt.getTime() === latest.createdAt.getTime() &&
        key.localeCompare(`${latest.ruleSetId}:${latest.version}`) > 0)
    ) {
      latest = asset;
    }
  }
  return latest;
}

function ruleSetIdFromTag(tag: string): string | null {
  return tag.startsWith("rule-set-") ? tag.slice("rule-set-".length) : null;
}

function peerInboundIntentFor(
  inbound: NetworkingPeerInboundView,
  context: RoutingContextData,
): {
  value: ManagedIntentPeerInbound;
  issues: NetworkingIssue[];
} {
  const issues: NetworkingIssue[] = [];
  const certificate = inbound.certificateId
    ? context.certificates.get(inbound.certificateId)
    : undefined;
  if (inbound.certificateId !== null) {
    if (!certificate) {
      issues.push({
        code: "certificate_missing",
        params: { certificate: inbound.certificateId },
        subjectId: inbound.id,
      });
    }
    if (!certificate?.activeGeneration || !certificate.fingerprint) {
      issues.push({
        code: "certificate_material_missing",
        params: { certificate: inbound.certificateId },
        subjectId: inbound.id,
      });
    }
  }
  const admissions = context.routes.destinationLinks
    .filter((row) => row.inbound.id === inbound.id)
    .flatMap((row) => {
      if (row.credentialGenerations.length === 0) {
        issues.push({
          code: "credential_missing",
          params: { link: row.link.id },
          subjectId: row.link.id,
        });
        return [];
      }
      return row.credentialGenerations.map((generation) => ({
        linkId: row.link.id,
        sourceServerId: row.link.sourceServerId,
        credentialGeneration: generation,
      }));
    });
  return {
    value: {
      inboundId: inbound.id,
      runtimeTag: inbound.runtimeTag,
      protocol: inbound.protocol,
      listenAddress: inbound.listenAddress,
      listenPort: inbound.listenPort,
      advertisedAddress: inbound.advertisedAddress,
      advertisedPort: inbound.advertisedPort,
      ...(inbound.network !== "both" ? { network: inbound.network } : {}),
      ...(Object.keys(inbound.settings).length > 0
        ? { settings: inbound.settings }
        : {}),
      tlsServerName: inbound.tlsServerName,
      certificateId: inbound.certificateId,
      certificateGeneration:
        inbound.certificateId === null
          ? null
          : (certificate?.activeGeneration ?? 1),
      certificateFingerprintSha256:
        inbound.certificateId === null
          ? null
          : (certificate?.fingerprint ?? `sha256:${"0".repeat(64)}`),
      admissions,
    },
    issues,
  };
}

function outboundIntentFor(
  row: NetworkingOutboundView,
  context: RoutingContextData,
): { value: ManagedIntentOutbound; issues: NetworkingIssue[] } {
  const issues: NetworkingIssue[] = [];
  if (row.kind === "direct_profile") {
    return {
      value: {
        outboundId: row.id!,
        runtimeTag: row.runtimeTag,
        kind: "direct_profile",
        dialOptions: {
          ...(row.bindInterface ? { bind_interface: row.bindInterface } : {}),
          ...(row.ipFamily === "ipv4"
            ? { inet6: false }
            : row.ipFamily === "ipv6"
              ? { inet4: false }
              : {}),
        },
        linkId: null,
        destinationServerId: null,
        destinationInboundId: null,
        protocol: null,
        serverAddress: null,
        serverPort: null,
        tlsServerName: null,
        credentialGeneration: null,
        trustMode: null,
        trustedCertificates: [],
      },
      issues,
    };
  }
  if (row.kind === "custom_proxy") {
    return {
      value: {
        outboundId: row.id!,
        runtimeTag: row.runtimeTag,
        kind: "custom_proxy",
        dialOptions: {},
        settings: row.settings ?? {},
        supportsUdp: true,
        linkId: null,
        destinationServerId: null,
        destinationInboundId: null,
        protocol: row.protocol ?? null,
        serverAddress: null,
        serverPort: null,
        tlsServerName: null,
        credentialGeneration: null,
        trustMode: null,
        trustedCertificates: [],
      },
      issues,
    };
  }
  if (row.kind === "outbound_group") {
    return {
      value: {
        outboundId: row.id!,
        runtimeTag: row.runtimeTag,
        kind: "outbound_group",
        dialOptions: {},
        settings: row.settings ?? {},
        supportsUdp: true,
        memberOutboundTags: row.memberOutboundTags ?? [],
        linkId: null,
        destinationServerId: null,
        destinationInboundId: null,
        protocol: row.protocol ?? null,
        serverAddress: null,
        serverPort: null,
        tlsServerName: null,
        credentialGeneration: null,
        trustMode: null,
        trustedCertificates: [],
      },
      issues,
    };
  }
  const link = context.links.find((candidate) => candidate.id === row.linkId);
  const source = context.routes.sourceLinks.find(
    (candidate) => candidate.link.id === row.linkId,
  );
  const inbound = source?.inbound ?? null;
  if (!link || !inbound || !source) {
    issues.push({
      code: "link_not_found",
      params: { link: row.linkId ?? "" },
      subjectId: row.id ?? undefined,
    });
    return {
      value: {
        outboundId: row.id!,
        runtimeTag: row.runtimeTag,
        kind: "peer_link",
        dialOptions: {},
        linkId: row.linkId,
        destinationServerId: null,
        destinationInboundId: null,
        protocol: null,
        serverAddress: null,
        serverPort: null,
        tlsServerName: null,
        credentialGeneration: 1,
        trustMode: "system",
        trustedCertificates: [],
      },
      issues,
    };
  }
  const destinationCertificate = inbound.certificateId
    ? (source.certificate ?? context.certificates.get(inbound.certificateId))
    : undefined;
  const credential = source.credentialGeneration;
  if (credential === null) {
    issues.push({
      code: "credential_missing",
      params: { link: link.id },
      subjectId: link.id,
    });
  }
  if (inbound.certificateId !== null && !destinationCertificate) {
    issues.push({
      code: "certificate_missing",
      params: { certificate: inbound.certificateId },
      subjectId: inbound.id,
    });
  }
  const trustMode =
    inbound.certificateId === null
      ? "none"
      : destinationCertificate?.kind === "self_signed"
        ? "managed_certificate"
        : "system";
  const trustedCertificates =
    trustMode === "managed_certificate" &&
    destinationCertificate?.activeGeneration &&
    destinationCertificate.fingerprint
      ? [
          {
            certificateId: destinationCertificate.id,
            generation: destinationCertificate.activeGeneration,
            fingerprintSha256: destinationCertificate.fingerprint,
          },
        ]
      : [];
  return {
    value: {
      outboundId: source.outbound.id,
      runtimeTag: row.runtimeTag,
      kind: "peer_link",
      dialOptions: {},
      linkId: link.id,
      destinationServerId: inbound.serverId,
      destinationInboundId: inbound.id,
      protocol: inbound.protocol,
      ...(Object.keys(inbound.settings).length > 0
        ? { settings: inbound.settings }
        : {}),
      supportsUdp:
        inbound.network !== "tcp" &&
        peerProtocolCapability(inbound.protocol).supportsUdp,
      serverAddress: inbound.advertisedAddress,
      serverPort: inbound.advertisedPort,
      tlsServerName: inbound.tlsServerName,
      credentialGeneration: credential ?? 1,
      trustMode,
      trustedCertificates,
    },
    issues,
  };
}

/**
 * Builds the immutable intent draft for one server from live resources and the
 * supplied routing policy. Missing certificate material or credentials yield a
 * typed issue; the caller must not stage an intent with blocking issues.
 */
export async function buildServerIntent(
  serverId: string,
  options: BuildIntentOptions,
  database: Database = db,
  activationEnabled: boolean,
): Promise<IntentBuildResult> {
  const [context, portForwards] = await Promise.all([
    loadServerRoutingContext(serverId, database, activationEnabled),
    loadServerPortForwards(serverId, database),
  ]);
  const issues: NetworkingIssue[] = [];

  const subscriberInbounds = context.nodes.map((row) => ({
    nodeId: row.id,
    inboundTag: `node-${row.id}`,
    protocol: row.protocol,
    listenPort: row.listenPort,
    tlsServerName: row.tlsServerName,
    certificateId: row.certificateId,
    settingsDigest: sha256Digest({
      id: row.id,
      protocol: row.protocol,
      listenPort: row.listenPort,
      tlsServerName: row.tlsServerName,
      certificateId: row.certificateId,
      settings: row.settings,
    }),
  }));

  const peerInbounds: ManagedIntentPeerInbound[] = [];
  const peerPorts = new Map<number, string>();
  for (const inbound of context.peerInbounds) {
    const built = peerInboundIntentFor(inbound, context);
    peerInbounds.push(built.value);
    issues.push(...built.issues);
    const nodeConflict = context.nodes.find(
      (node) => node.listenPort === inbound.listenPort,
    );
    if (nodeConflict) {
      issues.push({
        code: "peer_port_conflict",
        params: { port: inbound.listenPort, owner: nodeConflict.name },
        subjectId: inbound.id,
      });
    }
    const earlier = peerPorts.get(inbound.listenPort);
    if (earlier) {
      issues.push({
        code: "peer_port_conflict",
        params: { port: inbound.listenPort, owner: earlier },
        subjectId: inbound.id,
      });
    } else {
      peerPorts.set(inbound.listenPort, inbound.id);
    }
  }

  const outbounds: ManagedIntentOutbound[] = [];
  for (const outbound of context.outbounds) {
    if (outbound.kind === "builtin_direct") continue;
    const built = outboundIntentFor(outbound, context);
    outbounds.push(built.value);
    issues.push(...built.issues);
  }

  const ruleSets: ManagedRuleSetBinding[] = [];
  for (const rule of options.rules) {
    for (const tag of rule.ruleSetTags) {
      if (ruleSets.some((binding) => binding.runtimeTag === tag)) continue;
      const ruleSetId = ruleSetIdFromTag(tag);
      if (!ruleSetId) {
        issues.push({ code: "unknown_rule_set", params: { tag } });
        continue;
      }
      const asset = latestAssetForRuleSet(ruleSetId, context.assets);
      if (!asset) {
        issues.push({
          code: "rule_set_not_found",
          params: { ruleSet: ruleSetId },
        });
        continue;
      }
      ruleSets.push({
        runtimeTag: managedRuntimeTag("rule_set", ruleSetId),
        ruleSetId,
        version: asset.version,
        format: asset.format,
        sha256: asset.sha256,
        sizeBytes: asset.sizeBytes,
      });
    }
  }

  const previewOptions = routingOptions(context);
  const preview = buildRoutingPreview({
    rules: options.rules,
    finalOutboundTag: options.finalOutboundTag,
    inbounds: previewOptions.inbounds,
    outbounds: previewOptions.outboundOptions,
    ruleSets: previewOptions.ruleSetOptions,
  });
  issues.push(...preview.issues);

  const previous = context.previousIntent;
  const previousTags = previous
    ? [
        ...previous.peerInbounds
          .filter((peer) => peer.admissions.length > 0)
          .map((peer) => peer.runtimeTag),
        ...(previous.portForwards ?? []).map((pf) => pf.runtimeTag),
        ...previous.outbounds.map((outbound) => outbound.runtimeTag),
        ...previous.ruleSets.map((binding) => binding.runtimeTag),
      ]
    : [];
  const requiredRuntimeTags = [
    ...peerInbounds
      .filter((peer) => peer.admissions.length > 0)
      .map((peer) => peer.runtimeTag),
    ...portForwards.map((pf) => pf.runtimeTag),
    ...outbounds.map((outbound) => outbound.runtimeTag),
    ...ruleSets.map((binding) => binding.runtimeTag),
  ].sort();
  const removedRuntimeTags = previousTags
    .filter((tag) => !requiredRuntimeTags.includes(tag))
    .sort();

  const rawIntent: ManagedStageIntent = {
    schemaVersion: MANAGED_STAGE_INTENT_SCHEMA_VERSION,
    configVersionId: options.configVersionId,
    serverId,
    version: options.version,
    topologyGeneration: options.topologyGeneration,
    subscriberInbounds,
    peerInbounds,
    ...(portForwards.length > 0 ? { portForwards } : {}),
    outbounds,
    routingPolicy: {
      rules: [...options.rules],
      finalOutboundTag: options.finalOutboundTag,
    },
    ruleSets,
    stageExpectations: { requiredRuntimeTags, removedRuntimeTags },
  };
  const parsed = managedStageIntentSchema.safeParse(rawIntent);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code: "stale_topology",
        params: { path: issue.path.join(".") },
      });
    }
    return {
      ok: false,
      context,
      intent: null,
      preview,
      issues,
      intentDigest: null,
      managedFingerprint: null,
    };
  }
  const intent = parsed.data;
  const intentDigest = computeManagedStageIntentDigest(intent);
  const managedFingerprint = computeManagedStateFingerprint(intent);
  return {
    ok: !issues.some(isBlockingIssue),
    context,
    intent,
    preview,
    issues,
    intentDigest,
    managedFingerprint,
  };
}

function isBlockingIssue(issue: NetworkingIssue): boolean {
  return new Set([
    "certificate_missing",
    "certificate_material_missing",
    "certificate_generation_missing",
    "credential_missing",
    "empty_rule_scope",
    "final_outbound_is_peer",
    "inbound_not_found",
    "link_not_found",
    "outbound_not_found",
    "peer_port_conflict",
    "rule_set_not_found",
    "udp_peer_route",
    "unknown_final_outbound",
    "unknown_rule_set",
    "stale_topology",
  ]).has(issue.code);
}

export async function nextConfigVersion(
  serverId: string,
  database: Database = db,
): Promise<number> {
  const [row] = await database
    .select({ version: managedConfigVersion.version })
    .from(managedConfigVersion)
    .where(eq(managedConfigVersion.serverId, serverId))
    .orderBy(desc(managedConfigVersion.version))
    .limit(1);
  return (row?.version ?? 0) + 1;
}
